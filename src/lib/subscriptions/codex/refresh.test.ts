import { describe, expect, it } from 'vitest'
import { quotaRefreshInterval } from './refresh'

const bucket = (used: string | null, limitId = 'codex', window = 'primary') => ({
  used,
  metadata: { limitId, window },
})

describe('upstream Codex quota refresh policy', () => {
  it.each([
    ['0', 60000],
    ['74.99', 60000],
    ['75', 30000],
    ['89.99', 30000],
    ['90', 15000],
    ['98.99', 15000],
    ['99', 5000],
    ['100', 5000],
  ])('uses the upstream cadence for %s percent', (used, expected) => {
    expect(quotaRefreshInterval([bucket(used)])).toBe(expected)
  })
  it('includes secondary windows but ignores unrelated model and unknown windows', () => {
    expect(quotaRefreshInterval([bucket('2'), bucket('90', 'codex', 'secondary')])).toBe(15000)
    expect(quotaRefreshInterval([bucket('2'), bucket('100', 'model-bucket'), bucket('100', 'codex', 'other')])).toBe(
      60000,
    )
  })
  it('keeps unknown and malformed values unknown with a bounded retry interval', () => {
    expect(quotaRefreshInterval([])).toBe(60000)
    expect(quotaRefreshInterval([bucket(null), bucket('NaN'), bucket('Infinity')])).toBe(60000)
    expect(quotaRefreshInterval([bucket('99', 'default')])).toBe(5000)
  })
})
