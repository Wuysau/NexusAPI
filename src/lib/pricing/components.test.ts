import { describe, it, expect } from 'vitest'
import { computeUpstreamCost } from '../pricing'
import { toMicros, fromMicros } from '../money'
import {
  buildPriceRecord,
  componentAmount,
  componentsToCostPrice,
  costPriceToComponents,
  commonUnit,
  hasNonZeroAmount,
  relativeChangeExceeds,
  validateComponents,
  validatePriceRecord,
  type PriceComponent,
} from './components'
import { recomputeCharge, ROUNDING_VERSION } from './recompute'

const c = (kind: PriceComponent['kind'], amount: string, unit = 'per_million_tokens'): PriceComponent => ({
  kind,
  unit,
  amount,
  conditions: {},
})

describe('component validation', () => {
  it('requires at least one component', () => {
    const r = validateComponents([])
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('unit_undeterminable')
  })

  it('rejects unknown kinds, unknown units and malformed amounts', () => {
    expect(validateComponents([c('input', '1.5', 'per_banana')]).reasons).toContain('unit_undeterminable')
    expect(validateComponents([c('input', '-1')]).ok).toBe(false)
    expect(validateComponents([c('input', '1e3')]).ok).toBe(false)
    expect(
      validateComponents([
        { kind: 'nonsense' as PriceComponent['kind'], unit: 'per_token', amount: '1', conditions: {} },
      ]).ok,
    ).toBe(false)
  })

  it('rejects mixed units within one version', () => {
    const r = validateComponents([c('input', '2.5'), c('request', '0.01', 'per_request')])
    expect(r.ok).toBe(false)
    expect(commonUnit([c('input', '1'), c('output', '1')])).toBe('per_million_tokens')
    expect(commonUnit([c('input', '1'), c('request', '1', 'per_request')])).toBeNull()
  })
})

describe('component ↔ CostPrice mapping', () => {
  it('projects token components onto CostPrice and back', () => {
    const components = [c('input', '2.50'), c('cached_input', '1.25'), c('output', '10.00'), c('reasoning', '0')]
    const price = componentsToCostPrice(components, 'USD')
    expect(price.inputPrice).toBe('2.50')
    expect(price.cachedInputPrice).toBe('1.25')
    expect(price.outputPrice).toBe('10.00')
    expect(price.unit).toBe('per_million_tokens')

    const roundTrip = costPriceToComponents(price)
    expect(componentAmount(roundTrip, 'input')).toBe('2.50')
    expect(componentAmount(roundTrip, 'output')).toBe('10.00')
    // The four token rates are structurally part of CostPrice; a zero rate is
    // carried as "0", which diffs as unchanged. Non-token extras are omitted.
    expect(componentAmount(roundTrip, 'reasoning')).toBe('0')
    expect(roundTrip.find((x) => x.kind === 'request')).toBeUndefined()
  })

  it('carries non-token components through and charges them per unit', () => {
    const price = componentsToCostPrice([c('request', '0.50', 'per_request')], 'USD')
    expect(price.requestPrice).toBe('0.50')
    const cost = computeUpstreamCost(price, { input: 0, output: 0, cached: 0, reasoning: 0, requests: 3 })
    expect(cost).toBe(toMicros('1.50'))
  })

  it('detects a non-zero amount set', () => {
    expect(hasNonZeroAmount([c('input', '0'), c('output', '0')])).toBe(false)
    expect(hasNonZeroAmount([c('input', '0'), c('output', '0.000001')])).toBe(true)
  })
})

describe('relative change', () => {
  it('is exact and boundary-correct at 20%', () => {
    expect(relativeChangeExceeds('2.50', '3.00')).toBe(false) // exactly +20%
    expect(relativeChangeExceeds('2.50', '3.01')).toBe(true)
    expect(relativeChangeExceeds('10.00', '7.99')).toBe(true) // -20.1%
    expect(relativeChangeExceeds('2.50', '2.50')).toBe(false)
    expect(relativeChangeExceeds('0', '0')).toBe(false)
    expect(relativeChangeExceeds('0', '0.01')).toBe(true)
  })
})

describe('price record contract', () => {
  const source = {
    url: 'https://openai.com/api/pricing',
    retrieved_at: '2026-01-01T00:00:00.000Z',
    content_sha256: 'a'.repeat(64),
  }

  it('accepts a schema-conformant record', () => {
    const record = buildPriceRecord({
      provider: 'openai',
      modelId: 'gpt-4o',
      currency: 'USD',
      status: 'pending_approval',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      components: [c('input', '2.50'), c('output', '10.00')],
      source,
    })
    expect(validatePriceRecord(record)).toEqual({ ok: true, errors: [], reasons: [] })
    expect(record.schema_version).toBe(1)
    expect(record.effective_to).toBeNull()
  })

  it('rejects a bad currency, hash and component', () => {
    const bad = buildPriceRecord({
      provider: 'openai',
      modelId: 'gpt-4o',
      currency: 'usd',
      status: 'fetched',
      effectiveFrom: new Date(),
      components: [c('input', '2.50')],
      source: { ...source, content_sha256: 'not-a-hash' },
    })
    const r = validatePriceRecord(bad)
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('currency_unknown')
    expect(r.errors.some((e) => e.includes('content_sha256'))).toBe(true)
  })
})

describe('deterministic recompute', () => {
  const components = [c('input', '2.50'), c('output', '10.00')]
  const rule = {
    pricingMode: 'markup' as const,
    markupRate: '0.5',
    targetMarginRate: '0',
    fixedFee: '0',
    minimumCharge: '0',
    currency: 'USD',
  }
  const usage = { input: 1_000_000, output: 500_000, cached: 0, reasoning: 0 }

  it('re-derives the same charge from a pinned version, repeatedly', () => {
    const first = recomputeCharge({ priceVersionId: 'pv-1', components, currency: 'USD', usage, saleRule: rule })
    const second = recomputeCharge({ priceVersionId: 'pv-1', components, currency: 'USD', usage, saleRule: rule })
    expect(first.upstreamCostInCharge).toBe(toMicros('7.50'))
    expect(first.saleCharge).toBe(toMicros('11.25'))
    expect(first.grossMargin).toBe(toMicros('3.75'))
    expect(first.priceVersionId).toBe('pv-1')
    expect(first.roundingVersion).toBe(ROUNDING_VERSION)
    expect(fromMicros(second.saleCharge)).toBe(fromMicros(first.saleCharge))
  })

  it('is unaffected by a later price change (pinned version wins)', () => {
    const pinned = recomputeCharge({
      priceVersionId: 'pv-old',
      components: [c('input', '2.50'), c('output', '10.00')],
      currency: 'USD',
      usage,
      saleRule: rule,
    })
    // A newer version exists in the catalog, but the pinned recompute is unchanged.
    recomputeCharge({
      priceVersionId: 'pv-new',
      components: [c('input', '5.00'), c('output', '20.00')],
      currency: 'USD',
      usage,
      saleRule: rule,
    })
    expect(pinned.upstreamCostInCharge).toBe(toMicros('7.50'))
  })

  it('fails closed on an invalid pinned version', () => {
    expect(() =>
      recomputeCharge({ priceVersionId: 'pv-1', components: [], currency: 'USD', usage, saleRule: rule }),
    ).toThrow(/invalid_components/)
    expect(() => recomputeCharge({ priceVersionId: '', components, currency: 'USD', usage, saleRule: rule })).toThrow(
      /priceVersionId/,
    )
  })
})
