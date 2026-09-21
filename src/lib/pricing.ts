// Pricing engine. Pure functions, bigint micros only. No floating point.
//
// Two distinct operations the spec requires us to keep separate:
//   - UPSTREAM COST: what the provider charges us (from provider_price_versions)
//   - SALE PRICE: what we charge the user (from sale_price_rules + snapshot)
//
// Pricing modes (note the markup vs margin distinction):
//   markup / cost_multiplier: sale = cost * (1 + markupRate)
//   target_margin:              sale = cost / (1 - targetMarginRate)
//   fixed:                      sale = fixedFee per request (cost still tracked)

import { toMicros, fromMicros, charge, MICROS_PER_UNIT, parseDecimal, type Micros } from './money'

export interface CostPrice {
  inputPrice: string
  outputPrice: string
  cachedInputPrice: string
  reasoningPrice: string
  unit: string // per_million_tokens | per_token | per_request | per_image
  currency: string
  // Non-token components (dynamic catalog v1). Optional so the token-only
  // projection used by the legacy unit tests stays valid. Charged per unit
  // count (requests / images / seconds / GB-months), not per token.
  requestPrice?: string
  imagePrice?: string
  audioPrice?: string
  storagePrice?: string
}
export type SalePricingMode = 'cost_multiplier' | 'target_margin' | 'fixed' | 'markup'
export interface SaleRule {
  pricingMode: SalePricingMode
  markupRate: string // dimensionless ratio, e.g. "0.5"
  targetMarginRate: string // dimensionless ratio, e.g. "0.3"
  fixedFee: string // currency, per request (mode=fixed)
  minimumCharge: string // currency, floor on sale
  currency: string
}
export interface TokenUsage {
  /** Versioned billable projection: zero reasoning rate prices inclusive output. */
  inclusiveOutputRate?: true
  input: number
  output: number
  cached: number
  reasoning: number
  // Optional non-token usage counts (dynamic catalog v1). Absent ⇒ 0.
  requests?: number
  images?: number
  audioSeconds?: number
  storageGbMonths?: number
}
export interface ExchangeRate {
  base: string
  quote: string
  rate: string
} // 1 base = rate quote

export function unitScale(unit: string): number {
  switch (unit) {
    case 'per_token':
      return 1
    case 'per_million_tokens':
      return 1_000_000
    case 'per_request':
      return 1
    case 'per_image':
      return 1
    default:
      return 1_000_000
  }
}

/** Upstream cost in the provider's currency, micros. Uses exact integer math. */
export function computeUpstreamCost(price: CostPrice, u: TokenUsage): Micros {
  const scale = unitScale(price.unit)
  const inclusiveOutput = u.inclusiveOutputRate && parseDecimal(price.reasoningPrice).num === 0n
  // Non-token components are charged per unit count (scale 1) regardless of
  // the token unit: a "per_request" or "per_image" rate is already per unit.
  return (
    charge(price.inputPrice, u.input, scale) +
    charge(price.outputPrice, u.output + (inclusiveOutput ? u.reasoning : 0), scale) +
    charge(price.cachedInputPrice, u.cached, scale) +
    charge(price.reasoningPrice, u.reasoning, scale) +
    charge(price.requestPrice ?? '0', u.requests ?? 0, 1) +
    charge(price.imagePrice ?? '0', u.images ?? 0, 1) +
    charge(price.audioPrice ?? '0', u.audioSeconds ?? 0, 1) +
    charge(price.storagePrice ?? '0', u.storageGbMonths ?? 0, 1)
  )
}

/** Apply a sale rule to a single per-unit cost rate, returning a per-unit sale rate (micros). */
export function applySaleRate(costRateMicros: Micros, rule: SaleRule): Micros {
  switch (rule.pricingMode) {
    case 'cost_multiplier':
    case 'markup': {
      const markupMicros = toMicros(rule.markupRate) // ratio as micros
      // sale = cost * (1 + markup) = cost * (MICROS + markupMicros) / MICROS
      return (costRateMicros * (MICROS_PER_UNIT + markupMicros)) / MICROS_PER_UNIT
    }
    case 'target_margin': {
      const marginMicros = toMicros(rule.targetMarginRate)
      if (marginMicros >= MICROS_PER_UNIT) throw new Error('pricing: target margin >= 100%')
      // sale = cost / (1 - margin) = cost * MICROS / (MICROS - marginMicros)
      return (costRateMicros * MICROS_PER_UNIT) / (MICROS_PER_UNIT - marginMicros)
    }
    case 'fixed':
      // Fixed mode charges the fixed fee per request; per-unit rate unused.
      return 0n
  }
}

export interface ChargeBreakdown {
  upstreamCost: Micros // provider currency
  upstreamCostInCharge: Micros // charge currency (converted)
  saleCharge: Micros // charge currency (what we debit)
  fixedFee: Micros
  minimumApplied: boolean
  grossMargin: Micros // sale - cost (charge currency)
  grossMarginRate: Micros // margin / sale, as micros-of-ratio
  saleRates: { input: Micros; output: Micros; cachedInput: Micros; reasoning: Micros }
}

/**
 * Full charge computation for a request.
 * - Converts upstream cost to charge currency using `rate` (if currencies differ).
 * - Computes sale charge per the rule.
 * - Applies minimum-charge floor.
 * - Derives gross margin.
 */
export function computeCharge(
  price: CostPrice,
  rule: SaleRule,
  u: TokenUsage,
  rate: ExchangeRate | null,
): ChargeBreakdown {
  const upstreamCost = computeUpstreamCost(price, u)
  const upstreamCostInCharge = convertMicros(upstreamCost, price.currency, rule.currency, rate)

  // Sale charge is derived from the aggregate cost so markup/margin stay exact
  // (per-component rates below are best-effort for the snapshot, not charging).
  let saleCharge: Micros
  if (rule.pricingMode === 'fixed') {
    saleCharge = toMicros(rule.fixedFee)
  } else {
    saleCharge = applySaleRate(upstreamCostInCharge, rule)
  }

  const minMicros = toMicros(rule.minimumCharge)
  const minimumApplied = saleCharge < minMicros && minMicros > 0n
  if (minimumApplied) saleCharge = minMicros

  const grossMargin = saleCharge - upstreamCostInCharge
  const grossMarginRate = saleCharge > 0n ? (grossMargin * MICROS_PER_UNIT) / saleCharge : 0n

  // Per-component sale rates for the immutable snapshot (best-effort micros;
  // the authoritative charge above is exact).
  const costRate = (r: string) => toMicros(r)
  const saleInput = rule.pricingMode === 'fixed' ? 0n : applySaleRate(costRate(price.inputPrice), rule)
  const saleOutput = rule.pricingMode === 'fixed' ? 0n : applySaleRate(costRate(price.outputPrice), rule)
  const saleCached = rule.pricingMode === 'fixed' ? 0n : applySaleRate(costRate(price.cachedInputPrice), rule)
  const saleReasoning = rule.pricingMode === 'fixed' ? 0n : applySaleRate(costRate(price.reasoningPrice), rule)

  return {
    upstreamCost,
    upstreamCostInCharge,
    saleCharge,
    fixedFee: rule.pricingMode === 'fixed' ? toMicros(rule.fixedFee) : 0n,
    minimumApplied,
    grossMargin,
    grossMarginRate,
    saleRates: { input: saleInput, output: saleOutput, cachedInput: saleCached, reasoning: saleReasoning },
  }
}

/** Convert micros from one currency to another using a rate (1 from = rate to). */
export function convertMicros(
  amount: Micros,
  fromCurrency: string,
  toCurrency: string,
  rate: ExchangeRate | null,
): Micros {
  if (fromCurrency === toCurrency) return amount
  if (!rate) throw new Error('pricing: missing directed exchange rate')
  if (rate.base !== fromCurrency || rate.quote !== toCurrency) {
    // Caller must supply the matching direction; otherwise fail closed.
    throw new Error(`pricing: rate ${rate.base}/${rate.quote} does not match ${fromCurrency}->${toCurrency}`)
  }
  const rateMicros = toMicros(rate.rate) // e.g. 7.2 CNY/USD → 7200000 micros
  if (rateMicros <= 0n) throw new Error('pricing: exchange rate must be positive')
  return (amount * rateMicros) / MICROS_PER_UNIT
}

/** Serialize a micros rate to a numeric string for storage in a snapshot. */
export function microsToRate(m: Micros): string {
  return fromMicros(m)
}
