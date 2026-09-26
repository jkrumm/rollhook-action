/**
 * Cloudflare edge-cache purge: host parsing/validation, zone resolution, and
 * the purge call itself. Pure and side-effect free — no @actions/core, no
 * bare `fetch` calls — so it can be unit tested with a fake `fetch` and no
 * network. index.ts owns all logging/summary/setFailed; this module only
 * returns typed data.
 */

export interface CloudflareZone {
  id: string
  name: string
}

export interface CloudflareErrorEntry {
  code: number
  message: string
}

interface CloudflareApiResponse {
  success: boolean
  errors: CloudflareErrorEntry[]
}

interface CloudflareListZonesResponse extends CloudflareApiResponse {
  result: CloudflareZone[]
}

type CloudflarePurgeResponse = CloudflareApiResponse

export interface InvalidHost {
  entry: string
  reason: string
}

export interface ParsedHosts {
  hosts: string[]
  invalid: InvalidHost[]
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function normalizeHost(entry: string): string {
  let value = entry.trim()
  value = value.replace(SCHEME_RE, '')
  value = value.split(/[/?#]/)[0] ?? ''
  value = value.replace(/:\d+$/, '')
  value = value.replace(/\.$/, '')
  return value.toLowerCase()
}

function validateHost(host: string): string | null {
  if (!host)
    return 'empty entry'
  if (host.includes('*'))
    return 'wildcards are not supported'
  if (IPV4_RE.test(host) || host.includes(':'))
    return 'IP addresses are not supported — use a hostname'
  if (!host.includes('.'))
    return 'must be a fully-qualified hostname with a dot'
  if (host.split('.').some(label => !LABEL_RE.test(label)))
    return 'contains invalid characters for a hostname label'
  return null
}

/**
 * Parse the raw `cloudflare_purge_hosts` lines: newline AND comma separated,
 * blank lines and # comments ignored. Normalizes each entry (scheme/path/
 * port/trailing dot stripped, lowercased) and rejects wildcards, IPs, bare
 * labels and invalid characters — collected in `invalid` so the caller can
 * fail fast, before the docker build, listing every bad entry at once.
 */
export function parsePurgeHosts(rawLines: string[]): ParsedHosts {
  const seen = new Set<string>()
  const hosts: string[] = []
  const invalid: InvalidHost[] = []

  for (const line of rawLines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#'))
      continue

    for (const rawEntry of trimmedLine.split(',')) {
      const entry = rawEntry.trim()
      if (!entry)
        continue

      const host = normalizeHost(entry)
      const reason = validateHost(host)
      if (reason) {
        invalid.push({ entry, reason })
        continue
      }
      if (!seen.has(host)) {
        seen.add(host)
        hosts.push(host)
      }
    }
  }

  return { hosts, invalid }
}

/**
 * Walk label suffixes from most to least specific, stopping at two labels —
 * `www.a.example.com` yields `www.a.example.com`, `a.example.com`,
 * `example.com`, never the bare TLD.
 */
export function candidateZoneNames(host: string): string[] {
  const labels = host.split('.')
  const candidates: string[] = []
  for (let i = 0; i <= labels.length - 2; i++)
    candidates.push(labels.slice(i).join('.'))
  return candidates
}

const RATE_LIMIT_CODES = new Set([971, 10013])
const DEFAULT_RETRY_AFTER_SECONDS = 5
const MAX_RETRY_AFTER_SECONDS = 60

function isRateLimited(status: number, errors: CloudflareErrorEntry[]): boolean {
  if (status === 429)
    return true
  return errors.some(e => RATE_LIMIT_CODES.has(e.code) || /rate.?limit/i.test(e.message))
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('Retry-After')
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN
  const clamped = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
    : DEFAULT_RETRY_AFTER_SECONDS
  return clamped * 1000
}

export type PurgeFailureKind = 'auth' | 'zone-not-found' | 'rate-limited' | 'unknown'

function classifyFailureKind(status: number, errors: CloudflareErrorEntry[]): PurgeFailureKind {
  if (status === 403 || errors.some(e => e.code === 10000))
    return 'auth'
  if (isRateLimited(status, errors))
    return 'rate-limited'
  return 'unknown'
}

/**
 * Fetch a Cloudflare API endpoint with retry: network errors retry with a
 * fixed 1s backoff (existing behaviour); HTTP 429 or a rate-limit error code
 * in the body (971, 10013, or a "rate limited"-shaped message) retries
 * honoring `Retry-After` (capped at 60s, default 5s). Up to `maxAttempts`
 * (default 3) total attempts either way.
 */
async function fetchCloudflare<T extends CloudflareApiResponse>(params: {
  url: string
  init: RequestInit
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  maxAttempts?: number
}): Promise<{ res: Response, body: T | null }> {
  const maxAttempts = params.maxAttempts ?? 3
  let lastNetworkError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await params.fetch(params.url, params.init)
    }
    catch (err) {
      lastNetworkError = err as Error
      if (attempt < maxAttempts) {
        await params.sleep(1000)
        continue
      }
      throw lastNetworkError
    }

    const body = await res.json().catch(() => null) as T | null
    if (isRateLimited(res.status, body?.errors ?? []) && attempt < maxAttempts) {
      await params.sleep(retryAfterMs(res))
      continue
    }
    return { res, body }
  }

  // Unreachable — the loop above always returns or throws.
  throw lastNetworkError ?? new Error('Cloudflare request failed')
}

type ZoneLookup =
  | { ok: true, zone: CloudflareZone | null }
  | { ok: false, kind: PurgeFailureKind, errors: CloudflareErrorEntry[] }

/**
 * Resolve the Cloudflare zone that owns a hostname by trying successively
 * shorter label suffixes against the Zones API. Lookups are cached per
 * candidate name so hosts sharing a parent domain only hit the API once.
 */
async function resolveZoneForHost(params: {
  host: string
  token: string
  cache: Map<string, CloudflareZone | null>
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}): Promise<ZoneLookup> {
  for (const candidate of candidateZoneNames(params.host)) {
    if (params.cache.has(candidate)) {
      const cached = params.cache.get(candidate) ?? null
      if (cached)
        return { ok: true, zone: cached }
      continue
    }

    const { res, body } = await fetchCloudflare<CloudflareListZonesResponse>({
      url: `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`,
      init: { headers: { Authorization: `Bearer ${params.token}` } },
      fetch: params.fetch,
      sleep: params.sleep,
    })

    // A rejected lookup (bad token, missing Zone:Read) is not "no such zone" —
    // surface Cloudflare's errors so the verdict can name the permission.
    if (!res.ok || !body?.success) {
      const errors = body?.errors?.length
        ? body.errors
        : [{ code: res.status, message: 'Non-2xx response with no parseable error body' }]
      return { ok: false, kind: classifyFailureKind(res.status, errors), errors }
    }

    const zone = body.result[0]
    params.cache.set(candidate, zone ?? null)
    if (zone)
      return { ok: true, zone }
  }
  return { ok: true, zone: null }
}

type PurgeCallResult =
  | { ok: true }
  | { ok: false, kind: PurgeFailureKind, errors: CloudflareErrorEntry[] }

/**
 * Purge a zone's edge cache for a set of hostnames, by hostname rather than
 * purge_everything — a shared zone may host other content (e.g. a CDN) whose
 * cache must survive. Chunks at Cloudflare's 30-hosts-per-request limit.
 */
async function purgeZoneForHosts(params: {
  zone: CloudflareZone
  hosts: string[]
  token: string
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}): Promise<PurgeCallResult> {
  for (let i = 0; i < params.hosts.length; i += 30) {
    const chunk = params.hosts.slice(i, i + 30)
    const { res, body } = await fetchCloudflare<CloudflarePurgeResponse>({
      url: `https://api.cloudflare.com/client/v4/zones/${params.zone.id}/purge_cache`,
      init: {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hosts: chunk }),
      },
      fetch: params.fetch,
      sleep: params.sleep,
    })

    if (!res.ok || !body?.success) {
      const errors = body?.errors?.length
        ? body.errors
        : [{ code: res.status, message: 'Non-2xx response with no parseable error body' }]
      return { ok: false, kind: classifyFailureKind(res.status, errors), errors }
    }
  }
  return { ok: true }
}

export interface HostResolution {
  host: string
  zone: CloudflareZone | null
}

export interface PurgeZoneGroup {
  zone: CloudflareZone
  hosts: string[]
}

export interface PurgeFailure {
  hosts: string[]
  zone?: CloudflareZone
  kind: PurgeFailureKind
  reason: string
  errors: CloudflareErrorEntry[]
}

export interface PurgeCloudflareResult {
  resolutions: HostResolution[]
  succeeded: PurgeZoneGroup[]
  failures: PurgeFailure[]
}

/**
 * Resolve each host to its zone, group by zone, and purge. Every host is
 * attempted — a resolution or purge failure for one host/zone never stops
 * the rest, so a single run surfaces every problem instead of just the
 * first one.
 */
export async function purgeCloudflareCache(params: {
  hosts: string[]
  token: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}): Promise<PurgeCloudflareResult> {
  const doFetch = params.fetch ?? fetch
  const doSleep = params.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const zoneCache = new Map<string, CloudflareZone | null>()
  const resolutions: HostResolution[] = []
  const failures: PurgeFailure[] = []
  const hostsByZone = new Map<string, PurgeZoneGroup>()

  for (const host of params.hosts) {
    const lookup = await resolveZoneForHost({ host, token: params.token, cache: zoneCache, fetch: doFetch, sleep: doSleep })

    if (!lookup.ok) {
      resolutions.push({ host, zone: null })
      failures.push({
        hosts: [host],
        kind: lookup.kind,
        reason: `Resolving the Cloudflare zone for ${host}`,
        errors: lookup.errors,
      })
      continue
    }

    resolutions.push({ host, zone: lookup.zone })

    if (!lookup.zone) {
      failures.push({
        hosts: [host],
        kind: 'zone-not-found',
        reason: `No Cloudflare zone found for ${host} or any parent domain`,
        errors: [],
      })
      continue
    }

    const group = hostsByZone.get(lookup.zone.id) ?? { zone: lookup.zone, hosts: [] }
    group.hosts.push(host)
    hostsByZone.set(lookup.zone.id, group)
  }

  const succeeded: PurgeZoneGroup[] = []
  for (const group of hostsByZone.values()) {
    const result = await purgeZoneForHosts({ zone: group.zone, hosts: group.hosts, token: params.token, fetch: doFetch, sleep: doSleep })
    if (result.ok) {
      succeeded.push(group)
      continue
    }
    failures.push({
      hosts: group.hosts,
      zone: group.zone,
      kind: result.kind,
      reason: `Purging Cloudflare cache for zone ${group.zone.name}`,
      errors: result.errors,
    })
  }

  return { resolutions, succeeded, failures }
}

export function formatCloudflareErrors(errors: CloudflareErrorEntry[]): string {
  return errors.length > 0
    ? errors.map(e => `[${e.code}] ${e.message}`).join('; ')
    : '<no error detail>'
}

/**
 * One-line, actionable hint for a purge failure. Mirrors the RollHook
 * diagnoseFailure pattern in index.ts — the failure kind decides the class,
 * since Cloudflare's error messages are prose that may be reworded upstream.
 * Returns null for 'unknown' — the caller then reports the raw errors alone.
 */
export function describeFailureHint(failure: PurgeFailure): string | null {
  switch (failure.kind) {
    case 'auth':
      return `Cloudflare rejected the API token — it lacks Zone:Read + Zone:Cache Purge permissions on ${failure.zone?.name ?? failure.hosts[0]}.`
    case 'zone-not-found':
      return `${failure.hosts[0]} isn't in any zone this token can see — check for a typo, or a token scoped to other zones.`
    case 'rate-limited':
      return 'Cloudflare rate limited this request after 3 attempts — re-run the job later.'
    default:
      return null
  }
}
