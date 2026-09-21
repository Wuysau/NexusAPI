// Historical recompute.
//
// A billed request pins an immutable price version. Given that pinned version's
// components and the recorded usage, this function re-derives the charge with
// the SAME library and the SAME rounding as the live billing path. Nothing here
// reads the clock, the database, or the current catalog: the result depends
// only on its arguments, so a disputed invoice line can be reproduced exactly,
// even after the price has been superseded.
//
// Acceptance: "same request recomputable by version ID + usage" (ADR-0003,
// DYNAMIC_CATALOG_PRICING.md) and "UI reference cost and final bill use the
// same calc lib + rounding".

import { computeCharge, type ChargeBreakdown, type ExchangeRate, type SaleRule, type TokenUsage } from '../pricing'
import { componentsToCostPrice, type PriceComponent, type ValidationResult, validateComponents } from './components'

/**
 * Rounding/conversion semantics of money.ts: exact integer micros, truncating
 * integer division (`(num * tokens * 1e6) / (den * scale)`). Bump this string —
 * and only this string — when that arithmetic changes, so stored recompute
 * results can be compared across releases.
 */
export const ROUNDING_VERSION = 'nexus-micros-int-v1'

export interface PinnedPriceVersion {
  id: string
  currency: string
  components: PriceComponent[]
}

export interface RecomputeInput {
  /** Immutable provider_price_versions id the request pinned. */
  priceVersionId: string
  components: PriceComponent[]
  currency: string
  usage: TokenUsage
  saleRule: SaleRule
  exchangeRate?: ExchangeRate | null
  roundingVersion?: string
}

export interface RecomputeResult extends ChargeBreakdown {
  priceVersionId: string
  roundingVersion: string
}

export class RecomputeError extends Error {
  constructor(
    public code: 'invalid_components' | 'invalid_input',
    message: string,
  ) {
    super(message)
    this.name = 'RecomputeError'
  }
}

/** Validate a pinned version without touching the DB. */
export function validatePinnedVersion(pinned: PinnedPriceVersion): ValidationResult {
  return validateComponents(pinned.components)
}

/**
 * Deterministic charge recomputation from a pinned version + usage.
 * Throws RecomputeError rather than returning a best-effort number: a bad
 * pinned version must surface, not silently produce a wrong charge.
 */
export function recomputeCharge(input: RecomputeInput): RecomputeResult {
  if (!input.priceVersionId) {
    throw new RecomputeError('invalid_input', 'recompute[invalid_input]: priceVersionId is required')
  }
  const validation = validateComponents(input.components)
  if (!validation.ok) {
    throw new RecomputeError('invalid_components', `recompute[invalid_components]: ${validation.errors.join('; ')}`)
  }
  const price = componentsToCostPrice(input.components, input.currency)
  const breakdown = computeCharge(price, input.saleRule, input.usage, input.exchangeRate ?? null)
  return {
    ...breakdown,
    priceVersionId: input.priceVersionId,
    roundingVersion: input.roundingVersion ?? ROUNDING_VERSION,
  }
}

export interface ReferenceCostInput {
  priceVersionId: string
  currency: string
  components: PriceComponent[]
  usage: TokenUsage
  saleRule: SaleRule
  exchangeRate?: ExchangeRate | null
}

/**
 * Console "reference cost" — the exact same computation the bill uses, so the
 * number shown before a request matches the number charged after it.
 */
export function referenceCost(input: ReferenceCostInput): RecomputeResult {
  return recomputeCharge(input)
}
