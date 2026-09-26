import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  candidateZoneNames,
  describeFailureHint,
  parsePurgeHosts,
  purgeCloudflareCache,
} from './cloudflare.ts'

interface FakeResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/**
 * A fake `fetch` that answers Cloudflare's Zones and purge_cache endpoints
 * from the given handlers, and records every call so tests can assert on
 * grouping/chunking/retry behaviour without touching the network.
 */
function createFakeFetch(handlers: {
  zones?: (name: string) => FakeResponse
  purge?: (zoneId: string, hosts: string[]) => FakeResponse
}): {
  fetchFn: typeof fetch
  zoneCalls: string[]
  purgeCalls: { zoneId: string, hosts: string[] }[]
} {
  const zoneCalls: string[] = []
  const purgeCalls: { zoneId: string, hosts: string[] }[] = []

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString()

    const zoneMatch = url.match(/\/zones\?name=([^&]+)/)
    if (zoneMatch) {
      const name = decodeURIComponent(zoneMatch[1])
      zoneCalls.push(name)
      const result = handlers.zones?.(name) ?? { status: 200, body: { success: true, errors: [], result: [] } }
      return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers })
    }

    const purgeMatch = url.match(/\/zones\/([^/]+)\/purge_cache/)
    if (purgeMatch) {
      const zoneId = purgeMatch[1]
      const hosts = (JSON.parse(String(init?.body)) as { hosts: string[] }).hosts
      purgeCalls.push({ zoneId, hosts })
      const result = handlers.purge?.(zoneId, hosts) ?? { status: 200, body: { success: true, errors: [] } }
      return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers })
    }

    throw new Error(`unexpected fetch url: ${url}`)
  }) as typeof fetch

  return { fetchFn, zoneCalls, purgeCalls }
}

const noopSleep = async (): Promise<void> => {}

const zoneOk = (id: string, name: string): FakeResponse => ({
  status: 200,
  body: { success: true, errors: [], result: [{ id, name }] },
})
const zoneEmpty: FakeResponse = { status: 200, body: { success: true, errors: [], result: [] } }
const purgeOk: FakeResponse = { status: 200, body: { success: true, errors: [] } }

test('parsePurgeHosts normalizes valid entries and rejects bad ones', () => {
  const { hosts, invalid } = parsePurgeHosts([
    'example.com, WWW.Example.com:8080/some/path',
    '# a comment line',
    '',
    'https://api.example.com.',
    '*.wild.com',
    '1.2.3.4',
    'nodothost',
    'bad_label!.com',
  ])

  assert.deepEqual(hosts, ['example.com', 'www.example.com', 'api.example.com'])
  assert.deepEqual(invalid.map(i => i.entry), ['*.wild.com', '1.2.3.4', 'nodothost', 'bad_label!.com'])
  assert.match(invalid[0].reason, /wildcard/)
  assert.match(invalid[1].reason, /IP address/)
  assert.match(invalid[2].reason, /dot/)
  assert.match(invalid[3].reason, /invalid characters/)
})

test('parsePurgeHosts dedupes while preserving first-seen order', () => {
  const { hosts, invalid } = parsePurgeHosts(['b.example.com', 'a.example.com,b.example.com', 'a.example.com'])
  assert.deepEqual(hosts, ['b.example.com', 'a.example.com'])
  assert.deepEqual(invalid, [])
})

test('candidateZoneNames walks suffixes without ever reaching the bare TLD', () => {
  assert.deepEqual(candidateZoneNames('www.a.example.com'), ['www.a.example.com', 'a.example.com', 'example.com'])
  assert.deepEqual(candidateZoneNames('example.com'), ['example.com'])
})

test('groups two hosts sharing a zone into a single purge call', async () => {
  const { fetchFn, purgeCalls } = createFakeFetch({
    zones: name => name === 'example.com' ? zoneOk('zone1', 'example.com') : zoneEmpty,
  })

  const result = await purgeCloudflareCache({
    hosts: ['www.example.com', 'api.example.com'],
    token: 'tok',
    fetch: fetchFn,
    sleep: noopSleep,
  })

  assert.equal(result.failures.length, 0)
  assert.equal(purgeCalls.length, 1)
  assert.deepEqual(purgeCalls[0].hosts, ['www.example.com', 'api.example.com'])
  assert.equal(result.succeeded.length, 1)
  assert.deepEqual(result.succeeded[0].hosts, ['www.example.com', 'api.example.com'])
})

test('chunks a purge request at 30 hosts per call', async () => {
  const hosts = Array.from({ length: 35 }, (_, i) => `h${i}.example.com`)
  const { fetchFn, purgeCalls } = createFakeFetch({ zones: () => zoneOk('zone1', 'example.com') })

  const result = await purgeCloudflareCache({ hosts, token: 'tok', fetch: fetchFn, sleep: noopSleep })

  assert.equal(result.failures.length, 0)
  assert.equal(purgeCalls.length, 2)
  assert.equal(purgeCalls[0].hosts.length, 30)
  assert.equal(purgeCalls[1].hosts.length, 5)
})

test('classifies a 403 / code 10000 purge failure as auth with a scoped hint', async () => {
  const { fetchFn } = createFakeFetch({
    zones: () => zoneOk('zone1', 'example.com'),
    purge: () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }),
  })

  const result = await purgeCloudflareCache({ hosts: ['example.com'], token: 'tok', fetch: fetchFn, sleep: noopSleep })

  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].kind, 'auth')
  const hint = describeFailureHint(result.failures[0])
  assert.match(hint ?? '', /Zone:Read/)
  assert.match(hint ?? '', /example\.com/)
})

test('reports zone-not-found when no suffix candidate matches any zone', async () => {
  const { fetchFn } = createFakeFetch({ zones: () => zoneEmpty })

  const result = await purgeCloudflareCache({ hosts: ['sub.unknown-domain.com'], token: 'tok', fetch: fetchFn, sleep: noopSleep })

  assert.equal(result.resolutions[0].zone, null)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].kind, 'zone-not-found')
  assert.match(describeFailureHint(result.failures[0]) ?? '', /isn't in any zone/)
})

test('retries a 429 purge honoring Retry-After, then succeeds', async () => {
  let purgeAttempts = 0
  const { fetchFn, purgeCalls } = createFakeFetch({
    zones: name => name === 'example.com' ? zoneOk('zone1', 'example.com') : zoneEmpty,
    purge: () => {
      purgeAttempts++
      if (purgeAttempts === 1) {
        return {
          status: 429,
          body: { success: false, errors: [{ code: 10013, message: 'rate limited' }] },
          headers: { 'Retry-After': '1' },
        }
      }
      return purgeOk
    },
  })

  const sleeps: number[] = []
  const result = await purgeCloudflareCache({
    hosts: ['www.example.com'],
    token: 'tok',
    fetch: fetchFn,
    sleep: async (ms) => { sleeps.push(ms) },
  })

  assert.equal(result.failures.length, 0)
  assert.equal(result.succeeded.length, 1)
  assert.equal(purgeCalls.length, 2)
  assert.deepEqual(sleeps, [1000])
})

test('exhausting 429 retries reports a rate-limited failure', async () => {
  const { fetchFn, purgeCalls } = createFakeFetch({
    zones: name => name === 'example.com' ? zoneOk('zone1', 'example.com') : zoneEmpty,
    purge: () => ({
      status: 429,
      body: { success: false, errors: [{ code: 10013, message: 'rate limited' }] },
      headers: { 'Retry-After': '120' },
    }),
  })

  const sleeps: number[] = []
  const result = await purgeCloudflareCache({
    hosts: ['www.example.com'],
    token: 'tok',
    fetch: fetchFn,
    sleep: async (ms) => { sleeps.push(ms) },
  })

  assert.equal(purgeCalls.length, 3)
  assert.deepEqual(sleeps, [60_000, 60_000]) // Retry-After clamped to 60s
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].kind, 'rate-limited')
  assert.match(describeFailureHint(result.failures[0]) ?? '', /re-run the job later/)
})

test('returns the typed success shape for a single resolved host', async () => {
  const { fetchFn } = createFakeFetch({
    zones: name => name === 'example.com' ? zoneOk('zone1', 'example.com') : zoneEmpty,
  })

  const result = await purgeCloudflareCache({ hosts: ['www.example.com'], token: 'tok', fetch: fetchFn, sleep: noopSleep })

  assert.deepEqual(result, {
    resolutions: [{ host: 'www.example.com', zone: { id: 'zone1', name: 'example.com' } }],
    succeeded: [{ zone: { id: 'zone1', name: 'example.com' }, hosts: ['www.example.com'] }],
    failures: [],
  })
})
