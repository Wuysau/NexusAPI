import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  authorize: vi.fn(),
  project: vi.fn(),
  audit: vi.fn(),
}))
vi.mock('@/db', () => ({ pool: { connect: mocks.connect } }))
vi.mock('@/lib/quota/access', () => ({ resolveQuotaProject: mocks.project }))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext: mocks.authorize,
  readJsonBody: (req: Request) => req.json(),
  auditControlPlane: mocks.audit,
  jsonOk: (body: unknown, status = 200) => Response.json(body, { status }),
  apiError: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
  routeError: () => Response.json({ code: 'error' }, { status: 403 }),
}))
import { POST } from '@/app/api/connections/route'
import { SUBSCRIPTION_PRODUCTS } from './catalog'
const request = (body: unknown) =>
  new Request('http://localhost/api/connections', { method: 'POST', body: JSON.stringify(body) })
const registration = { provider: 'openai', mode: 'subscription_interactive' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.authorize.mockResolvedValue({ tenantId: 'tenant', session: { userId: 'owner' } })
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('INSERT')
      ? [{ id: 'connection', provider: 'openai', mode: 'subscription_interactive', status: 'pending' }]
      : [],
  }))
})
function saved() {
  return mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))?.[1] as unknown[]
}
describe('credential-free subscription registration', () => {
  it('keeps omitted product compatible with Codex, scoped project authorization and pending non-routing state', async () => {
    expect((await POST(request({ ...registration, projectId: 'project' }))).status).toBe(201)
    expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), 'credential:create')
    expect(mocks.project).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'project', {
      write: true,
      lock: true,
    })
    expect(saved().slice(0, 6)).toEqual(['tenant', 'owner', 'project', 'openai', 'subscription_interactive', null])
    expect(JSON.parse(saved()[6] as string)).toMatchObject({
      subscription_product: 'openai_codex',
      provider_identifier: 'openai',
      routing: false,
    })
  })
  it.each(SUBSCRIPTION_PRODUCTS)('registers $id using server-controlled product capabilities', async (product) => {
    expect(
      (
        await POST(
          request({ provider: product.provider, mode: 'subscription_interactive', subscriptionProduct: product.id }),
        )
      ).status,
    ).toBe(201)
    expect(JSON.parse(saved()[6] as string)).toMatchObject({
      subscription_product: product.id,
      native_account_observation: product.capabilities.nativeAccountObservation,
      routing: false,
    })
    expect(saved()[5]).toBeNull()
  })
  it.each([
    { subscriptionProduct: 'unknown' },
    { subscriptionProduct: null },
    { subscriptionProduct: 1 },
    { subscriptionProduct: 'claude_code' },
    { subscriptionProduct: { id: 'openai_codex' } },
    { providerIdentifier: 'bad\nidentifier' },
    { capabilities: { routing: true } },
    { credentialFingerprint: 'secret' },
    { apiKey: 'secret' },
    { token: 'secret' },
    { password: 'secret' },
    { cookie: 'secret' },
    { credential_ref: 'secret' },
  ])('rejects invalid product or credential/capability injection %j before database access', async (body) => {
    expect((await POST(request({ ...registration, ...body }))).status).toBe(400)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('does not let non-subscription registrations smuggle a product', async () => {
    expect(
      (await POST(request({ provider: 'openai', mode: 'direct_api', subscriptionProduct: 'claude_code' }))).status,
    ).toBe(400)
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('stops registration when context authorization fails', async () => {
    mocks.authorize.mockRejectedValue(new Error('forbidden'))
    expect((await POST(request(registration))).status).toBe(403)
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
