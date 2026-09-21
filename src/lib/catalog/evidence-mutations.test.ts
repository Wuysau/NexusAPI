import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }))
vi.mock('@/db', () => ({ pool: { connect: mocks.connect } }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }))
import { approvePriceCandidate } from './approval'
import { activateCandidate, emergencyRollback, publishSnapshot } from './activation'
import type { PoolClient } from 'pg'
import type { Principal } from '@/lib/auth/capabilities'
import { assertCandidatePriceEvidence } from './evidence'

const actor: Principal = { kind: 'user', role: 'owner', userId: 'user', tenantId: 'tenant' }
const candidate = {
  id: 'candidate',
  provider_id: 'provider',
  upstream_model_id: 'model',
  status: 'scheduled',
  effective_from: new Date('2026-01-01'),
  approved_by: 'user',
  currency: 'USD',
  region: 'global',
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM price_candidates WHERE')) return { rows: [candidate] }
    if (sql.includes('source_url')) return { rows: [{ source_url: 'https://example.invalid/pricing' }] }
    return { rows: [] }
  })
})

function expectNoMutation() {
  expect(mocks.query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false)
  expect(mocks.query).toHaveBeenCalledWith('ROLLBACK')
}

describe('price evidence transaction guards', () => {
  it('checks version evidence even when the candidate source is not a placeholder', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ source_url: 'https://provider.test/pricing' }] })
      .mockResolvedValueOnce({ rows: [{ source_url: 'https://example.invalid/pricing' }] })
    await expect(
      assertCandidatePriceEvidence({ query: mocks.query } as unknown as PoolClient, 'candidate'),
    ).rejects.toMatchObject({ code: 'placeholder_price_evidence' })
  })
  it('retains manual and unfamiliar provider evidence without classifying it as demo', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ source_url: null }] })
      .mockResolvedValueOnce({ rows: [{ source_url: 'https://unfamiliar-provider.test/pricing' }] })
    await expect(
      assertCandidatePriceEvidence({ query: mocks.query } as unknown as PoolClient, 'candidate'),
    ).resolves.toBeUndefined()
  })
  it('refuses placeholder approval inside the service transaction before any mutation', async () => {
    await expect(approvePriceCandidate({ candidateId: 'candidate', actor, tenantId: 'tenant' })).rejects.toMatchObject({
      code: 'placeholder_price_evidence',
    })
    expectNoMutation()
  })
  it('refuses activation of a previously scheduled placeholder price', async () => {
    await expect(activateCandidate({ candidateId: 'candidate', tenantId: 'tenant' })).rejects.toMatchObject({
      code: 'placeholder_price_evidence',
    })
    expectNoMutation()
  })
  it('refuses a rollback to a historical placeholder version without creating a replacement', async () => {
    await expect(
      emergencyRollback({
        providerId: 'provider',
        modelId: 'model',
        targetPriceVersionId: 'old',
        actor,
        reason: 'restore',
        tenantId: 'tenant',
      }),
    ).rejects.toMatchObject({ code: 'placeholder_price_evidence' })
    expectNoMutation()
  })
  it('omits preserved demo prices from newly published gateway snapshots', async () => {
    const previousKey = process.env.SNAPSHOT_SIGNING_KEY
    process.env.SNAPSHOT_SIGNING_KEY = 'unit-test-only-signing-key-that-is-at-least-32-chars'
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(sequence_number)')) return { rows: [{ seq: '1' }] }
      if (sql.includes('FROM provider_price_versions v JOIN providers'))
        return {
          rows: [
            {
              id: 'demo-version',
              provider: 'custom',
              upstream_model_id: 'demo',
              currency: 'USD',
              region: 'global',
              service_tier: 'default',
              unit: 'per_million_tokens',
              provider_id: 'provider',
              effective_from: null,
              effective_to: null,
              source_url: 'https://example.invalid/pricing',
            },
            {
              id: 'real-version',
              provider: 'custom',
              upstream_model_id: 'real',
              currency: 'USD',
              region: 'global',
              service_tier: 'default',
              unit: 'per_million_tokens',
              provider_id: 'provider',
              effective_from: null,
              effective_to: null,
              source_url: 'https://unfamiliar-provider.test/pricing',
            },
          ],
        }
      if (sql.includes('INSERT INTO gateway_snapshots')) return { rows: [{ id: 'snapshot' }] }
      return { rows: [] }
    })
    try {
      const result = await publishSnapshot({ query: mocks.query } as unknown as PoolClient, {
        tenantId: 'tenant',
        catalogVersion: null,
        publishedBy: 'user',
      })
      expect(result.payload.price_versions.map((version) => version.id)).toEqual(['real-version'])
    } finally {
      if (previousKey === undefined) delete process.env.SNAPSHOT_SIGNING_KEY
      else process.env.SNAPSHOT_SIGNING_KEY = previousKey
    }
  })
})
