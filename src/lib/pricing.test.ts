import { describe, it, expect } from 'vitest'
import {
  computeCharge,
  computeUpstreamCost,
  applySaleRate,
  convertMicros,
  type CostPrice,
  type SaleRule,
  type ExchangeRate,
} from './pricing'
import { toMicros, fromMicros, charge, formatMicros } from './money'

const usd = (s: string) => toMicros(s)

const baseCost: CostPrice = {
  inputPrice: '2.50',
  outputPrice: '10.00',
  cachedInputPrice: '1.25',
  reasoningPrice: '0',
  unit: 'per_million_tokens',
  currency: 'USD',
}

describe('money', () => {
  it('round-trips decimal → micros → decimal at 6dp', () => {
    expect(fromMicros(toMicros('1.234567'))).toBe('1.234567')
    expect(fromMicros(toMicros('0.000001'))).toBe('0.000001')
  })
  it('rejects non-numeric input', () => {
    expect(() => toMicros('abc')).toThrow()
    expect(() => toMicros('')).toThrow()
  })
  it('formats to 2dp with currency symbol', () => {
    expect(formatMicros(toMicros('12.5'), 'USD')).toBe('$12.50')
    expect(formatMicros(toMicros('-3.004'), 'USD')).toBe('-$3.00')
  })
  it('charge converts per-million-token price × token count without float loss', () => {
    // $2.50 per 1M tokens, 1_000_000 tokens ⇒ $2.50 exactly
    expect(charge('2.50', 1_000_000, 1_000_000)).toBe(usd('2.50'))
    // $10 per 1M tokens, 500_000 tokens ⇒ $5.00
    expect(charge('10.00', 500_000, 1_000_000)).toBe(usd('5.00'))
  })
})

describe('pricing — upstream cost', () => {
  it('sums input + output + cached components', () => {
    const cost = computeUpstreamCost(baseCost, { input: 1_000_000, output: 500_000, cached: 1_000_000, reasoning: 0 })
    // 2.50 + 5.00 + 1.25 = 8.75
    expect(cost).toBe(usd('8.75'))
  })
  it('charges cached input at the cached rate, not full input rate', () => {
    const full = computeUpstreamCost(
      { ...baseCost, cachedInputPrice: '2.50' },
      { input: 0, output: 0, cached: 1_000_000, reasoning: 0 },
    )
    const cached = computeUpstreamCost(
      { ...baseCost, cachedInputPrice: '1.25' },
      { input: 0, output: 0, cached: 1_000_000, reasoning: 0 },
    )
    expect(cached).toBeLessThan(full)
    expect(cached).toBe(usd('1.25'))
  })
  it('adds reasoning tokens at the reasoning rate', () => {
    const c = computeUpstreamCost(
      { ...baseCost, reasoningPrice: '5.00' },
      { input: 0, output: 0, cached: 0, reasoning: 200_000 },
    )
    expect(c).toBe(usd('1.00'))
  })
})

describe('pricing — markup vs margin', () => {
  it('markup: sale = cost × (1 + markupRate)', () => {
    // cost rate 2.50, markup 0.5 ⇒ sale rate 3.75
    const saleRate = applySaleRate(usd('2.50'), {
      pricingMode: 'markup',
      markupRate: '0.5',
      targetMarginRate: '0',
      fixedFee: '0',
      minimumCharge: '0',
      currency: 'USD',
    })
    expect(saleRate).toBe(usd('3.75'))
  })
  it('cost_multiplier is an alias of markup', () => {
    const r = applySaleRate(usd('2.50'), {
      pricingMode: 'cost_multiplier',
      markupRate: '1',
      targetMarginRate: '0',
      fixedFee: '0',
      minimumCharge: '0',
      currency: 'USD',
    })
    expect(r).toBe(usd('5.00'))
  })
  it('target_margin: sale = cost / (1 - margin)', () => {
    // cost 2.50, margin 0.375 ⇒ sale = 2.50 / 0.625 = 4.00
    const r = applySaleRate(usd('2.50'), {
      pricingMode: 'target_margin',
      markupRate: '0',
      targetMarginRate: '0.375',
      fixedFee: '0',
      minimumCharge: '0',
      currency: 'USD',
    })
    expect(r).toBe(usd('4.00'))
  })
  it('target_margin 30% on $10 cost ⇒ $14.285714 (the documented default)', () => {
    const r = applySaleRate(usd('10.00'), {
      pricingMode: 'target_margin',
      markupRate: '0',
      targetMarginRate: '0.30',
      fixedFee: '0',
      minimumCharge: '0',
      currency: 'USD',
    })
    // 10 / 0.7 = 14.285714...
    expect(fromMicros(r)).toBe('14.285714')
  })
  it('rejects target margin >= 100%', () => {
    expect(() =>
      applySaleRate(usd('1.00'), {
        pricingMode: 'target_margin',
        markupRate: '0',
        targetMarginRate: '1',
        fixedFee: '0',
        minimumCharge: '0',
        currency: 'USD',
      }),
    ).toThrow()
  })
})

describe('pricing — full charge & margin', () => {
  const markupRule: SaleRule = {
    pricingMode: 'markup',
    markupRate: '0.5',
    targetMarginRate: '0',
    fixedFee: '0',
    minimumCharge: '0',
    currency: 'USD',
  }
  it('computes sale, cost, and gross margin in same currency', () => {
    // cost 8.75 (from upstream test), markup 0.5 ⇒ sale 13.125, margin 4.375
    const b = computeCharge(
      baseCost,
      markupRule,
      { input: 1_000_000, output: 500_000, cached: 1_000_000, reasoning: 0 },
      null,
    )
    expect(b.upstreamCostInCharge).toBe(usd('8.75'))
    expect(b.saleCharge).toBe(usd('13.125'))
    expect(b.grossMargin).toBe(usd('4.375'))
    // margin rate = 4.375/13.125 = 0.333333...
    expect(fromMicros(b.grossMarginRate)).toBe('0.333333')
  })
  it('applies minimum charge floor when sale is below it', () => {
    const rule: SaleRule = { ...markupRule, minimumCharge: '20.00' }
    const b = computeCharge(baseCost, rule, { input: 1_000, output: 1_000, cached: 0, reasoning: 0 }, null)
    expect(b.minimumApplied).toBe(true)
    expect(b.saleCharge).toBe(usd('20.00'))
  })
  it('fixed mode charges the fixed fee regardless of tokens', () => {
    const rule: SaleRule = {
      pricingMode: 'fixed',
      markupRate: '0',
      targetMarginRate: '0',
      fixedFee: '0.50',
      minimumCharge: '0',
      currency: 'USD',
    }
    const b = computeCharge(baseCost, rule, { input: 1_000_000, output: 5_000_000, cached: 0, reasoning: 0 }, null)
    expect(b.saleCharge).toBe(usd('0.50'))
    expect(b.fixedFee).toBe(usd('0.50'))
  })
})

describe('pricing — exchange rates', () => {
  const rate: ExchangeRate = { base: 'USD', quote: 'CNY', rate: '7.2' }
  it('converts micros across currencies using the rate', () => {
    // $10.00 → ¥72.00
    expect(convertMicros(usd('10.00'), 'USD', 'CNY', rate)).toBe(usd('72.00'))
  })
  it('is a no-op when currencies match', () => {
    expect(convertMicros(usd('10.00'), 'USD', 'USD', rate)).toBe(usd('10.00'))
  })
  it('fails closed on a mismatched rate direction', () => {
    const wrong: ExchangeRate = { base: 'EUR', quote: 'CNY', rate: '7.8' }
    expect(() => convertMicros(usd('10.00'), 'USD', 'CNY', wrong)).toThrow()
  })
  it('historical charges are unaffected by a later rate update', () => {
    const oldRate: ExchangeRate = { base: 'USD', quote: 'CNY', rate: '7.0' }
    const snapshot = convertMicros(usd('10.00'), 'USD', 'CNY', oldRate)
    const newRate: ExchangeRate = { base: 'USD', quote: 'CNY', rate: '7.5' }
    const fresh = convertMicros(usd('10.00'), 'USD', 'CNY', newRate)
    // The old snapshot must not change when a new rate arrives.
    expect(snapshot).toBe(usd('70.00'))
    expect(fresh).toBe(usd('75.00'))
    expect(snapshot).not.toBe(fresh)
  })
})

describe('pricing — context tiers (unit scale)', () => {
  it('per-token vs per-million-token units scale charges correctly', () => {
    const perToken: CostPrice = {
      ...baseCost,
      inputPrice: '0.0000025',
      outputPrice: '0.00001',
      unit: 'per_token',
      currency: 'USD',
    }
    const cPerToken = computeUpstreamCost(perToken, { input: 1_000_000, output: 0, cached: 0, reasoning: 0 })
    const cPerMillion = computeUpstreamCost(baseCost, { input: 1_000_000, output: 0, cached: 0, reasoning: 0 })
    expect(cPerToken).toBe(cPerMillion) // same physical cost
    expect(cPerMillion).toBe(usd('2.50'))
  })
})
