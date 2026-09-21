// Usage billing pipeline — charge computation and settlement.
//
// This is the money-moving half of the outbox consumer (Work Item F). It is
// deliberately separate from the worker process so the reconciliation job and
// the independent budget service share the exact pricing and ledger domain.
//
// Non-negotiable rules implemented here:
//   - ADR-0002: ledger postings are the SOLE balance truth. Balance columns on
//     request_records are derived copies; nothing here mutates a balance field.
//   - INVARIANT #4: a charge is computed ONLY from the version ids the request
//     pinned (provider price version, frozen sale rates, FX snapshot).
//     The live catalog is never consulted for an amount that is already pinned.
//   - INVARIANT #9/#10: every posting carries a deterministic idempotency key
//     derived from the request id, so a duplicate event, a retried settlement or
//     a worker crash never debits twice.
//   - INVARIANT #12: `unknown` is never charged and never auto-failed.
//   - INVARIANT #13: BYOK provider cost is recorded on dedicated memo accounts
//     and never masquerades as a Nexus receivable (revenue) or a wallet debit.
//
// Existing reservation/usage idempotency keys are preserved for N-1 ledger replay.

import { pool } from '@/db'
import {
  ensureSystemLedgerAccount,
  ensureWalletLedgerAccount,
  postTransaction,
  type PostedTransaction,
} from '@/lib/db/ledger'
import { findWalletByTenant, insertUsageRecord } from '@/lib/db/repositories'
import { fromMicros, parseDecimal, toMicros, MICROS_PER_UNIT, type Micros } from '@/lib/money'
import {
  computeUpstreamCost,
  convertMicros,
  type ChargeBreakdown,
  type ExchangeRate,
  type TokenUsage,
} from '@/lib/pricing'
import {
  componentsToCostPrice,
  validateComponents,
  type PriceComponent,
  type PriceComponentKind,
} from '@/lib/pricing/components'
import { ROUNDING_VERSION, type RecomputeResult } from '@/lib/pricing/recompute'
import { loadSaleSnapshot, computeChargeFromSnapshot, type SaleSnapshotRow } from '@/lib/catalog/sale-snapshot'
import type { PoolClient } from 'pg'
import { calculatorVersionFor, type BillingUsageEvent } from './metering'

// ── Versioning ────────────────────────────────────────────────────────
// Bump when the charge computation or the persisted shape changes, so a stored
// usage record can be traced to the code that produced it (requirement 1:
// "save estimated=true + tokenizer/calculator version").
export const BILLING_CALCULATOR_VERSION = 'nexus-billing-pipeline-v2'

// Idempotency keys remain compatible with already-posted historical transactions.
export const reservationKey = (requestId: string): string => `reservation:${requestId}`
export const reservationReleaseKey = (requestId: string): string => `reservation_release:${requestId}`
export const usageKey = (requestId: string): string => `usage:${requestId}`

// BYOK memo account codes. BYOK cost is informational: the tenant pays the
// provider directly, so it must never touch the wallet or revenue accounts.
export const byokEstimateCode = (currency: string): string => `byok_cost_estimate:${currency}`
export const byokClearingCode = (currency: string): string => `byok_cost_clearing:${currency}`

/** Minimal query surface so helpers work with a pooled client or a tx. */
export interface Queryable {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

export class BillingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

/**
 * An error that retrying cannot fix (bad event shape, missing pinned price,
 * unbalanced posting). The consumer dead-letters it instead of backing off.
 */
export class BillingPermanentError extends BillingError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'BillingPermanentError'
  }
}

// ── Row shapes (raw SQL returns snake_case; bigint columns come back as strings) ──

export interface RequestRecordRow {
  id: string
  tenant_id: string
  channel_kind: 'platform' | 'byok'
  status: string
  provider_price_version_id: string | null
  sale_price_snapshot_id: string | null
  exchange_rate_snapshot_id: string | null
  reservation_amount: string | number
  reservation_released: boolean
  charge_amount: string | number
  charge_currency: string
  upstream_cost_amount: string | number | null
  upstream_cost_currency: string | null
  resolved_provider_id: string | null
  resolved_upstream_model_id: string | null
  request_model: string
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
}

export interface PriceVersionRow {
  id: string
  provider_id: string
  upstream_model_id: string
  currency: string
  unit: string
  input_price: string
  cached_input_price: string
  cache_write_price?: string
  output_price: string
  reasoning_price: string
  request_price: string
  image_price: string
  audio_price: string
  status: string
}

interface ExchangeRateRow {
  base_currency: string
  quote_currency: string
  rate: string
}

export interface PinnedPricing {
  /** Frozen rate used to prove whether the existing input bucket covers writes. */
  cacheWritePrice?: string
  priceVersionId: string
  /** Currency the provider prices in (may differ from the charge currency). */
  providerCurrency: string
  chargeCurrency: string
  components: PriceComponent[]
  saleSnapshot: SaleSnapshotRow | null
  saleRuleId: string | null
  saleRuleSource: 'pinned_snapshot' | 'byok_provider_cost'
  exchangeRate: ExchangeRate | null
  exchangeRateSnapshotId: string | null
}

export interface PinnedCharge extends RecomputeResult {
  pricing: PinnedPricing
}

// ── Pinned pricing resolution ─────────────────────────────────────────

/** Resolve only durable request pins; event versions can validate, never supply them. */
export async function loadPinnedPricing(
  client: Queryable,
  tenantId: string,
  request: RequestRecordRow,
  eventPriceVersionId?: string | null,
): Promise<PinnedPricing> {
  if (request.tenant_id !== tenantId) throw new BillingPermanentError('tenant_mismatch', 'request tenant mismatch')
  const priceVersionId = request.provider_price_version_id
  if (!priceVersionId)
    throw new BillingPermanentError('missing_price_version', 'request has no pinned provider price version')
  if (eventPriceVersionId && eventPriceVersionId !== priceVersionId) {
    throw new BillingPermanentError('price_version_mismatch', 'event differs from durable provider price pin')
  }
  const result = await client.query<PriceVersionRow>(
    'SELECT id, provider_id, upstream_model_id, currency, unit, input_price, cached_input_price, cache_write_price, output_price, reasoning_price, request_price, image_price, audio_price, status FROM provider_price_versions WHERE id = $1 LIMIT 1',
    [priceVersionId],
  )
  const price = result.rows[0]
  if (!price) throw new BillingPermanentError('missing_price_version', 'pinned provider price version not found')
  if (
    price.provider_id !== request.resolved_provider_id ||
    price.upstream_model_id !== request.resolved_upstream_model_id
  ) {
    throw new BillingPermanentError('price_version_mismatch', 'provider price does not match durable request identity')
  }
  const saleSnapshot = request.sale_price_snapshot_id
    ? await loadSaleSnapshot(client, request.sale_price_snapshot_id)
    : null
  if ((request.channel_kind === 'platform' || request.sale_price_snapshot_id) && !saleSnapshot) {
    throw new BillingPermanentError('missing_sale_snapshot', 'request has no readable pinned sale snapshot')
  }
  if (
    saleSnapshot &&
    (saleSnapshot.providerPriceVersionId !== priceVersionId ||
      saleSnapshot.exchangeRateSnapshotId !== request.exchange_rate_snapshot_id ||
      saleSnapshot.currency !== request.charge_currency)
  ) {
    throw new BillingPermanentError(
      'snapshot_pin_mismatch',
      'sale snapshot differs from durable provider, FX or currency pins',
    )
  }
  // Historical V1 snapshots materialized provider-currency rates but labelled
  // them with the sale currency. Without provenance a conversion would guess.
  if (
    saleSnapshot &&
    saleSnapshot.currency !== price.currency &&
    (saleSnapshot.provenanceVersion !== 'provider-rates-v1' ||
      saleSnapshot.providerCurrency !== price.currency ||
      saleSnapshot.rateCurrency !== price.currency)
  ) {
    throw new BillingPermanentError(
      'unsupported_snapshot_currency',
      'crosscurrency sale snapshot requires verified rate provenance',
    )
  }
  const { exchangeRate, exchangeRateSnapshotId } = await loadExchangeRate(client, request.exchange_rate_snapshot_id)
  if (exchangeRate && parseDecimal(exchangeRate.rate).num <= 0n) {
    throw new BillingPermanentError('missing_exchange_rate', 'pinned FX rate must be positive')
  }
  if (
    price.currency !== request.charge_currency &&
    (!exchangeRate || exchangeRate.base !== price.currency || exchangeRate.quote !== request.charge_currency)
  ) {
    throw new BillingPermanentError(
      'missing_exchange_rate',
      'currency conversion requires the matching pinned FX snapshot',
    )
  }
  return {
    priceVersionId,
    providerCurrency: price.currency,
    chargeCurrency: request.charge_currency,
    components: componentList(price),
    cacheWritePrice: price.cache_write_price,
    saleSnapshot,
    saleRuleId: saleSnapshot?.ruleId ?? null,
    saleRuleSource: saleSnapshot ? 'pinned_snapshot' : 'byok_provider_cost',
    exchangeRate,
    exchangeRateSnapshotId,
  }
}

/** Frozen sale rates and pinned provider costs share the existing exact arithmetic. */
export function computePinnedCharge(pricing: PinnedPricing, usage: TokenUsage, roundingVersion?: string): PinnedCharge {
  const validation = validateComponents(pricing.components)
  if (!validation.ok) throw new BillingPermanentError('invalid_components', validation.errors.join('; '))
  const upstreamCost = computeUpstreamCost(componentsToCostPrice(pricing.components, pricing.providerCurrency), usage)
  const upstreamCostInCharge = convertMicros(
    upstreamCost,
    pricing.providerCurrency,
    pricing.chargeCurrency,
    pricing.exchangeRate,
  )
  const snapshot = pricing.saleSnapshot
  const saleCharge = snapshot
    ? computeChargeFromSnapshot(snapshot, usage, pricing.exchangeRate, pricing.chargeCurrency).saleCharge
    : 0n
  const grossMargin = snapshot ? saleCharge - upstreamCostInCharge : 0n
  const grossMarginRate = saleCharge > 0n ? (grossMargin * MICROS_PER_UNIT) / saleCharge : 0n
  const floor = snapshot ? toMicros(snapshot.minimumCharge) : 0n
  const withoutFloor = snapshot
    ? computeChargeFromSnapshot(
        { ...snapshot, minimumCharge: '0' },
        usage,
        pricing.exchangeRate,
        pricing.chargeCurrency,
      ).saleCharge
    : 0n
  return {
    pricing,
    priceVersionId: pricing.priceVersionId,
    roundingVersion: roundingVersion ?? ROUNDING_VERSION,
    upstreamCost,
    upstreamCostInCharge,
    saleCharge,
    grossMargin,
    grossMarginRate,
    fixedFee: snapshot?.pricingMode === 'fixed' ? toMicros(snapshot.fixedFee) : 0n,
    minimumApplied: floor > withoutFloor,
    saleRates: {
      input: snapshot ? toMicros(snapshot.inputPrice) : 0n,
      output: snapshot ? toMicros(snapshot.outputPrice) : 0n,
      cachedInput: snapshot ? toMicros(snapshot.cachedInputPrice) : 0n,
      reasoning: snapshot ? toMicros(snapshot.reasoningPrice) : 0n,
    },
  }
}

export function usageFromEvent(event: {
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; reasoning_tokens?: number }
}): TokenUsage {
  return {
    input: Math.max(0, Math.floor(event.usage.input_tokens ?? 0)),
    output: Math.max(0, Math.floor(event.usage.output_tokens ?? 0)),
    cached: Math.max(0, Math.floor(event.usage.cached_input_tokens ?? 0)),
    reasoning: Math.max(0, Math.floor(event.usage.reasoning_tokens ?? 0)),
  }
}

// ── Ledger settlement ─────────────────────────────────────────────────

async function ensureAccountByCode(
  client: Queryable,
  tenantId: string,
  type: string,
  currency: string,
  code: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (id, tenant_id, type, currency, code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, code) DO NOTHING
     RETURNING id`,
    [tenantId, type, currency, code],
  )
  if (result.rows[0]) return result.rows[0].id
  const existing = (
    await client.query<{ id: string; type: string; currency: string }>(
      'SELECT id,type,currency FROM ledger_accounts WHERE tenant_id=$1 AND code=$2',
      [tenantId, code],
    )
  ).rows[0]
  if (!existing || existing.type !== type || existing.currency !== currency)
    throw new BillingPermanentError(
      'account_identity_mismatch',
      'memo account identity differs from its immutable code',
    )
  return existing.id
}

/** The amount currently held for a request, read from the reservation postings. */
export async function getReservedAmount(
  client: Queryable,
  tenantId: string,
  requestId: string,
  fallback: Micros,
): Promise<Micros> {
  const result = await client.query<{ amount: string | null }>(
    `SELECT sum(lp.amount) AS amount
       FROM ledger_postings lp
       JOIN ledger_transactions lt ON lt.id = lp.transaction_id
      WHERE lt.tenant_id = $1 AND lt.idempotency_key = $2 AND lp.entry_type = 'credit'`,
    [tenantId, reservationKey(requestId)],
  )
  const raw = result.rows[0]?.amount
  return raw === null || raw === undefined ? fallback : BigInt(raw)
}

/**
 * Magnitude of the debit side of a ledger transaction identified by
 * idempotency key, or null when the transaction does not exist.
 *
 * ledger_postings stores SIGNED amounts (+credit / -debit), so the debit sum is
 * negated back to a positive money amount here.
 */
export async function getPostedDebitTotal(
  client: Queryable,
  tenantId: string,
  idempotencyKey: string,
): Promise<Micros | null> {
  const result = await client.query<{ amount: string | null }>(
    `SELECT sum(lp.amount) AS amount
       FROM ledger_postings lp
       JOIN ledger_transactions lt ON lt.id = lp.transaction_id
      WHERE lt.tenant_id = $1 AND lt.idempotency_key = $2 AND lp.entry_type = 'debit'`,
    [tenantId, idempotencyKey],
  )
  const raw = result.rows[0]?.amount
  if (raw === null || raw === undefined) return null
  const signed = BigInt(raw)
  return signed < 0n ? -signed : signed
}

export interface ReleaseResult {
  posted: PostedTransaction | null
  amount: Micros
  replayed: boolean
}

/**
 * Release a reservation hold in full: debit the reservation account, credit the
 * wallet. Idempotent on `reservation_release:<requestId>`, so a settle retry, a
 * duplicate outbox event and the E settle route all converge on one entry.
 */
export async function releaseReservation(
  client: PoolClient,
  input: {
    tenantId: string
    requestId: string
    currency: string
    /** Explicit hold amount; when omitted it is read from the reservation postings. */
    amount?: Micros
    description?: string
  },
): Promise<ReleaseResult> {
  const wallet = await findWalletByTenant(input.tenantId, input.currency, client)
  if (!wallet) {
    throw new BillingError('no_wallet', `no wallet for tenant ${input.tenantId} in ${input.currency}`)
  }
  const amount = input.amount ?? (await getReservedAmount(client, input.tenantId, input.requestId, 0n))
  if (amount <= 0n) return { posted: null, amount: 0n, replayed: false }

  const walletAccountId = await ensureWalletLedgerAccount(input.tenantId, wallet.id, input.currency, client)
  const reservationAccountId = await ensureSystemLedgerAccount(input.tenantId, 'reservation', input.currency, client)
  const posted = await postTransaction(
    {
      tenantId: input.tenantId,
      type: 'reservation_release',
      currency: input.currency,
      idempotencyKey: reservationReleaseKey(input.requestId),
      postings: [
        { accountId: reservationAccountId, amount, entryType: 'debit' },
        { accountId: walletAccountId, amount, entryType: 'credit' },
      ],
      referenceType: 'request',
      referenceId: input.requestId,
      description: input.description ?? 'reservation release',
    },
    client,
  )
  return { posted, amount, replayed: posted.replayed }
}

export interface UsagePostResult {
  posted: PostedTransaction | null
  amount: Micros
  replayed: boolean
  channelKind: 'platform' | 'byok'
}

/**
 * Post the authoritative usage charge.
 *   - managed (channel_kind=platform): debit the wallet, credit revenue. This is
 *     a real Nexus receivable.
 *   - BYOK: debit a `byok_cost_estimate` memo account and credit its clearing
 *     counterparty. Neither account is linked to a wallet, so the tenant's
 *     balance is untouched and the provider bill never becomes Nexus revenue
 *     (INVARIANT #13 / ADR-0004).
 * Idempotent on `usage:<requestId>`.
 */
export async function postUsageCharge(
  client: PoolClient,
  input: {
    tenantId: string
    requestId: string
    currency: string
    amount: Micros
    channelKind: 'platform' | 'byok'
    estimated?: boolean
  },
): Promise<UsagePostResult> {
  if (input.amount <= 0n) return { posted: null, amount: 0n, replayed: false, channelKind: input.channelKind }

  if (input.channelKind === 'byok') {
    const estimateAccountId = await ensureAccountByCode(
      client,
      input.tenantId,
      'adjustment',
      input.currency,
      byokEstimateCode(input.currency),
    )
    const clearingAccountId = await ensureAccountByCode(
      client,
      input.tenantId,
      'adjustment',
      input.currency,
      byokClearingCode(input.currency),
    )
    const posted = await postTransaction(
      {
        tenantId: input.tenantId,
        type: 'usage',
        currency: input.currency,
        idempotencyKey: usageKey(input.requestId),
        postings: [
          { accountId: estimateAccountId, amount: input.amount, entryType: 'debit' },
          { accountId: clearingAccountId, amount: input.amount, entryType: 'credit' },
        ],
        referenceType: 'request',
        referenceId: input.requestId,
        description: input.estimated ? 'byok provider cost estimate' : 'byok provider cost',
      },
      client,
    )
    return { posted, amount: input.amount, replayed: posted.replayed, channelKind: 'byok' }
  }

  const wallet = await findWalletByTenant(input.tenantId, input.currency, client)
  if (!wallet) {
    throw new BillingError('no_wallet', `no wallet for tenant ${input.tenantId} in ${input.currency}`)
  }
  const walletAccountId = await ensureWalletLedgerAccount(input.tenantId, wallet.id, input.currency, client)
  const revenueAccountId = await ensureSystemLedgerAccount(input.tenantId, 'revenue', input.currency, client)
  const posted = await postTransaction(
    {
      tenantId: input.tenantId,
      type: 'usage',
      currency: input.currency,
      idempotencyKey: usageKey(input.requestId),
      postings: [
        { accountId: walletAccountId, amount: input.amount, entryType: 'debit' },
        { accountId: revenueAccountId, amount: input.amount, entryType: 'credit' },
      ],
      referenceType: 'request',
      referenceId: input.requestId,
      description: input.estimated ? 'usage charge (estimated usage)' : 'usage charge',
    },
    client,
  )
  return { posted, amount: input.amount, replayed: posted.replayed, channelKind: 'platform' }
}

// ── Money-column projection (derived, never authoritative) ─────────────

/**
 * Write the monetary projection onto request_records. The ledger remains the
 * truth; these columns exist so lists and invoices do not need a ledger join.
 */
export async function updateRequestMoney(
  client: Queryable,
  input: {
    tenantId: string
    requestId: string
    status: 'completed' | 'failed' | 'unknown' | 'reconciled'
    chargeCurrency: string
    chargeAmount: Micros
    upstreamCostAmount?: Micros | null
    upstreamCostCurrency?: string | null
    costInChargeCurrency?: Micros | null
    grossMarginAmount?: Micros | null
    grossMarginRate?: Micros | null
    priceVersionId?: string | null
    reservationReleased?: boolean
  },
): Promise<void> {
  await client.query(
    `UPDATE request_records
        SET charge_amount = $3,
            charge_currency = $4,
            upstream_cost_amount = COALESCE($5, upstream_cost_amount),
            upstream_cost_currency = COALESCE($6, upstream_cost_currency),
            cost_in_charge_currency = COALESCE($7, cost_in_charge_currency),
            gross_margin_amount = COALESCE($8, gross_margin_amount),
            gross_margin_rate = COALESCE($9, gross_margin_rate),
            provider_price_version_id = COALESCE(provider_price_version_id, $10),
            status = $11,
            completed_at = COALESCE(completed_at, now()),
            reservation_released = CASE WHEN $12 THEN true ELSE reservation_released END
      WHERE tenant_id = $1 AND id = $2`,
    [
      input.tenantId,
      input.requestId,
      input.chargeAmount.toString(),
      input.chargeCurrency,
      input.upstreamCostAmount === undefined || input.upstreamCostAmount === null
        ? null
        : input.upstreamCostAmount.toString(),
      input.upstreamCostCurrency ?? null,
      input.costInChargeCurrency === undefined || input.costInChargeCurrency === null
        ? null
        : input.costInChargeCurrency.toString(),
      input.grossMarginAmount === undefined || input.grossMarginAmount === null
        ? null
        : input.grossMarginAmount.toString(),
      input.grossMarginRate === undefined || input.grossMarginRate === null ? null : fromMicros(input.grossMarginRate),
      input.priceVersionId ?? null,
      input.status,
      input.reservationReleased === true,
    ],
  )
}

export interface UsageRecordInput {
  tenantId: string
  requestId: string
  usageEventRowId: string
  usage: TokenUsage
  chargeAmount: Micros
  chargeCurrency: string
  upstreamCostAmount?: Micros | null
  upstreamCostCurrency?: string | null
  estimated: boolean
  authoritativeMetering?: BillingUsageEvent
  frozenPricing?: PinnedPricing | null
}

/** Record the usage fact once per processed event (idempotency anchored on usage_events). */
export async function recordUsage(client: PoolClient, input: UsageRecordInput): Promise<{ id: string }> {
  const row = await insertUsageRecord(
    input.tenantId,
    {
      requestId: input.requestId,
      usageEventId: input.usageEventRowId,
      inputTokens: input.usage.input,
      outputTokens: input.usage.output,
      cachedTokens: input.usage.cached,
      reasoningTokens: input.usage.reasoning,
      upstreamCostAmount: input.upstreamCostAmount ?? undefined,
      upstreamCostCurrency: input.upstreamCostCurrency ?? undefined,
      chargeAmount: input.chargeAmount,
      chargeCurrency: input.chargeCurrency,
      estimatedAmount: input.estimated,
    },
    client,
  )
  if (input.authoritativeMetering?.schema_version === 2) {
    await client.query(
      `UPDATE usage_records SET authoritative_metering=$1::jsonb, frozen_pricing=$2::jsonb, calculator_version=$3 WHERE id=$4 AND tenant_id=$5 AND request_id=$6`,
      [
        JSON.stringify(input.authoritativeMetering),
        input.frozenPricing ? JSON.stringify(input.frozenPricing) : null,
        calculatorVersionFor(input.authoritativeMetering),
        row.id,
        input.tenantId,
        input.requestId,
      ],
    )
  }
  return row
}

// ── Row loaders ───────────────────────────────────────────────────────

export async function loadRequestRecord(
  client: Queryable,
  tenantId: string,
  requestId: string,
): Promise<RequestRecordRow | null> {
  const result = await client.query<RequestRecordRow>(
    `SELECT id, tenant_id, channel_kind, status, provider_price_version_id, sale_price_snapshot_id,
            exchange_rate_snapshot_id, reservation_amount, reservation_released, charge_amount,
            charge_currency, upstream_cost_amount, upstream_cost_currency, resolved_provider_id,
            resolved_upstream_model_id, request_model,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens
       FROM request_records WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, requestId],
  )
  return result.rows[0] ?? null
}

async function loadExchangeRate(
  client: Queryable,
  snapshotId: string | null,
): Promise<{ exchangeRate: ExchangeRate | null; exchangeRateSnapshotId: string | null }> {
  if (!snapshotId) return { exchangeRate: null, exchangeRateSnapshotId: null }
  const result = await client.query<ExchangeRateRow>(
    `SELECT base_currency, quote_currency, rate FROM exchange_rate_snapshots WHERE id = $1 LIMIT 1`,
    [snapshotId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new BillingPermanentError('missing_exchange_rate', `pinned FX snapshot ${snapshotId} not found`)
  }
  return {
    exchangeRate: { base: row.base_currency, quote: row.quote_currency, rate: row.rate },
    exchangeRateSnapshotId: snapshotId,
  }
}

/** CostPrice projection of a pinned provider price version (same as E's routes). */
export function componentList(price: PriceVersionRow): PriceComponent[] {
  const unit = price.unit || 'per_million_tokens'
  const components: PriceComponent[] = [
    { kind: 'input', unit, amount: price.input_price, conditions: {} },
    { kind: 'cached_input', unit, amount: price.cached_input_price, conditions: {} },
    { kind: 'output', unit, amount: price.output_price, conditions: {} },
    { kind: 'reasoning', unit, amount: price.reasoning_price, conditions: {} },
  ]
  // Non-token rates are only present when actually charged: adding a zero-rate
  // `per_image` component would make the version MIXED-UNIT and fail the shared
  // engine's validation (a zero rate contributes nothing to the charge anyway).
  const extras: [PriceComponentKind, string, string][] = [
    ['request', price.request_price, 'per_request'],
    ['image', price.image_price, 'per_image'],
    ['audio', price.audio_price, 'per_second'],
  ]
  for (const [kind, amount, extraUnit] of extras) {
    if (parseDecimal(amount).num !== 0n) components.push({ kind, unit: extraUnit, amount, conditions: {} })
  }
  return components
}

/**
 * Derive the monetary projection from a charge breakdown. Kept here so the
 * worker, the recompute audit and any future caller project identically.
 */
export function moneyProjection(
  breakdown: ChargeBreakdown,
  pricing: PinnedPricing,
  channelKind: 'platform' | 'byok',
): {
  chargeAmount: Micros
  upstreamCostAmount: Micros
  upstreamCostCurrency: string
  costInChargeCurrency: Micros
  grossMarginAmount: Micros
  grossMarginRate: Micros
} {
  const upstreamCostInCharge = breakdown.upstreamCostInCharge
  if (channelKind === 'byok') {
    // BYOK: Nexus charges nothing; the recorded amount is the tenant's estimated
    // direct provider cost (ADR-0004).
    return {
      chargeAmount: 0n,
      upstreamCostAmount: breakdown.upstreamCost,
      upstreamCostCurrency: pricing.providerCurrency,
      costInChargeCurrency: upstreamCostInCharge,
      grossMarginAmount: 0n,
      grossMarginRate: 0n,
    }
  }
  return {
    chargeAmount: breakdown.saleCharge,
    upstreamCostAmount: breakdown.upstreamCost,
    upstreamCostCurrency: pricing.providerCurrency,
    costInChargeCurrency: upstreamCostInCharge,
    grossMarginAmount: breakdown.grossMargin,
    grossMarginRate: breakdown.grossMarginRate,
  }
}

/** Convenience for tests/tools that already hold a pool client. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
