import { describe, expect, it } from 'vitest'
import { presentQuota } from './read'

const now = new Date('2026-09-16T00:00:00Z')
const row = {
  id: 'snapshot',
  observation_id: 'manual-1',
  window_type: 'daily',
  used: '70.000000000000',
  remaining: '30.000000000000',
  source: 'manual',
  source_kind: 'reported',
  confidence: 'reported',
  scope: 'account',
  attribution_mode: 'shared',
  availability: 'available',
  provenance_version: 1,
  observed_at: new Date('2026-09-15T23:00:00Z'),
  stale_at: new Date('2026-09-16T01:00:00Z'),
  reset_at: null,
}
describe('quota presentation', () => {
  it('keeps account values and provenance separate from any Project percentage', () => {
    const quota = presentQuota(row, now)
    expect(quota).toMatchObject({
      used: row.used,
      remaining: row.remaining,
      scope: 'account',
      attributionMode: 'shared',
      freshness: 'fresh',
    })
    expect(quota).not.toHaveProperty('projectPercentage')
  })
  it('never promotes old user-supplied authoritative confidence to official provenance', () => {
    expect(
      presentQuota({ ...row, provenance_version: null, confidence: 'authoritative', source: 'provider' }, now),
    ).toMatchObject({
      confidence: 'unknown',
      sourceKind: 'unknown',
      scope: 'unknown',
      attributionMode: 'unknown',
      freshness: 'unknown',
    })
  })
  it('preserves stale observations but does not label missing or future freshness as current', () => {
    expect(presentQuota({ ...row, stale_at: now }, now).freshness).toBe('stale')
    expect(presentQuota({ ...row, stale_at: null }, now).freshness).toBe('unknown')
    expect(presentQuota({ ...row, observed_at: new Date(now.getTime() + 1) }, now).freshness).toBe('unknown')
  })
  it('unavailable telemetry never fabricates usable counts', () => {
    expect(presentQuota({ ...row, availability: 'unavailable' }, now)).toMatchObject({
      freshness: 'unavailable',
      used: null,
      remaining: null,
    })
  })
})
