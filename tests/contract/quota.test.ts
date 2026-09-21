import { describe, expect, it } from 'vitest'
import schema from '../../packages/contracts/schemas/quota-observation.schema.json'
import metadataSchema from '../../packages/contracts/schemas/quota-metadata.schema.json'
import { createsMoneyPosting } from '../../packages/contracts/owned-access-accounting'
import {
  parseManualQuotaObservation,
  QuotaContractError,
  validateManualQuotaObservation,
} from '../../packages/contracts/quota'

const now = new Date('2026-09-16T12:00:00Z')
const observation = () => ({
  observationId: 'obs-1',
  windowType: 'monthly',
  used: '70',
  remaining: '30',
  scope: 'account',
  source: 'manual',
  sourceKind: 'reported',
  confidence: 'reported',
  attributionMode: 'shared',
  observedAt: '2026-09-16T10:00:00Z',
  staleAt: '2026-09-17T10:00:00Z',
  availability: 'available',
})
describe('manual quota observations', () => {
  it('uses canonical manual enums without admitting stronger output provenance', () => {
    for (const field of ['scope', 'source', 'sourceKind', 'confidence', 'attributionMode'] as const)
      for (const entry of schema.properties[field].enum)
        expect(parseManualQuotaObservation({ ...observation(), [field]: entry }, now)[field]).toBe(entry)
    expect(metadataSchema.properties.sourceKind.enum).toContain('official')
    expect(schema.properties.sourceKind.enum).not.toContain('official')
  })
  it('keeps extended subscription quota outside money posting', () => {
    expect(
      createsMoneyPosting({
        kind: 'subscription_quota',
        tenant_id: 't',
        connector_id: 'c',
        plan: 'pro',
        window: 'monthly',
        used: '70',
        remaining: null,
        source: 'manual',
        confidence: 'reported',
        observed_at: now.toISOString(),
        stale_at: now.toISOString(),
        metadata: {
          provenanceVersion: 1,
          observationId: 'obs',
          scope: 'account',
          sourceKind: 'reported',
          confidence: 'reported',
          attributionMode: 'shared',
          availability: 'available',
          freshness: 'stale',
          observedAt: now.toISOString(),
          staleAt: now.toISOString(),
          resetAt: null,
        },
      }),
    ).toBe(false)
  })
  it('normalizes exact decimals without floating point or project allocation', () => {
    const result = parseManualQuotaObservation(
      {
        ...observation(),
        used: '999999999999999999.123456789012',
        remaining: '00030.120000',
        observedAt: '2026-09-16T18:00:00+08:00',
      },
      now,
    )
    expect(result.used).toBe('999999999999999999.123456789012')
    expect(result.remaining).toBe('30.12')
    expect(result.observedAt).toBe('2026-09-16T10:00:00.000Z')
    expect(result.resetAt).toBeNull()
    expect(result.attributionMode).toBe('shared')
  })
  it('preserves explicit zero and unavailable null', () => {
    expect(parseManualQuotaObservation({ ...observation(), used: '0.000000000000' }, now).used).toBe('0')
    expect(
      parseManualQuotaObservation({ ...observation(), availability: 'unavailable', used: null, remaining: null }, now),
    ).toMatchObject({ used: null, remaining: null, availability: 'unavailable' })
  })
  it.each([
    ['used', 70],
    ['used', 0.1],
    ['used', NaN],
    ['used', Infinity],
    ['used', '-1'],
    ['used', '1e2'],
    ['used', '.5'],
    ['used', '1.'],
    ['used', '1000000000000000000'],
    ['used', '0.1234567890123'],
    ['used', ' 1'],
    ['remaining', '-0'],
    ['scope', 'project-estimated'],
    ['scope', 'unknown'],
    ['source', 'official'],
    ['sourceKind', 'official'],
    ['sourceKind', 'derived'],
    ['confidence', 'authoritative'],
    ['attributionMode', 'exclusive'],
    ['observationId', ''],
    ['observationId', 'a b'],
    ['observationId', 'a'.repeat(129)],
    ['windowType', 'x\n'],
    ['availability', 'unknown'],
    ['observedAt', '2026-02-30T00:00:00Z'],
    ['observedAt', '2026-09-17T00:00:00Z'],
    ['observedAt', '2026-09-16'],
    ['staleAt', '2026-09-15T00:00:00Z'],
    ['resetAt', '2026-09-15T00:00:00Z'],
    ['projectId', 'p1'],
  ])('rejects invalid %s', (key, value) => {
    const input = { ...observation(), [key]: value }
    expect(() => parseManualQuotaObservation(input, now)).toThrow(QuotaContractError)
    expect(validateManualQuotaObservation(input, now).ok).toBe(false)
  })
  it('requires every provenance field and counts', () => {
    for (const key of Object.keys(observation())) {
      const value: Record<string, unknown> = observation()
      delete value[key]
      expect(() => parseManualQuotaObservation(value, now)).toThrow(QuotaContractError)
    }
  })
  it('rejects unavailable invented counts', () => {
    expect(() => parseManualQuotaObservation({ ...observation(), availability: 'unavailable' }, now)).toThrow(
      QuotaContractError,
    )
  })
})
