import * as core from '@actions/core'

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
  const url = core.getInput('url', { required: true }).replace(/\/$/, '')
  const token = core.getInput('token', { required: true })
  // admin_token is required for GET /jobs and SSE logs (admin role).
  // Falls back to token for users who use a single admin token for everything.
  const adminToken = core.getInput('admin_token') || token
  const app = core.getInput('app', { required: true })
  const imageTag = core.getInput('image_tag', { required: true })
  const timeoutSec = Number.parseInt(core.getInput('timeout') || '600', 10) || 600
  const timeoutMs = timeoutSec * 1000

  const triggerHeaders: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const adminHeaders: Record<string, string> = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  }

  core.info(`Triggering deployment: ${app} → ${imageTag}`)

  // ?async=true returns {job_id} immediately instead of blocking until completion.
  // Required so we can start streaming logs concurrently with polling.
  const triggerRes = await fetch(`${url}/deploy/${app}?async=true`, {
    method: 'POST',
    headers: triggerHeaders,
    body: JSON.stringify({ image_tag: imageTag }),
  })

  if (!triggerRes.ok) {
    const body = await triggerRes.text()
    core.error(`Deploy trigger failed (${triggerRes.status}): ${body}`)
    core.setFailed(`Deploy trigger returned ${triggerRes.status}`)
    return
  }

  const { job_id: jobId } = await triggerRes.json() as { job_id: string }
  core.info(`Job queued: ${jobId}`)
  core.setOutput('job_id', jobId)

  // Run SSE streaming and status polling concurrently.
  // When poll reaches a terminal state (or times out / errors), it triggers
  // abortController.abort() via .finally() — this signals streamLogs to stop
  // Phase 2 wait and proceed to the catchup fetch.
  const abortController = new AbortController()

  const pollPromise = pollUntilDone(url, adminHeaders, jobId, timeoutMs)
    .finally(() => abortController.abort())

  const [, pollResult] = await Promise.allSettled([
    streamLogs(url, adminHeaders, jobId, abortController.signal),
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
