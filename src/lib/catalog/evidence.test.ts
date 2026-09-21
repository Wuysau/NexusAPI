import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), approve: vi.fn(), reject: vi.fn(), auth: vi.fn() }))
vi.mock('@/db', () => ({ pool: { query: mocks.query } }))
vi.mock('@/lib/catalog/approval', () => ({ approvePriceCandidate: mocks.approve }))
vi.mock('@/lib/catalog/lifecycle', async (original) => ({
  ...(await original<object>()),
  transitionPriceCandidate: mocks.reject,
}))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext: mocks.auth,
  requireHighRiskContext: mocks.auth,
  jsonOk: (body: unknown) => Response.json(body),
  apiError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  routeError: () => Response.json({ error: 'unexpected' }, { status: 500 }),
  readJsonBody: (req: Request) => req.json(),
  clientIp: () => '127.0.0.1',
}))
import { GET as models } from '@/app/api/models/route'
import { GET as pricing, POST as decide } from '@/app/api/pricing/route'
import { isDemoModel, isPlaceholderPriceSource } from './evidence'

const date = new Date('2026-09-20T00:00:00Z')
const row = {
  id: 'model-real',
  provider_id: 'provider',
  provider_code: 'custom',
  provider_name: 'Custom',
  upstream_model_id: 'real-model',
  display_name: 'Real model',
  context_window: null,
  max_output_tokens: null,
  capabilities: [],
  lifecycle_status: 'active',
  available: true,
  first_seen_at: date,
  last_seen_at: date,
  raw_metadata: {},
  price_version_id: 'version',
  currency: 'USD',
  price_status: 'active',
  effective_from: date,
  source_type: 'official_api',
  source_url: 'https://provider.test/pricing',
  fetched_at: date,
  pending_candidates: '0',
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ tenantId: 'tenant', organizationId: 'organization', principal: { userId: 'user' } })
  mocks.approve.mockResolvedValue({ candidateId: 'candidate', status: 'active' })
  mocks.reject.mockResolvedValue({ from: 'pending_approval' })
})

describe('catalog business evidence', () => {
  it('recognizes explicit seed metadata and reserved placeholder hosts only', () => {
    expect(isDemoModel({ demo: true })).toBe(true)
    expect(isDemoModel({ provider: 'custom', demo: false })).toBe(false)
    expect(isDemoModel(null)).toBe(false)
    for (const url of ['https://example.invalid/prices', 'https://sub.EXAMPLE.INVALID./prices']) {
      expect(isPlaceholderPriceSource(url)).toBe(true)
    }
    for (const url of [
      null,
      '',
      'manual evidence',
      'https://custom-provider.test/pricing',
      'https://example.invalid.provider.test/pricing',
    ]) {
      expect(isPlaceholderPriceSource(url)).toBe(false)
    }
  })
  it('separates seeded models without hiding organization configurations or assuming unknown providers are demo', async () => {
    const configuration = { id: 'config', upstreamModelId: 'seed-model' }
    mocks.query
      .mockResolvedValueOnce({
        rows: [row, { ...row, id: 'seed', upstream_model_id: 'seed-model', raw_metadata: { demo: true } }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [configuration] })
      .mockResolvedValueOnce({ rows: [] })
    const body = await (await models(new Request('http://localhost/api/models'))).json()
    expect(body.models.map((model: { id: string }) => model.id)).toEqual(['model-real'])
    expect(body.demoModels[0]).toMatchObject({
      id: 'seed',
      available: false,
      price: null,
      contextWindow: null,
      capabilities: [],
      evidence: { kind: 'demo' },
    })
    expect(body.configurations).toEqual([configuration])
    expect(mocks.query.mock.calls.find(([sql]) => sql.includes('FROM organization_model_configurations'))?.[1]).toEqual(
      ['tenant', 'organization'],
    )
  })

  it('does not present a placeholder price version as a real approved price', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...row, source_url: 'https://example.invalid/seed/pricing' }] })
      .mockResolvedValue({ rows: [] })
    const body = await (await models(new Request('http://localhost/api/models'))).json()
    expect(body.models[0].price).toBeNull()
    expect(body.models[0].priceEvidence).toMatchObject({ kind: 'demo', versionId: 'version' })
  })

  it('marks queue placeholders as demo evidence and disables approval eligibility', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            ...row,
            id: 'candidate',
            status: 'pending_approval',
            created_at: date,
            updated_at: date,
            source_url: 'https://example.invalid/pricing',
          },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const body = await (await pricing(new Request('http://localhost/api/pricing'))).json()
    expect(body.candidates[0]).toMatchObject({ approvalBlocked: true, evidence: { kind: 'demo' } })
  })

  it('also blocks a candidate whose linked version has placeholder evidence', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            ...row,
            id: 'candidate',
            status: 'pending_approval',
            created_at: date,
            updated_at: date,
            version_source_urls: ['https://example.invalid/pricing'],
          },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const body = await (await pricing(new Request('http://localhost/api/pricing'))).json()
    expect(body.candidates[0]).toMatchObject({ approvalBlocked: true, evidence: { kind: 'demo' } })
  })

  it('does not use placeholder active prices as the official comparison baseline', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ ...row, id: 'candidate', status: 'pending_approval', created_at: date, updated_at: date }],
      })
      .mockResolvedValueOnce({
        rows: [{ price_candidate_id: 'candidate', kind: 'input', amount: '5', unit: 'per_million_tokens' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { kind: 'input', amount: '1', unit: 'per_million_tokens', source_url: 'https://example.invalid/pricing' },
        ],
      })
    const body = await (await pricing(new Request('http://localhost/api/pricing'))).json()
    expect(body.candidates[0].diff.changes[0].from).toBeNull()
    expect(body.candidates[0].baselineEvidence).toBe('demo_excluded')
  })

  it('blocks approval of known placeholder evidence before mutating prices', async () => {
    mocks.query.mockResolvedValue({ rows: [{ source_url: 'https://EXAMPLE.invalid./pricing' }] })
    const response = await decide(
      new Request('http://localhost/api/pricing', {
        method: 'POST',
        body: JSON.stringify({ candidateId: 'candidate', action: 'approve' }),
      }),
    )
    expect(response.status).toBe(409)
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('allows rejection of placeholder evidence', async () => {
    const response = await decide(
      new Request('http://localhost/api/pricing', {
        method: 'POST',
        body: JSON.stringify({ candidateId: 'candidate', action: 'reject', reason: 'placeholder' }),
      }),
    )
    expect(response.status).toBe(200)
    expect(mocks.reject).toHaveBeenCalledOnce()
  })
})
