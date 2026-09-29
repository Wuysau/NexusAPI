import { beforeEach, expect, it, vi } from 'vitest'
import { collectorAccounts, normalizeCollectorSnapshot } from '@/lib/subscriptions/collector'
const { query, release, fetchCollectorSnapshot, requireContext, context, row } = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  fetchCollectorSnapshot: vi.fn(),
  requireContext: vi.fn(),
  context: {
    tenantId: 'tenant-a',
    organizationId: 'org-a',
    session: { userId: 'user-a' },
    membership: { role: 'owner' },
  },
  row: {
    id: 'connection-a',
    owner_user_id: 'user-a',
    product: 'claude_code',
    mode: 'subscription_interactive',
    account_observation: null as unknown,
  },
}))
vi.mock('@/db', () => ({ pool: { query, connect: async () => ({ query, release }) } }))
vi.mock('@/lib/subscriptions/collector-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/subscriptions/collector-fetch')>()),
  fetchCollectorSnapshot,
}))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext,
  auditControlPlane: vi.fn(),
  jsonOk: (value: unknown) => Response.json(value),
  apiError: (status: number, code: string) => Response.json({ error: { code } }, { status }),
  routeError: (error: { status?: number }) => Response.json({}, { status: error.status ?? 500 }),
}))
import { GET, POST } from './route'
const params = { params: Promise.resolve({ id: 'connection-a' }) }
const snapshot = () => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  staleAfterSeconds: 180,
  providers: [
    {
      id: 'claude',
      enabled: true,
      identity: { accountEmail: 'person@example.com' },
      windows: [{ kind: 'session', usedPercent: 20, remainingPercent: 80 }],
      updatedAt: new Date().toISOString(),
      error: null,
    },
  ],
})
const request = (body: unknown) =>
  new Request('http://localhost/api/connections/connection-a/monitor', { method: 'POST', body: JSON.stringify(body) })
function importBody() {
  const value = snapshot()
  return {
    action: 'import',
    providerId: 'claude',
    accountId: collectorAccounts(value, 'claude')[0].accountId,
    snapshot: value,
  }
}
beforeEach(() => {
  context.membership.role = 'owner'
  row.owner_user_id = 'user-a'
  row.product = 'claude_code'
  row.account_observation = null
  query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT c.id')
      ? [row]
      : sql.includes('SELECT m.role')
        ? [{ role: context.membership.role }]
        : [],
  }))
  requireContext.mockReset().mockResolvedValue(context)
  fetchCollectorSnapshot.mockReset().mockResolvedValue(snapshot())
  release.mockReset()
})
it('persists only the selected organization-scoped sanitized monitor and never official quotas', async () => {
  const response = await POST(request(importBody()), params)
  expect(response.status).toBe(200)
  const updates = query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))
  expect(updates).toHaveLength(1)
  expect(updates[0][0]).toContain('UPDATE owned_connections SET account_observation=')
  expect(updates[0][1].slice(1)).toEqual(['connection-a', 'tenant-a'])
  expect(JSON.parse(updates[0][1][0])).toMatchObject({
    organizationId: 'org-a',
    authority: 'collector_reported',
    state: 'reported',
  })
  expect(updates[0][1][0]).not.toContain('person@example.com')
  expect(query.mock.calls.some(([sql]) => /quota_snapshots|ledger|channels/.test(sql))).toBe(false)
  expect(query.mock.calls.find(([sql]) => sql.includes('SELECT c.id'))?.[1]).toEqual([
    'tenant-a',
    'org-a',
    'user-a',
    true,
    'connection-a',
  ])
  expect(requireContext).toHaveBeenCalledWith(expect.any(Request), 'credential:create')
})
it('enforces auth/CSRF context before querying data', async () => {
  requireContext.mockRejectedValue({ status: 403 })
  expect((await POST(request(importBody()), params)).status).toBe(403)
  expect(query).not.toHaveBeenCalled()
})
it('returns 404 for connections excluded by organization/project visibility', async () => {
  query.mockResolvedValue({ rows: [] })
  expect((await GET(new Request('http://localhost'), params)).status).toBe(404)
  expect((await POST(request(importBody()), params)).status).toBe(404)
  expect(fetchCollectorSnapshot).not.toHaveBeenCalled()
})
it.each(['viewer', 'billing', 'developer'])('rejects nonowner %s writes even if project-visible', async (role) => {
  context.membership.role = role
  row.owner_user_id = 'someone-else'
  expect((await POST(request(importBody()), params)).status).toBe(404)
  expect(fetchCollectorSnapshot).not.toHaveBeenCalled()
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})
it('allows a connection owner to import but prevents developer discovery of other collector accounts', async () => {
  context.membership.role = 'developer'
  expect((await POST(request(importBody()), params)).status).toBe(200)
  expect((await POST(request({ action: 'preview', providerId: 'claude' }), params)).status).toBe(403)
  const body = importBody()
  expect(
    (await POST(request({ action: 'import', providerId: body.providerId, accountId: body.accountId }), params)).status,
  ).toBe(403)
  expect(fetchCollectorSnapshot).not.toHaveBeenCalled()
})
it('blocks shared collector refresh via a developer-forged imported account binding', async () => {
  context.membership.role = 'developer'
  const body = importBody()
  row.account_observation = normalizeCollectorSnapshot(
    body.snapshot,
    { providerId: body.providerId, accountId: body.accountId },
    'org-a',
  )
  expect((await POST(request({ action: 'refresh' }), params)).status).toBe(403)
  expect(fetchCollectorSnapshot).not.toHaveBeenCalled()
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})
it('never replaces native Codex observations', async () => {
  row.product = 'openai_codex'
  expect((await POST(request(importBody()), params)).status).toBe(400)
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})
it('does not accept arbitrary collector URLs, credentials or incompatible providers', async () => {
  expect(
    (await POST(request({ ...importBody(), url: 'http://attacker.example', token: 'secret' }), params)).status,
  ).toBe(400)
  expect((await POST(request({ ...importBody(), providerId: 'cursor' }), params)).status).toBe(400)
  expect(fetchCollectorSnapshot).not.toHaveBeenCalled()
})
it('refreshes the previously bound account and records error on account switch without relabeling its values', async () => {
  const body = importBody()
  row.account_observation = normalizeCollectorSnapshot(
    body.snapshot,
    { providerId: body.providerId, accountId: body.accountId },
    'org-a',
  )
  const changed = snapshot()
  changed.providers[0].identity.accountEmail = 'different@example.com'
  fetchCollectorSnapshot.mockResolvedValue(changed)
  const response = await POST(request({ action: 'refresh' }), params)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    observation: { accountId: body.accountId, state: 'error', windows: [{ usedPercent: 20 }] },
  })
  expect(fetchCollectorSnapshot).toHaveBeenCalledWith('tenant-a', 'org-a', 'claude')
})
it('rejects concurrent monitor replacement before saving a stale request result', async () => {
  let reads = 0
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT c.id')
      ? [{ ...row, account_observation: ++reads > 1 ? { changed: true } : null }]
      : sql.includes('SELECT m.role')
        ? [{ role: context.membership.role }]
        : [],
  }))
  expect((await POST(request(importBody()), params)).status).toBe(409)
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})
it.each([undefined, 'viewer', 'developer'])(
  'revalidates a revoked or downgraded membership %s after collector fetch',
  async (role) => {
    const body = importBody()
    row.account_observation = normalizeCollectorSnapshot(
      body.snapshot,
      { providerId: body.providerId, accountId: body.accountId },
      'org-a',
    )
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT c.id') ? [row] : sql.includes('SELECT m.role') && role ? [{ role }] : [],
    }))
    expect((await POST(request({ action: 'refresh' }), params)).status).toBe(403)
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
  },
)
