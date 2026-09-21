import { expect, it } from 'vitest'
import { computeChargeFromSnapshot, insertSaleSnapshot, type SaleSnapshotRow } from '@/lib/catalog/sale-snapshot'
import { convertMicros } from '@/lib/pricing'
import type { PoolClient } from 'pg'

const snapshot = {
  id: 'sale',
  ruleId: 'rule',
  providerPriceVersionId: 'price',
  exchangeRateSnapshotId: 'fx',
  pricingMode: 'markup',
  inputPrice: '2',
  outputPrice: '4',
  cachedInputPrice: '1',
  reasoningPrice: '3',
  fixedFee: '0',
  minimumCharge: '0',
  currency: 'CNY',
  providerCurrency: 'USD',
  rateCurrency: 'USD',
  provenanceVersion: 'provider-rates-v1',
} as SaleSnapshotRow
const rate = { base: 'USD', quote: 'CNY', rate: '7.2' }
const usage = { input: 1_000_000, output: 0, cached: 0, reasoning: 0 }
it('converts provider-denominated sale rates once and applies the rule-currency floor', () => {
  expect(computeChargeFromSnapshot(snapshot, usage, rate, 'CNY').saleCharge).toBe(14_400_000n)
  expect(computeChargeFromSnapshot({ ...snapshot, minimumCharge: '20' }, usage, rate, 'CNY').saleCharge).toBe(
    20_000_000n,
  )
  expect(
    computeChargeFromSnapshot({ ...snapshot, pricingMode: 'fixed', fixedFee: '3' }, usage, rate, 'CNY').saleCharge,
  ).toBe(3_000_000n)
})
it('rejects missing, reverse, zero and negative directed FX even for zero usage', () => {
  for (const fx of [null, { ...rate, base: 'CNY', quote: 'USD' }, { ...rate, rate: '0' }, { ...rate, rate: '-1' }]) {
    expect(() => convertMicros(0n, 'USD', 'CNY', fx)).toThrow()
    expect(() => computeChargeFromSnapshot(snapshot, usage, fx, 'CNY')).toThrow()
  }
})
it('quarantines ambiguous legacy cross-currency rates but preserves legacy same-currency', () => {
  const legacy = { ...snapshot, provenanceVersion: null, rateCurrency: null }
  expect(() => computeChargeFromSnapshot(legacy, usage, rate, 'CNY')).toThrow(/provenance/)
  expect(() => computeChargeFromSnapshot({ ...legacy, providerCurrency: null }, usage, null, 'CNY')).toThrow(
    /provenance/,
  )
  expect(computeChargeFromSnapshot({ ...legacy, currency: 'USD' }, usage, null, 'USD').saleCharge).toBe(2_000_000n)
})
it('rejects incompatible provenance and settlement currency', () => {
  expect(() => computeChargeFromSnapshot({ ...snapshot, rateCurrency: 'EUR' }, usage, rate, 'CNY')).toThrow()
  expect(() => computeChargeFromSnapshot(snapshot, usage, rate, 'USD')).toThrow()
})

it('publishes eight-decimal rates without first truncating them to money micros', async () => {
  const client = { query: async () => ({ rows: [{ id: 'published' }] }) } as unknown as PoolClient
  for (const [mode, markup, margin, expected] of [
    ['markup', '0', '0', '0.00000001'],
    ['markup', '1', '0', '0.00000002'],
    ['target_margin', '0', '0.5', '0.00000002'],
    ['fixed', '0', '0', '0.00000000'],
  ] as const) {
    const published = await insertSaleSnapshot(client, {
      ruleId: 'rule',
      providerPriceVersionId: 'price',
      providerCurrency: 'USD',
      components: [{ kind: 'input', amount: '0.00000001', unit: 'per_million_tokens', conditions: {} }],
      rule: {
        pricingMode: mode,
        markupRate: markup,
        targetMarginRate: margin,
        fixedFee: '0',
        minimumCharge: '0',
        currency: 'CNY',
      },
      exchangeRate: rate,
      exchangeRateSnapshotId: 'fx',
    })
    expect(published.inputPrice).toBe(expected)
    expect(computeChargeFromSnapshot(published, { ...usage, input: 100_000_000 }, rate, 'CNY').saleCharge).toBe(
      mode === 'fixed' ? 0n : mode === 'markup' && markup === '0' ? 7n : 14n,
    )
    expect(
      computeChargeFromSnapshot({ ...published, currency: 'USD' }, { ...usage, input: 100_000_000 }, null, 'USD')
        .saleCharge,
    ).toBe(mode === 'fixed' ? 0n : mode === 'markup' && markup === '0' ? 1n : 2n)
  }
  for (const mode of ['markup', 'target_margin'] as const) {
    const published = await insertSaleSnapshot(client, {
      ruleId: 'rule',
      providerPriceVersionId: 'price',
      providerCurrency: 'USD',
      components: [{ kind: 'input', amount: '1', unit: 'per_million_tokens', conditions: {} }],
      rule: {
        pricingMode: mode,
        markupRate: '0.00000001',
        targetMarginRate: '0.00000001',
        fixedFee: '0',
        minimumCharge: '0',
        currency: 'USD',
      },
      exchangeRate: null,
      exchangeRateSnapshotId: null,
    })
    expect(published.inputPrice).toBe('1.00000001')
  }
})
