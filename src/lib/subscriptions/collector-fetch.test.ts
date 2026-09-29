import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { collectorConfigured, fetchCollectorSnapshot, readCollectorJson } from './collector-fetch'
const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.stubEnv('CODEXBAR_DASHBOARD_URL', 'http://127.0.0.1:8080')
  vi.stubEnv('CODEXBAR_DASHBOARD_TOKEN', 'private-test-token')
  vi.stubEnv('CODEXBAR_DASHBOARD_TENANT_ID', 'tenant-a')
  vi.stubEnv('CODEXBAR_DASHBOARD_ORGANIZATION_ID', 'org-a')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it('bounds stalled collector responses with the ten-second deadline', async () => {
  vi.useFakeTimers()
  fetchMock.mockImplementation(
    (_url, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('timeout with secret context')))
      }),
  )
  const pending = expect(fetchCollectorSnapshot('tenant-a', 'org-a', 'claude')).rejects.toThrow(
    /^collector_unavailable$/,
  )
  await vi.advanceTimersByTimeAsync(10_000)
  await pending
})
it('calls only the configured dashboard route with bearer auth and no redirects', async () => {
  fetchMock.mockResolvedValue(Response.json({ schemaVersion: 1 }))
  expect(await fetchCollectorSnapshot('tenant-a', 'org-a', 'claude')).toEqual({ schemaVersion: 1 })
  expect(fetchMock.mock.calls[0][0].toString()).toBe('http://127.0.0.1:8080/dashboard/v1/snapshot?provider=claude')
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    cache: 'no-store',
    headers: { Authorization: 'Bearer private-test-token' },
  })
})
it('blocks cross-tenant and cross-organization collector access before network access', async () => {
  expect(collectorConfigured('tenant-b', 'org-a')).toBe(false)
  await expect(fetchCollectorSnapshot('tenant-a', 'org-b', 'claude')).rejects.toThrow('collector_not_configured')
  expect(fetchMock).not.toHaveBeenCalled()
})
it.each([
  'http://remote.example',
  'https://user:password@example.com',
  'https://example.com?token=secret',
  'file:///etc/passwd',
])('rejects insecure or credential-bearing configured URL %s', async (url) => {
  vi.stubEnv('CODEXBAR_DASHBOARD_URL', url)
  await expect(fetchCollectorSnapshot('tenant-a', 'org-a', 'claude')).rejects.toThrow('collector_not_configured')
  expect(fetchMock).not.toHaveBeenCalled()
})
it('redacts transport and upstream diagnostic bodies', async () => {
  fetchMock.mockRejectedValue(new Error('Authorization private-test-token'))
  await expect(fetchCollectorSnapshot('tenant-a', 'org-a', 'claude')).rejects.toThrow(/^collector_unavailable$/)
  fetchMock.mockResolvedValue(new Response('secret-body', { status: 401 }))
  await expect(fetchCollectorSnapshot('tenant-a', 'org-a', 'claude')).rejects.toThrow(/^collector_unavailable$/)
})
it('rejects oversized streamed bodies and malformed JSON', async () => {
  await expect(readCollectorJson(new Response(' '.repeat(1_048_577)).body)).rejects.toThrow('snapshot_too_large')
  await expect(readCollectorJson(new Response('secret-invalid-json').body)).rejects.toThrow(
    /^invalid_dashboard_snapshot$/,
  )
})
