import * as core from '@actions/core'
import * as exec from '@actions/exec'

interface Job {
  id: string
  app: string
  status: 'queued' | 'running' | 'success' | 'failed'
  image_tag: string
  error?: string
  created_at: string
  updated_at: string
}

const TERMINAL_STATES = new Set(['success', 'failed'])

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  backoffMs = 1000,
): Promise<Response> {
  let lastError: Error | undefined
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, options)
    }
    catch (err) {
      lastError = err as Error
      if (i < retries - 1)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
  throw lastError
}

/**
 * Stream logs from a running job to CI output.
 *
 * Phase 1: Connect to SSE endpoint and print log lines as they arrive.
 * The server uses createReadStream which closes at current EOF — not a live tail.
 * So Phase 1 may end naturally while the job is still running.
 *
 * Phase 2 wait: Block until poll signals terminal state (via abort).
 * Required regardless of how Phase 1 ended — the job may still be running
 * when Phase 1's createReadStream reaches current EOF.
 *
 * Phase 2 catchup: Re-fetch the complete log and print any lines missed
 * after Phase 1 closed. Skips lines already shown (by count — log file is
 * append-only so position is a safe dedup key). Aborts after 10 s of no
 * new data (job is done, file drains quickly).
 */
async function streamLogs(
  baseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  let linesShown = 0

  // Phase 1 — live stream (reads existing log content, closes at current EOF)
  try {
    const res = await fetch(`${baseUrl}/jobs/${jobId}/logs`, {
      headers,
      signal,
    })

    if (res.ok && res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done)
            break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              core.info(line.slice(6).replace(/\r$/, ''))
              linesShown++
            }
          }
        }
      }
      finally {
        reader.cancel().catch(() => {})
      }
      // Natural EOF reached — do NOT return here.
      // createReadStream closes at current file EOF even if the job is still running.
      // Fall through to Phase 2 wait to pick up any subsequent log lines.
    }
    else {
      // 404 means log file not yet created (job still queued). Phase 2 will catch up.
      core.debug(`SSE stream returned ${res.status}`)
    }
  }
  catch (err) {
    // AbortError = poll signalled terminal state; fall through to Phase 2 catchup.
    // Any other error: warn and fall through — never fail the action on log streaming.
    if ((err as Error).name !== 'AbortError')
      core.warning(`SSE stream error: ${(err as Error).message}`)
  }

  // Phase 2 wait — block until poll signals terminal state via AbortController.
  // This ensures the log file is fully written before we attempt the catchup fetch.
  if (!signal.aborted) {
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  // Phase 2 catchup — re-fetch the complete log, skip lines already shown.
  const catchupController = new AbortController()
  let noDataTimeout = setTimeout(() => catchupController.abort(), 10_000)

  try {
    const res = await fetch(`${baseUrl}/jobs/${jobId}/logs`, {
      headers,
      signal: catchupController.signal,
    })

    if (!res.ok || !res.body) {
      // Job may have failed before the log file was created (e.g. config error on queued job).
      core.debug(`Catchup fetch returned ${res.status}`)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lineIndex = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        // Reset the no-data timeout on each chunk received.
        clearTimeout(noDataTimeout)
        noDataTimeout = setTimeout(() => catchupController.abort(), 10_000)
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            if (lineIndex >= linesShown)
              core.info(line.slice(6).replace(/\r$/, ''))
            lineIndex++
          }
        }
      }
    }
    finally {
      reader.cancel().catch(() => {})
    }
  }
  catch (err) {
    if ((err as Error).name !== 'AbortError')
      core.warning(`Catchup fetch error: ${(err as Error).message}`)
  }
  finally {
    clearTimeout(noDataTimeout)
  }
}

/**
 * Poll GET /jobs/:id until the job reaches a terminal state or the deadline is exceeded.
 * Logs status transitions so queued/running state is visible in CI.
 * Retries transient HTTP errors (3x, 1 s backoff) to survive brief server restarts
 * (e.g. rollhook itself being rolled out).
 */
async function pollUntilDone(
  baseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  timeoutMs: number,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  let lastStatus: string | null = null

  while (true) {
    let job: Job | undefined

    try {
      const res = await fetchWithRetry(`${baseUrl}/jobs/${jobId}`, { headers }, 3, 1000)
      if (!res.ok)
        throw new Error(`GET /jobs/${jobId} returned ${res.status}`)
      job = await res.json() as Job
    }
    catch (err) {
      core.warning(`Poll error: ${(err as Error).message}`)
    }

    if (job) {
      if (job.status !== lastStatus) {
        lastStatus = job.status
        if (job.status === 'queued')
          core.info('Waiting in queue...')
        else if (job.status === 'running')
          core.info('Deployment running...')
      }
      if (TERMINAL_STATES.has(job.status))
        return job
    }

    if (Date.now() > deadline)
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)

    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

async function run(): Promise<void> {
  const rawUrl = core.getInput('url', { required: true }).trim()
  const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).origin
  const registryHost = url.replace(/^https?:\/\//, '')
  const imageName = core.getInput('image_name', { required: true })
  const dockerfile = core.getInput('dockerfile') || 'Dockerfile'
  const buildContext = core.getInput('context') || '.'
  const sha = process.env.GITHUB_SHA ?? 'latest'
  const imageTag = `${registryHost}/${imageName}:${sha}`
  const timeoutMs = (Number.parseInt(core.getInput('timeout') || '600', 10) || 600) * 1000

  // 1. Get OIDC token — audience is the RollHook server URL so the server can verify it.
  // Requires `permissions: id-token: write` in the calling workflow.
  let oidcToken: string
  try {
    oidcToken = await core.getIDToken(url)
  }
  catch (e) {
    core.setFailed(
      `Failed to get OIDC token. Ensure your workflow has:\n  permissions:\n    id-token: write\n\nError: ${(e as Error).message}`,
    )
    return
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${oidcToken}`,
    'Content-Type': 'application/json',
  }

  // 2. Exchange OIDC token for registry credential.
  core.info('Authenticating with RollHook...')
  const tokenRes = await fetchWithRetry(
    `${url}/auth/token`,
    { method: 'POST', headers, body: JSON.stringify({ image_name: imageName }) },
    3,
    1000,
  )
  if (!tokenRes.ok) {
    core.setFailed(`POST /auth/token failed (${tokenRes.status}): ${await tokenRes.text()}`)
    return
  }
  const { token: registrySecret } = await tokenRes.json() as { token: string }

  // 3. docker login — --password-stdin keeps the secret out of process args and logs.
  try {
    await exec.exec('docker', ['login', registryHost, '-u', 'rollhook', '--password-stdin'], {
      input: Buffer.from(registrySecret),
    })
  }
  catch (e) {
    core.setFailed(`docker login failed: ${(e as Error).message}`)
    return
  }

  // 4. docker build
  core.info(`Building ${imageTag}...`)
  try {
    await exec.exec('docker', ['build', '-t', imageTag, '-f', dockerfile, buildContext])
  }
  catch (e) {
    core.setFailed(`docker build failed: ${(e as Error).message}`)
    return
  }

  // 5. docker push — retry up to 3 times with exponential backoff.
  // Docker push is idempotent: already-pushed blobs are skipped on retry.
  // Retries handle intermittent proxy/tunnel errors (e.g. Cloudflare 520).
  core.info(`Pushing ${imageTag}...`)
  {
    const maxAttempts = 3
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await exec.exec('docker', ['push', imageTag])
        lastError = undefined
        break
      }
      catch (e) {
        lastError = e as Error
        if (attempt < maxAttempts) {
          const delaySec = attempt * 10
          core.warning(`docker push attempt ${attempt}/${maxAttempts} failed, retrying in ${delaySec}s...`)
          await new Promise(resolve => setTimeout(resolve, delaySec * 1000))
        }
      }
    }
    if (lastError) {
      core.setFailed(`docker push failed after ${maxAttempts} attempts: ${lastError.message}`)
      return
    }
  }

  // 6. Trigger deploy (OIDC token still valid — 5 min lifetime, build+push is fast).
  core.info(`Triggering deployment: ${imageName} → ${imageTag}`)
  const triggerRes = await fetch(`${url}/deploy?async=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image_tag: imageTag }),
  })
  if (!triggerRes.ok) {
    const body = await triggerRes.text()
    core.setFailed(`Deploy trigger failed (${triggerRes.status}): ${body}`)
    return
  }

  const { job_id: jobId } = await triggerRes.json() as { job_id: string }
  core.info(`Job queued: ${jobId}`)
  core.setOutput('job_id', jobId)

  // 7. Run SSE streaming and status polling concurrently.
  const abortController = new AbortController()

  const pollPromise = pollUntilDone(url, headers, jobId, timeoutMs)
    .finally(() => abortController.abort())

  const [, pollResult] = await Promise.allSettled([
    streamLogs(url, headers, jobId, abortController.signal),
    pollPromise,
  ])

  if (pollResult.status === 'rejected') {
    core.setFailed((pollResult.reason as Error).message)
    return
  }

  const job = pollResult.value
  core.setOutput('status', job.status)

  if (job.status === 'success') {
    core.info('Deployment succeeded')
    await core.summary
      .addHeading('RollHook Deployment')
      .addTable([
        [{ data: 'Field', header: true }, { data: 'Value', header: true }],
        ['App', job.app],
        ['Image', job.image_tag],
        ['Job ID', job.id],
        ['Status', '✓ success'],
      ])
      .write()
  }
  else {
    core.setFailed(job.error ?? 'Deployment failed')
  }
}

run().catch((err: Error) => {
  core.setFailed(err.message)
})
