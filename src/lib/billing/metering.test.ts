import { describe, expect, it } from 'vitest'
import fixtures from '../../../tests/contract/fixtures/usage-event-v2.json'
import type { NexusUsageEventV1 } from '../../../packages/contracts/usage-event'
import type { NexusUsageEventV2 } from '../../../packages/contracts/usage-event-v2'
import { calculatorVersionFor, MeteringValidationError, normalizeMetering, parseBillingUsageEvent } from './metering'

const v2 = (): NexusUsageEventV2 => structuredClone(fixtures[0].event) as NexusUsageEventV2
const v1 = (): NexusUsageEventV1 => ({
  schema_version: 1,
  event_id: 'legacy-metering-event',
  occurred_at: '2026-09-16T00:00:00Z',
  tenant_id: 'tenant-a',
  request_id: 'request-a',
  attempt_id: 'attempt-a',
  model_id: 'model-a',
  status: 'completed',
  price_version_id: 'price-a',
  catalog_version_id: 'catalog-a',
  usage: { input_tokens: 100, output_tokens: 20, estimated: false },
})

describe('versioned billing metering', () => {
  it('bills four disjoint v2 buckets while retaining the inclusive observations', () => {
    const event = v2()
    const before = structuredClone(event)
    const result = normalizeMetering(event)
    expect(result).toMatchObject({
      known: true,
      version: 2,
      usage: { input: 50, output: 10, cached: 50, reasoning: 10 },
      canonical: event.usage,
      estimated: false,
    })
    expect(event).toEqual(before)
    expect(result.canonical).not.toBe(event.usage)
  })

  it.each(['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens'] as const)(
    'does not turn unknown %s into a billable zero even when total is observed',
    (field) => {
      const event = v2()
      event.usage[field] = null
      expect(normalizeMetering(event)).toMatchObject({
        known: false,
        version: 2,
        usage: null,
        canonical: { [field]: null, total_tokens: 120 },
      })
    },
  )

  it('allows unknown informational total when all billing counts are known', () => {
    const event = v2()
    event.usage.total_tokens = null
    const result = normalizeMetering(event)
    expect(result.known).toBe(true)
    expect(result.canonical.total_tokens).toBeNull()
  })

  it('preserves observed zero and fully cached/reasoning subsets', () => {
    const event = v2()
    event.usage = {
      input_tokens: 5,
      cached_input_tokens: 5,
      output_tokens: 7,
      reasoning_tokens: 7,
      total_tokens: 12,
      estimated: false,
    }
    expect(normalizeMetering(event).usage).toEqual({ input: 0, output: 0, cached: 5, reasoning: 7 })
    event.usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      estimated: false,
    }
    expect(normalizeMetering(event)).toMatchObject({
      known: true,
      usage: { input: 0, output: 0, cached: 0, reasoning: 0 },
    })
  })

  it('keeps v1 independent buckets and legacy missing-subset normalization', () => {
    const event = v1()
    expect(normalizeMetering(event)).toMatchObject({
      version: 1,
      known: true,
      usage: { input: 100, output: 20, cached: 0, reasoning: 0 },
      canonical: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: null,
        reasoning_tokens: null,
        total_tokens: null,
      },
    })
    event.usage.cached_input_tokens = 50
    event.usage.reasoning_tokens = 10
    expect(normalizeMetering(event).usage).toEqual({ input: 100, output: 20, cached: 50, reasoning: 10 })
  })

  it.each([false, true])('preserves estimated=%s without changing it from the completion status', (estimated) => {
    for (const event of [v1(), v2()]) {
      event.usage.estimated = estimated
      event.status = 'unknown'
      expect(normalizeMetering(event).estimated).toBe(estimated)
      expect(normalizeMetering(event).canonical.estimated).toBe(estimated)
    }
  })

  it.each([undefined, null, 0, 3, '2'])('strictly rejects unsupported version %s', (version) => {
    expect(() => parseBillingUsageEvent({ ...v2(), schema_version: version })).toThrow(MeteringValidationError)
    expect(() => normalizeMetering({ ...v2(), schema_version: version })).toThrow(MeteringValidationError)
  })

  it('validates canonical shape and subset/sum rules before normalizing', () => {
    for (const change of [
      (event: NexusUsageEventV2) => {
        event.usage.cached_input_tokens = 101
      },
      (event: NexusUsageEventV2) => {
        event.usage.reasoning_tokens = 21
      },
      (event: NexusUsageEventV2) => {
        event.usage.total_tokens = 999
      },
      (event: NexusUsageEventV2) => {
        event.usage.input_tokens = -1
      },
      (event: NexusUsageEventV2) => {
        event.usage.output_tokens = 0.5
      },
    ]) {
      const event = v2()
      change(event)
      expect(() => normalizeMetering(event)).toThrow(MeteringValidationError)
    }
    const missing = v2() as unknown as { usage: Record<string, unknown> }
    delete missing.usage.reasoning_tokens
    expect(() => parseBillingUsageEvent(missing)).toThrow(MeteringValidationError)
    expect(() => parseBillingUsageEvent({ ...v2(), extra: 'unknown' })).toThrow(MeteringValidationError)
  })

  it('provides stable calculator versions for replay', () => {
    expect(calculatorVersionFor(v1())).toBe('nexus-billing-pipeline-v2')
    expect(calculatorVersionFor(v2())).toBe('nexus-billing-inclusive-v3')
    expect(calculatorVersionFor(1)).toBe('nexus-billing-pipeline-v2')
    expect(calculatorVersionFor(2)).toBe('nexus-billing-inclusive-v3')
  })
})
