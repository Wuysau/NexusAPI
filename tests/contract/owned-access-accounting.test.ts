import { describe, expect, it } from 'vitest'
import { createsMoneyPosting, OwnedAccessAccounting } from '../../packages/contracts/owned-access-accounting'

describe('owned-access accounting separation', () => {
  it('does not post subscription quota without an authoritative unit price', () => {
    const quota: OwnedAccessAccounting = {
      kind: 'subscription_quota',
      tenant_id: 'tenant-a',
      connector_id: 'local',
      plan: 'pro',
      window: 'monthly',
      source: 'mock',
      observed_at: '2026-09-11T00:00:00Z',
      stale_at: '2026-09-12T00:00:00Z',
      confidence: 'reported',
    }
    expect(createsMoneyPosting(quota)).toBe(false)
  })

  it('posts authoritative API usage and service fees only', () => {
    expect(
      createsMoneyPosting({
        kind: 'api_usage',
        tenant_id: 't',
        connector_id: 'c',
        authoritative: true,
        price_version_id: 'p',
      }),
    ).toBe(true)
    expect(createsMoneyPosting({ kind: 'api_usage', tenant_id: 't', connector_id: 'c', authoritative: false })).toBe(
      false,
    )
    expect(
      createsMoneyPosting({
        kind: 'nexus_service_fee',
        tenant_id: 't',
        fee_minor: 100n,
        currency: 'USD',
        price_version_id: 'p',
      }),
    ).toBe(true)
  })
})
