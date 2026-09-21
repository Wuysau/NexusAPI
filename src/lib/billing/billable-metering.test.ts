import { expect, it } from 'vitest'
import fixtures from '../../../tests/contract/fixtures/usage-event-v2.json'
import type { NexusUsageEventV2 } from '../../../packages/contracts/usage-event-v2'
import type { PinnedPricing } from './pipeline'
import { deriveBillableMetering, normalizeMetering } from './metering'
import { computeUpstreamCost } from '../pricing'
import { componentsToCostPrice } from '../pricing/components'

function event(reasoning: number | null = null): NexusUsageEventV2 {
  return {
    ...(structuredClone(fixtures[0].event) as NexusUsageEventV2),
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0,
      reasoning_tokens: reasoning,
      total_tokens: null,
      estimated: false,
      semantics: 'anthropic-inclusive-v1',
      cache_creation_input_tokens: 0,
    },
  }
}
function pricing(reasoning = '0'): PinnedPricing {
  return {
    priceVersionId: 'p',
    providerCurrency: 'USD',
    chargeCurrency: 'USD',
    components: [
      ['input', '2'],
      ['output', '10'],
      ['cached_input', '1'],
      ['reasoning', reasoning],
    ].map(([kind, amount]) => ({
      kind,
      amount,
      unit: 'per_million_tokens',
      conditions: {},
    })) as PinnedPricing['components'],
    cacheWritePrice: '2',
    saleSnapshot: null,
    saleRuleId: null,
    saleRuleSource: 'byok_provider_cost',
    exchangeRate: null,
    exchangeRateSnapshotId: null,
  }
}
it.each([null, 0, 7])('preserves reasoning=%s and bills inclusive output exactly once at its rate', (reasoning) => {
  const e = event(reasoning),
    p = pricing()
  const result = deriveBillableMetering(e, p)
  expect(result.known).toBe(true)
  expect(result.canonical.reasoning_tokens).toBe(reasoning)
  expect(e.usage.reasoning_tokens).toBe(reasoning)
  expect(computeUpstreamCost(componentsToCostPrice(p.components, 'USD'), result.usage!)).toBe(400n)
  expect(normalizeMetering(e).known).toBe(reasoning !== null)
})
it('requires unknown reasoning for a nonzero independent price and uses disjoint known counts', () => {
  const p = pricing('4')
  expect(deriveBillableMetering(event(), p).known).toBe(false)
  const result = deriveBillableMetering(event(7), p)
  expect(computeUpstreamCost(componentsToCostPrice(p.components, 'USD'), result.usage!)).toBe(358n)
})
it.each(['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_creation_input_tokens'] as const)(
  'missing required %s cannot settle',
  (field) => {
    const e = event()
    e.usage[field] = null
    expect(deriveBillableMetering(e, pricing()).known).toBe(false)
  },
)
it('counts cache reads and creations once and rejects an unsupported distinct cache-write rate', () => {
  const e = event(),
    p = pricing()
  Object.assign(e.usage, { input_tokens: 115, cached_input_tokens: 10, cache_creation_input_tokens: 5 })
  const result = deriveBillableMetering(e, p)
  expect(computeUpstreamCost(componentsToCostPrice(p.components, 'USD'), result.usage!)).toBe(420n)
  expect(deriveBillableMetering(e, { ...p, cacheWritePrice: '2.5' }).known).toBe(false)
  expect(deriveBillableMetering(e, { ...p, cacheWritePrice: undefined }).known).toBe(false)
})
it('checks the frozen sale reasoning price independently from provider pricing', () => {
  const p = pricing()
  p.saleSnapshot = {
    id: 's',
    ruleId: 'r',
    providerPriceVersionId: 'p',
    exchangeRateSnapshotId: null,
    pricingMode: 'markup',
    inputPrice: '2',
    outputPrice: '10',
    cachedInputPrice: '1',
    reasoningPrice: '3',
    fixedFee: '0',
    minimumCharge: '0',
    currency: 'USD',
  }
  expect(deriveBillableMetering(event(), p).known).toBe(false)
  expect(deriveBillableMetering(event(7), p).known).toBe(true)
  p.saleSnapshot.pricingMode = 'fixed'
  expect(deriveBillableMetering(event(), p).known).toBe(true)
})
it('does not upgrade old events or other provider semantics', () => {
  const e = event()
  delete e.usage.semantics
  delete e.usage.cache_creation_input_tokens
  expect(deriveBillableMetering(e, pricing()).known).toBe(false)
})
