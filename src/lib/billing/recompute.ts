// Historical charge recompute — DB wrapper around the pure pricing engine.
//
// Deliverable 4 of Work Item F. The pure engine lives in
// src/lib/pricing/recompute.ts (Work Item D): given pinned components + a sale
// rule + usage it re-derives the charge deterministically. This file supplies
// the *pinned inputs* from the database and answers the billing question:
//
//   "Does the amount stored on this request still equal what its own pinned
//    versions produce?"
//
// That is the historical-recompute guarantee (INVARIANT #4 / ADR-0003): a
// disputed line can be reproduced from version ids alone, after the price or
// the sale rule has been superseded. A mismatch is not silently corrected — it
// opens a reconciliation case, because the ledger is append-only and money is
// only ever moved by a compensating transaction (ADR-0002).

import { pool } from '@/db'
import { getPostedDebitTotal, loadPinnedPricing, computePinnedCharge, usageFromEvent, usageKey } from './pipeline'
import type { RequestRecordRow } from './pipeline'
import { ROUNDING_VERSION } from '@/lib/pricing/recompute'
import { BILLING_CALCULATOR_VERSION } from './pipeline'
import { deriveBillableMetering, calculatorVersionFor, type BillingUsageEvent } from './metering'
import type { PinnedPricing } from './pipeline'

type Queryable = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }

export interface RecomputeAudit {
  requestId: string
  computable: boolean
  reason?: string
  channelKind: 'platform' | 'byok'
  priceVersionId: string | null
  storedChargeAmount: bigint
  /** What the pinned versions produce now. Null when not computable. */
  recomputedChargeAmount: bigint | null
  recomputedUpstreamCost: bigint | null
  /** Ledger debit actually posted for this request, when one exists. */
  ledgerChargeAmount: bigint | null
  /** stored === recomputed (the historical bill is reproducible). */
  matchesStored: boolean
  /** ledger === stored (the projection was written from the ledger). */
  matchesLedger: boolean
  roundingVersion: string
  calculatorVersion: string
  saleRuleSource: string | null
}

/**
 * Re-derive a request's charge from its pinned version ids and recorded usage,
 * and compare it with both the stored projection and the ledger.
 *
 * Never throws for a missing/unpriced request: an audit that cannot compute is
 * reported as `computable: false` with a reason so the reconcile job can open
 * the right case instead of crashing.
 */
export async function recomputeRequestCharge(
  client: Queryable,
  tenantId: string,
  request: RequestRecordRow,
): Promise<RecomputeAudit> {
  const stored = toMicros(request.charge_amount)
  const ledger = await getPostedDebitTotal(client, tenantId, usageKey(request.id))
  const base = {
    requestId: request.id,
    channelKind: request.channel_kind,
    priceVersionId: request.provider_price_version_id,
    storedChargeAmount: stored,
    ledgerChargeAmount: ledger,
    roundingVersion: ROUNDING_VERSION,
    calculatorVersion: BILLING_CALCULATOR_VERSION,
  }

  let pricing
  let usage
  let breakdown
  try {
    const storedFact = (
      await client.query<{ event: BillingUsageEvent | null; pricing: PinnedPricing | null; calculator: string | null }>(
        `SELECT to_jsonb(u)->'authoritative_metering' AS event,to_jsonb(u)->'frozen_pricing' AS pricing,to_jsonb(u)->>'calculator_version' AS calculator FROM usage_records u WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at LIMIT 1`,
        [tenantId, request.id],
      )
    ).rows[0]
    let canonical = storedFact?.event
    if (!canonical)
      canonical = (
        await client.query<{ event: BillingUsageEvent }>(
          `SELECT payload->'event' AS event FROM usage_events WHERE tenant_id=$1 AND request_id=$2 AND payload->'event'->>'schema_version'='2' ORDER BY created_at DESC LIMIT 1`,
          [tenantId, request.id],
        )
      ).rows[0]?.event
    if (canonical?.schema_version === 2) {
      if (canonical.tenant_id !== tenantId || canonical.request_id !== request.id)
        throw new Error('metering_scope_mismatch')
      base.calculatorVersion = calculatorVersionFor(canonical)
      if (canonical.status !== 'completed') throw new Error('unknown_usage')
      if (!storedFact?.pricing || storedFact.calculator !== base.calculatorVersion)
        throw new Error('missing_frozen_pricing')
      pricing = storedFact.pricing
      const metering = deriveBillableMetering(canonical, pricing)
      if (!metering.known) throw new Error('unknown_usage')
      if (
        pricing.priceVersionId !== request.provider_price_version_id ||
        pricing.chargeCurrency !== request.charge_currency ||
        pricing.exchangeRateSnapshotId !== request.exchange_rate_snapshot_id ||
        (pricing.saleSnapshot?.id ?? null) !== request.sale_price_snapshot_id
      )
        throw new Error('frozen_pricing_pin_mismatch')
      usage = metering.usage
    } else {
      const captured = (
        await client.query<{ mode: string | null }>(
          `SELECT to_jsonb(r)->>'execution_mode' AS mode FROM request_records r WHERE tenant_id=$1 AND id=$2`,
          [tenantId, request.id],
        )
      ).rows[0]
      if (captured?.mode === 'managed' || captured?.mode === 'byok') throw new Error('missing_authoritative_metering')
      if (request.status !== 'completed') throw new Error('unknown_completion')
      pricing = await loadPinnedPricing(client, tenantId, request)
      usage = usageFromEvent({
        usage: {
          input_tokens: request.input_tokens,
          output_tokens: request.output_tokens,
          cached_input_tokens: request.cached_tokens,
          reasoning_tokens: request.reasoning_tokens,
        },
      })
    }
    breakdown = computePinnedCharge(pricing, usage)
  } catch (error) {
    return {
      ...base,
      computable: false,
      reason: error instanceof Error ? ((error as { code?: string }).code ?? error.message) : 'unpriced',
      recomputedChargeAmount: null,
      recomputedUpstreamCost: null,
      matchesStored: false,
      matchesLedger: ledger !== null ? ledger === stored : true,
      saleRuleSource: null,
    }
  }

  // BYOK is never charged by Nexus: the reproducible projection is 0, and the
  // provider cost lives in upstream_cost_amount (ADR-0004).
  const recomputed = request.channel_kind === 'byok' ? 0n : breakdown.saleCharge
  const matchesStored = recomputed === stored
  const matchesLedger = ledger === null ? true : ledger === stored

  return {
    ...base,
    computable: true,
    recomputedChargeAmount: recomputed,
    recomputedUpstreamCost: breakdown.upstreamCost,
    matchesStored,
    matchesLedger,
    saleRuleSource: pricing.saleRuleSource,
    priceVersionId: pricing.priceVersionId,
  }
}

/** Convenience: audit one request by id (own transaction when no client given). */
export async function auditRequestCharge(requestId: string, tenantId: string, client?: Queryable) {
  const query: Queryable = client ?? pool
  const result = await query.query<RequestRecordRow>(
    `SELECT id, tenant_id, channel_kind, status, provider_price_version_id, sale_price_snapshot_id,
            exchange_rate_snapshot_id, reservation_amount, reservation_released, charge_amount,
            charge_currency, upstream_cost_amount, upstream_cost_currency, resolved_provider_id,
            resolved_upstream_model_id, request_model,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens
       FROM request_records WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, requestId],
  )
  const request = result.rows[0]
  if (!request) return null
  return recomputeRequestCharge(query, tenantId, request)
}

function toMicros(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n
  return typeof value === 'bigint' ? value : BigInt(value)
}
