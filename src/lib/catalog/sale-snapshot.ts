// Sale-price snapshot creation and loading.
//
// INVARIANT #4: "every billed request binds an immutable price/catalog/policy
// version". The sale_price_snapshots row freezes the per-unit sale rates that
// were derived from the active sale_price_rules + the provider price version +
// the latest exchange rate at activation time. A request that pins this row can
// recompute its charge identically even after the rule, the price version or the
// FX rate has changed.
//
// The snapshot stores per-unit rates after markup/margin in provider currency,
// not the rule parameters. This is deliberate: a historical charge must be
// reproducible from the snapshot alone, without resolving the rule that was
// active at the time. The pricing_mode and fixed_fee/minimum_charge are carried
// so the charge path can apply the fixed-mode and minimum-charge floors.

import type { PoolClient } from 'pg'
import {
  computeUpstreamCost,
  convertMicros,
  type CostPrice,
  type ExchangeRate,
  type SaleRule,
  type TokenUsage,
} from '@/lib/pricing'
import { componentsToCostPrice, type PriceComponent } from '@/lib/pricing/components'
import { parseDecimal, toMicros, type Micros } from '@/lib/money'

export interface SaleSnapshotRow {
  id: string
  ruleId: string
  providerPriceVersionId: string
  exchangeRateSnapshotId: string | null
  pricingMode: string
  inputPrice: string
  outputPrice: string
  cachedInputPrice: string
  reasoningPrice: string
  fixedFee: string
  minimumCharge: string
  currency: string
  providerCurrency?: string | null
  rateCurrency?: string | null
  provenanceVersion?: string | null
}

export interface SaleSnapshotInput {
  ruleId: string
  providerPriceVersionId: string
  components: PriceComponent[]
  providerCurrency: string
  rule: SaleRule
  exchangeRate: ExchangeRate | null
  exchangeRateSnapshotId: string | null
}

/**
 * Compute the settled per-unit sale rates from a cost price version + a sale
 * rule + an exchange rate, then insert a sale_price_snapshots row.
 *
 * New provenance uses exact rational markup/margin, truncating rates only at
 * the database's eight-decimal boundary. Historical snapshots are not rewritten.
 */
export async function insertSaleSnapshot(client: PoolClient, input: SaleSnapshotInput): Promise<SaleSnapshotRow> {
  if (input.providerCurrency !== input.rule.currency && !input.exchangeRateSnapshotId)
    throw new Error('pricing: missing exchange snapshot pin')
  const costPrice = componentsToCostPrice(input.components, input.providerCurrency)
  convertMicros(0n, input.providerCurrency, input.rule.currency, input.exchangeRate)
  const unitMultiplier = costPrice.unit === 'per_token' ? 1_000_000n : 1n
  const inputPrice = publishedRate(costPrice.inputPrice, input.rule, unitMultiplier)
  const outputPrice = publishedRate(costPrice.outputPrice, input.rule, unitMultiplier)
  const cachedInputPrice = publishedRate(costPrice.cachedInputPrice, input.rule, unitMultiplier)
  const reasoningPrice = publishedRate(costPrice.reasoningPrice, input.rule, unitMultiplier)

  const fixedFee = input.rule.pricingMode === 'fixed' ? input.rule.fixedFee : '0'
  const minimumCharge = input.rule.minimumCharge
  const currency = input.rule.currency

  const result = await client.query<{ id: string }>(
    `INSERT INTO sale_price_snapshots
       (id, rule_id, provider_price_version_id, exchange_rate_snapshot_id, pricing_mode,
        input_price, output_price, cached_input_price, reasoning_price,
        fixed_fee, minimum_charge, currency, provider_currency, rate_currency, provenance_version)
     VALUES (gen_random_uuid(), $1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, 'provider-rates-v1')
     RETURNING id`,
    [
      input.ruleId,
      input.providerPriceVersionId,
      input.exchangeRateSnapshotId ?? '',
      input.rule.pricingMode,
      inputPrice,
      outputPrice,
      cachedInputPrice,
      reasoningPrice,
      fixedFee,
      minimumCharge,
      currency,
      input.providerCurrency,
    ],
  )

  return {
    id: result.rows[0].id,
    ruleId: input.ruleId,
    providerPriceVersionId: input.providerPriceVersionId,
    exchangeRateSnapshotId: input.exchangeRateSnapshotId,
    pricingMode: input.rule.pricingMode,
    inputPrice,
    outputPrice,
    cachedInputPrice,
    reasoningPrice,
    fixedFee,
    minimumCharge,
    currency,
    providerCurrency: input.providerCurrency,
    rateCurrency: input.providerCurrency,
    provenanceVersion: 'provider-rates-v1',
  }
}

/** Load a sale_price_snapshots row by id. Returns null when not found. */
export async function loadSaleSnapshot(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  snapshotId: string,
): Promise<SaleSnapshotRow | null> {
  const result = await client.query<SaleSnapshotRow>(
    `SELECT s.id, rule_id AS "ruleId", provider_price_version_id AS "providerPriceVersionId",
            exchange_rate_snapshot_id AS "exchangeRateSnapshotId", pricing_mode AS "pricingMode",
            s.input_price AS "inputPrice", s.output_price AS "outputPrice", s.cached_input_price AS "cachedInputPrice",
            s.reasoning_price AS "reasoningPrice", fixed_fee AS "fixedFee", minimum_charge AS "minimumCharge", s.currency,
            COALESCE(to_jsonb(s)->>'provider_currency',p.currency) AS "providerCurrency", to_jsonb(s)->>'rate_currency' AS "rateCurrency", to_jsonb(s)->>'provenance_version' AS "provenanceVersion"
       FROM sale_price_snapshots s JOIN provider_price_versions p ON p.id=s.provider_price_version_id WHERE s.id = $1 LIMIT 1`,
    [snapshotId],
  )
  return result.rows[0] ?? null
}

/** Load an exchange_rate_snapshots row by id. Returns null when not found. */
export async function loadExchangeRateSnapshot(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  snapshotId: string,
): Promise<ExchangeRate | null> {
  const result = await client.query<{ base_currency: string; quote_currency: string; rate: string }>(
    `SELECT base_currency, quote_currency, rate FROM exchange_rate_snapshots WHERE id = $1 LIMIT 1`,
    [snapshotId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { base: row.base_currency, quote: row.quote_currency, rate: row.rate }
}

/**
 * Compute the authoritative charge from a pinned sale_price_snapshot.
 *
 * The snapshot stores settled per-unit sale rates (after markup/margin). To
 * compute the charge we use computeUpstreamCost with the settled rates as the
 * "cost" — this applies the same charge() math (exact integer micros) without
 * re-deriving the markup. Currency conversion and minimum-charge floor are
 * applied on top, using the same convertMicros and toMicros helpers as the live
 * path.
 */
export function computeChargeFromSnapshot(
  snapshot: SaleSnapshotRow,
  usage: TokenUsage,
  rate: ExchangeRate | null,
  chargeCurrency: string,
): { saleCharge: Micros } {
  validateSaleSnapshotProvenance(snapshot, rate, chargeCurrency)
  // Fixed mode: the charge is the fixed fee per request, floored by the
  // minimum charge. No per-unit computation.
  if (snapshot.pricingMode === 'fixed') {
    let saleCharge = toMicros(snapshot.fixedFee)
    const minMicros = toMicros(snapshot.minimumCharge)
    if (minMicros > 0n && saleCharge < minMicros) saleCharge = minMicros
    // Convert if the snapshot currency differs from the charge currency.
    saleCharge = convertMicros(saleCharge, snapshot.currency, chargeCurrency, rate)
    return { saleCharge }
  }

  // Markup/margin/cost_multiplier: the snapshot rates are already settled.
  // Use them directly as per-unit rates to compute the charge.
  const saleCostPrice: CostPrice = {
    inputPrice: snapshot.inputPrice,
    outputPrice: snapshot.outputPrice,
    cachedInputPrice: snapshot.cachedInputPrice,
    reasoningPrice: snapshot.reasoningPrice,
    unit: 'per_million_tokens',
    currency: snapshot.rateCurrency ?? snapshot.currency,
  }

  let saleCharge = computeUpstreamCost(saleCostPrice, usage)

  // Convert to the charge currency if different from the snapshot currency.
  saleCharge = convertMicros(saleCharge, snapshot.rateCurrency ?? snapshot.currency, chargeCurrency, rate)

  // Apply the minimum-charge floor (in the charge currency, same as the live
  // path which applies it after conversion).
  const minMicros = toMicros(snapshot.minimumCharge)
  if (minMicros > 0n && saleCharge < minMicros) saleCharge = minMicros

  return { saleCharge }
}

/** Refuse ambiguous legacy rates; never repair their meaning from current rules. */
export function validateSaleSnapshotProvenance(
  snapshot: SaleSnapshotRow,
  rate: ExchangeRate | null,
  chargeCurrency: string,
): void {
  if (chargeCurrency !== snapshot.currency) throw new Error('pricing: settlement currency mismatch')
  if (snapshot.provenanceVersion == null) {
    if (snapshot.providerCurrency !== snapshot.currency)
      throw new Error('pricing: legacy currency provenance is ambiguous')
    if (snapshot.rateCurrency != null) throw new Error('pricing: incomplete currency provenance')
    return
  }
  if (
    snapshot.provenanceVersion !== 'provider-rates-v1' ||
    !snapshot.providerCurrency ||
    snapshot.rateCurrency !== snapshot.providerCurrency
  )
    throw new Error('pricing: invalid currency provenance')
  if (snapshot.rateCurrency !== snapshot.currency && !snapshot.exchangeRateSnapshotId)
    throw new Error('pricing: missing exchange snapshot pin')
  convertMicros(0n, snapshot.rateCurrency, snapshot.currency, rate)
}

// ── Helpers ────────────────────────────────────────────────────────────

function publishedRate(amount: string, rule: SaleRule, unitMultiplier: bigint): string {
  if (rule.pricingMode === 'fixed') return '0.00000000'
  const cost = parseDecimal(amount)
  let numerator = cost.num * unitMultiplier
  let denominator = cost.den
  if (rule.pricingMode === 'target_margin') {
    const margin = parseDecimal(rule.targetMarginRate)
    if (margin.num < 0n || margin.num >= margin.den) throw new Error('pricing: invalid target margin')
    numerator *= margin.den
    denominator *= margin.den - margin.num
  } else {
    const markup = parseDecimal(rule.markupRate)
    numerator *= markup.den + markup.num
    denominator *= markup.den
  }
  if (numerator < 0n) throw new Error('pricing: negative sale rate')
  const scaled = (numerator * 100_000_000n) / denominator
  return `${scaled / 100_000_000n}.${(scaled % 100_000_000n).toString().padStart(8, '0')}`
}
