import { validateUsageEvent, type NexusUsageEventV1 } from '../../../packages/contracts/usage-event'
import {
  validateUsageEventV2,
  type NexusUsageEventV2,
  type UsageEventUsageV2,
} from '../../../packages/contracts/usage-event-v2'
import type { TokenUsage } from '../pricing'
import type { PinnedPricing } from './pipeline'
import { parseDecimal } from '../money'

export type BillingUsageEvent = NexusUsageEventV1 | NexusUsageEventV2
export type CanonicalMetering = UsageEventUsageV2
export const V1_CALCULATOR_VERSION = 'nexus-billing-pipeline-v2'
export const V2_CALCULATOR_VERSION = 'nexus-billing-inclusive-v3'
export const ANTHROPIC_CALCULATOR_VERSION = 'nexus-billing-anthropic-v4'

export class MeteringValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`Invalid usage event: ${errors.join('; ')}`)
    this.name = 'MeteringValidationError'
  }
}

export type MeteringResult =
  | {
      known: true
      version: 1 | 2
      usage: TokenUsage
      canonical: CanonicalMetering
      estimated: boolean
    }
  | {
      known: false
      version: 2
      usage: null
      canonical: CanonicalMetering
      estimated: boolean
    }

/** Validate before narrowing; unsupported versions never fall back to v1. */
export function parseBillingUsageEvent(value: unknown): BillingUsageEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MeteringValidationError(['event must be an object'])
  }
  const version = (value as { schema_version?: unknown }).schema_version
  const validation =
    version === 1
      ? validateUsageEvent(value)
      : version === 2
        ? validateUsageEventV2(value)
        : { ok: false, errors: ['unsupported schema_version'] }
  if (!validation.ok) throw new MeteringValidationError(validation.errors)
  return value as BillingUsageEvent
}

export function calculatorVersionFor(eventOrVersion: BillingUsageEvent | 1 | 2): string {
  if (
    typeof eventOrVersion !== 'number' &&
    eventOrVersion.schema_version === 2 &&
    eventOrVersion.usage.semantics === 'anthropic-inclusive-v1'
  )
    return ANTHROPIC_CALCULATOR_VERSION
  const version = typeof eventOrVersion === 'number' ? eventOrVersion : eventOrVersion.schema_version
  if (version === 1) return V1_CALCULATOR_VERSION
  if (version === 2) return V2_CALCULATOR_VERSION
  throw new MeteringValidationError(['unsupported schema_version'])
}

/**
 * Derive pricing buckets without changing provider observations. `known` only
 * describes metering completeness; the settlement pipeline must still enforce
 * completion status, attribution, pinned pricing and estimated-usage policy.
 */
export function normalizeMetering(value: unknown): MeteringResult {
  const event = parseBillingUsageEvent(value)
  const observed = event.usage
  const canonical: CanonicalMetering = {
    ...(event.schema_version === 2 ? event.usage : {}),
    input_tokens: observed.input_tokens,
    output_tokens: observed.output_tokens,
    cached_input_tokens: observed.cached_input_tokens ?? null,
    reasoning_tokens: observed.reasoning_tokens ?? null,
    total_tokens: event.schema_version === 2 ? event.usage.total_tokens : null,
    estimated: observed.estimated,
  }

  if (event.schema_version === 1) {
    return {
      known: true,
      version: 1,
      canonical,
      estimated: event.usage.estimated,
      usage: {
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
        cached: event.usage.cached_input_tokens ?? 0,
        reasoning: event.usage.reasoning_tokens ?? 0,
      },
    }
  }

  const {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    reasoning_tokens: reasoning,
  } = event.usage
  if (input === null || output === null || cached === null || reasoning === null) {
    return { known: false, version: 2, canonical, estimated: event.usage.estimated, usage: null }
  }
  return {
    known: true,
    version: 2,
    canonical,
    estimated: event.usage.estimated,
    usage: { input: input - cached, output: output - reasoning, cached, reasoning },
  }
}

/** Price-aware projection. Numeric zero here means no separately billed bucket,
 * never an observed zero. The canonical event is kept unchanged for analytics.
 */
export function deriveBillableMetering(value: unknown, pricing: PinnedPricing): MeteringResult {
  const event = parseBillingUsageEvent(value)
  const observed = normalizeMetering(event)
  if (event.schema_version !== 2 || event.usage.semantics !== 'anthropic-inclusive-v1') return observed
  const u = event.usage
  const unknown = (): MeteringResult => ({ ...observed, known: false, version: 2, usage: null })
  if (
    u.input_tokens === null ||
    u.output_tokens === null ||
    u.cached_input_tokens === null ||
    u.cache_creation_input_tokens == null
  )
    return unknown()
  if (u.cache_creation_input_tokens > u.input_tokens - u.cached_input_tokens) return unknown()
  const rate = (kind: string) => pricing.components.find((c) => c.kind === kind)?.amount
  const inputRate = rate('input'),
    reasoningRate = rate('reasoning'),
    outputRate = rate('output')
  if (inputRate === undefined || reasoningRate === undefined || outputRate === undefined) return unknown()
  // Existing sale snapshots have only one non-read input bucket. Never hide an
  // independent cache-write price in that bucket.
  if (u.cache_creation_input_tokens > 0) {
    if (pricing.cacheWritePrice === undefined) return unknown()
    const write = parseDecimal(pricing.cacheWritePrice),
      input = parseDecimal(inputRate)
    if (write.num * input.den !== input.num * write.den) return unknown()
  }
  const needsReasoning =
    parseDecimal(reasoningRate).num !== 0n ||
    (pricing.saleSnapshot !== null &&
      pricing.saleSnapshot.pricingMode !== 'fixed' &&
      parseDecimal(pricing.saleSnapshot.reasoningPrice).num !== 0n)
  if (needsReasoning && u.reasoning_tokens === null) return unknown()
  const reasoning = u.reasoning_tokens ?? 0
  return {
    ...observed,
    known: true,
    version: 2,
    usage: {
      input: u.input_tokens - u.cached_input_tokens,
      cached: u.cached_input_tokens,
      output: u.output_tokens - reasoning,
      reasoning,
      inclusiveOutputRate: true,
    },
  }
}
