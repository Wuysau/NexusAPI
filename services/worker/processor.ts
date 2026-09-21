// Per-event processing: turn one outbox usage event into money decisions.
//
// This module owns the *routing* rules (what a status means, what may be
// retried, what becomes a reconciliation case). The arithmetic and ledger
// postings live in src/lib/billing/pipeline.ts; the Worker owns final usage
// settlement and reconciliation shares its frozen-price arithmetic.
//
// Every call runs inside the consumer's transaction and inside a SAVEPOINT: a
// failure rolls this event back completely, leaving the outbox row claimable.

import { logAudit } from '@/lib/audit'
import { findUsageEventByEventId, insertUsageEvent } from '@/lib/db/repositories'
import {
  BillingPermanentError,
  computePinnedCharge,
  getPostedDebitTotal,
  getReservedAmount,
  loadPinnedPricing,
  loadRequestRecord,
  moneyProjection,
  postUsageCharge,
  recordUsage,
  releaseReservation,
  updateRequestMoney,
  usageFromEvent,
  usageKey,
  type PinnedPricing,
  type RequestRecordRow,
} from '@/lib/billing/pipeline'
import { openReconciliationCase, type ReconciliationReason } from '@/lib/billing/reconcile'
import {
  parseBillingUsageEvent,
  normalizeMetering,
  deriveBillableMetering,
  calculatorVersionFor,
  MeteringValidationError,
  type BillingUsageEvent,
} from '@/lib/billing/metering'
import type { Micros } from '@/lib/money'
import type { PoolClient } from 'pg'

export interface OutboxEventRow {
  id: string
  tenant_id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: unknown
  idempotency_key: string
  attempts: number
}

export type Disposition =
  | 'settled' // completed: hold released + authoritative charge posted
  | 'released' // failed: hold released, nothing charged
  | 'reconciled' // handed to a human (unknown / missing usage / missing price)
  | 'replayed' // N-1 or previous Worker posting; no new money
  | 'already_settled' // a terminal result already exists; this event is stale
  | 'superseded' // an older attempt's event; the final attempt owns the charge
  | 'ignored' // not a usage event

export interface ProcessOutcome {
  eventId: string
  requestId: string
  disposition: Disposition
  channelKind: 'platform' | 'byok' | null
  chargeMicros: Micros
  reconciliationCaseId?: string
  detail?: string
}

/**
 * Process one outbox row. Returns a Disposition; throws only for errors the
 * consumer should retry (or dead-letter), never for a decision that belongs in
 * reconciliation.
 */
export async function processOutboxEvent(client: PoolClient, row: OutboxEventRow): Promise<ProcessOutcome> {
  if (row.aggregate_type !== 'usage' || !row.event_type.startsWith('usage.')) {
    return outcome(row, '', 'ignored', null, 0n, undefined, `unsupported aggregate ${row.aggregate_type}`)
  }

  let event: BillingUsageEvent
  try {
    event = parseBillingUsageEvent(row.payload)
  } catch (error) {
    const detail =
      error instanceof MeteringValidationError &&
      (row.payload as { schema_version?: unknown } | null)?.schema_version === 1
        ? error.errors.join('; ')
        : 'invalid canonical usage'
    throw new BillingPermanentError('invalid_event', `event ${row.id} violates its usage contract: ${detail}`)
  }
  if (event.tenant_id !== row.tenant_id) {
    // A cross-tenant payload is either corruption or an attack: never bill it.
    throw new BillingPermanentError(
      'tenant_mismatch',
      `event tenant ${event.tenant_id} != outbox tenant ${row.tenant_id}`,
    )
  }
  if (
    event.request_id !== row.aggregate_id ||
    row.event_type !== `usage.${event.schema_version === 2 ? 'v2.' : ''}${event.status}`
  ) {
    throw new BillingPermanentError('event_identity_mismatch', 'event differs from its durable outbox identity')
  }
  const tenantId = row.tenant_id

  // Idempotency: (tenant_id, event_id) on usage_events is the anchor. A repeated
  // delivery (same event_id in a second outbox row, or a manual replay) returns
  // the already-recorded result without touching the ledger.
  const existing = await findUsageEventByEventId(tenantId, event.event_id, client)
  if (existing) {
    const original = (existing.payload as { event?: BillingUsageEvent } | null)?.event
    if (!original || eventAuthority(original) !== eventAuthority(event)) {
      throw new BillingPermanentError('event_replay_mismatch', 'replayed event differs from its recorded facts')
    }
    const recorded = await findUsageRecordByEventId(client, tenantId, existing.id as string)
    return outcome(
      row,
      event.request_id,
      'replayed',
      null,
      recorded?.chargeAmount ?? 0n,
      undefined,
      'event already processed',
    )
  }

  const request = await loadRequestRecord(client, tenantId, event.request_id)
  if (!request) {
    // The gateway writes request + outbox in one transaction, so a missing
    // request is corruption, not a race. Anchor the event (without the dangling
    // request FK) so it is not retried forever, then hand it to a human.
    const anchor = await anchorEvent(client, row, event, { requestId: null, attemptId: null })
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: null,
      reason: 'missing_request',
      usageEventId: anchor,
      note: 'outbox event has no request_records row',
    })
    await audit(client, tenantId, 'billing.reconciliation_opened', event.request_id, { reason: 'missing_request' })
    return outcome(row, event.request_id, 'reconciled', null, 0n, kase.id, 'missing_request')
  }
  if (request.tenant_id !== tenantId || request.id !== event.request_id) {
    throw new BillingPermanentError('request_identity_mismatch', 'request identity differs from the event')
  }
  if (event.schema_version === 1) {
    const captured = (
      await client.query<{ execution_mode: string | null }>(
        `SELECT to_jsonb(r)->>'execution_mode' AS execution_mode FROM request_records r WHERE tenant_id=$1 AND id=$2`,
        [tenantId, event.request_id],
      )
    ).rows[0]
    if (captured?.execution_mode === 'managed' || captured?.execution_mode === 'byok')
      throw new BillingPermanentError('event_version_mismatch', 'captured v2 attempt cannot use the legacy calculator')
  }

  // Only the final attempt may bill. A stale event for an earlier attempt (a
  // retry that failed before the request succeeded) must never release the hold
  // or post a charge — that is the double-cost path INVARIANT #12 forbids.
  const finality = await checkAttemptFinality(client, tenantId, event)
  const attemptExists = finality !== 'unknown'
  if (
    event.schema_version === 2 &&
    !(await validateFrozenAuthority(client, request, event, finality !== 'superseded'))
  ) {
    const anchor = await anchorEvent(client, row, event, {
      requestId: request.id,
      attemptId: attemptExists ? event.attempt_id : null,
    })
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: 'missing_usage',
      usageEventId: anchor,
      note: 'missing immutable request or attempt attribution; no money moved',
    })
    return outcome(row, request.id, 'reconciled', request.channel_kind, 0n, kase.id, 'missing_attribution')
  }
  if (finality === 'superseded') {
    const anchor = await anchorEvent(client, row, event, { requestId: request.id, attemptId: event.attempt_id })
    await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: 'superseded_attempt',
      usageEventId: anchor,
      note: `attempt ${event.attempt_id} is not the final attempt; no money moved`,
    })
    return outcome(row, request.id, 'superseded', request.channel_kind, 0n, undefined, 'stale attempt')
  }

  if (event.schema_version === 1) validateRequestAuthority(request, event)

  const anchorId = await anchorEvent(client, row, event, {
    requestId: request.id,
    attemptId: attemptExists ? event.attempt_id : null,
  })
  if (!anchorId) {
    // Concurrent consumer inserted the same event_id first: replay.
    return outcome(row, event.request_id, 'replayed', request.channel_kind, 0n, undefined, 'concurrent duplicate')
  }

  const metering = normalizeMetering(event)
  // Failed requests can release a hold without inventing a charge. Their
  // canonical nulls remain in the event; the numeric compatibility row is not
  // used as authoritative metering.
  const usage = metering.known ? metering.usage : { input: 0, output: 0, cached: 0, reasoning: 0 }
  const estimated = event.usage.estimated === true

  if (event.status === 'unknown') {
    // INVARIANT #12: keep the hold, charge nothing, never auto-retry. A human
    // resolves the case; only then does money move.
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: 'unknown_completion',
      usageEventId: anchorId,
      currency: request.charge_currency,
      note: 'upstream completion unknown; hold retained, no auto-retry',
    })
    await audit(client, tenantId, 'billing.unknown_reconciled', request.id, {
      caseId: kase.id,
      channelKind: request.channel_kind,
    })
    return outcome(row, request.id, 'reconciled', request.channel_kind, 0n, kase.id, 'unknown_completion')
  }

  if (event.status === 'failed') {
    return settleFailed(client, row, request, anchorId, event, usage, estimated)
  }

  if (!metering.known && !(event.schema_version === 2 && event.usage.semantics === 'anthropic-inclusive-v1')) {
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: 'missing_usage',
      usageEventId: anchorId,
      currency: request.charge_currency,
      note: 'canonical billing count unknown; no money posted',
    })
    return outcome(row, request.id, 'reconciled', request.channel_kind, 0n, kase.id, 'missing_usage')
  }

  return settleCompleted(client, row, request, anchorId, event, usage, estimated)
}

// ── completed ─────────────────────────────────────────────────────────

async function settleCompleted(
  client: PoolClient,
  row: OutboxEventRow,
  request: RequestRecordRow,
  anchorId: string,
  event: BillingUsageEvent,
  usage: ReturnType<typeof usageFromEvent>,
  estimated: boolean,
): Promise<ProcessOutcome> {
  const tenantId = row.tenant_id
  const saleCharge = await getPostedDebitTotal(client, tenantId, usageKey(request.id))

  // An N-1 writer (or an earlier Worker run) already posted the
  // charge. Never post a second one: re-derive the pinned amount only to detect
  // drift, then record the usage fact against the ledger's number.
  if (saleCharge !== null) {
    let pricing: PinnedPricing | null = null
    let breakdown: ReturnType<typeof computePinnedCharge> | null = null
    let caseId: string | undefined
    try {
      pricing = await loadPinnedPricing(client, tenantId, request)
      const billable = deriveBillableMetering(event, pricing)
      if (!billable.known) throw new BillingPermanentError('missing_usage', 'required priced usage dimension unknown')
      usage = billable.usage
      breakdown = computePinnedCharge(pricing, usage)
    } catch (error) {
      // Preserve N-1 posted money, but missing pins still require reconciliation.
      const code = error instanceof BillingPermanentError ? error.code : 'missing_price_version'
      const kase = await openReconciliationCase(client, {
        tenantId,
        requestId: request.id,
        reason: isReconciliationReason(code) ? (code as ReconciliationReason) : 'missing_price_version',
        usageEventId: anchorId,
        currency: request.charge_currency,
        note: error instanceof Error ? error.message : 'pinned pricing unavailable',
      })
      caseId = kase.id
      pricing = null
    }
    let projection = null
    if (pricing && breakdown) {
      projection = moneyProjection(breakdown, pricing, request.channel_kind)
      const recomputed = request.channel_kind === 'byok' ? 0n : breakdown.saleCharge
      if (recomputed !== saleCharge) {
        const kase = await openReconciliationCase(client, {
          tenantId,
          requestId: request.id,
          reason: 'amount_mismatch',
          usageEventId: anchorId,
          expectedAmount: recomputed,
          actualAmount: saleCharge,
          currency: request.charge_currency,
          note: 'settle route posted a different amount than the pinned versions reproduce',
        })
        caseId = kase.id
      }
    }
    await recordUsage(client, {
      tenantId,
      requestId: request.id,
      usageEventRowId: anchorId,
      authoritativeMetering: event,
      frozenPricing: pricing,
      usage,
      chargeAmount: saleCharge,
      chargeCurrency: request.charge_currency,
      upstreamCostAmount: projection?.upstreamCostAmount ?? null,
      upstreamCostCurrency: projection?.upstreamCostCurrency ?? null,
      estimated,
    })
    await updateRequestMoney(client, {
      tenantId,
      requestId: request.id,
      status: 'completed',
      chargeCurrency: request.charge_currency,
      chargeAmount: saleCharge,
      upstreamCostAmount: projection?.upstreamCostAmount ?? null,
      upstreamCostCurrency: projection?.upstreamCostCurrency ?? null,
      costInChargeCurrency: projection?.costInChargeCurrency ?? null,
      grossMarginAmount: projection?.grossMarginAmount ?? null,
      grossMarginRate: projection?.grossMarginRate ?? null,
      priceVersionId: request.provider_price_version_id,
      reservationReleased: request.channel_kind === 'platform',
    })
    await audit(client, tenantId, 'billing.settled_replayed', request.id, {
      chargeMicros: saleCharge.toString(),
      channelKind: request.channel_kind,
      caseId: caseId ?? null,
    })
    return outcome(row, request.id, 'replayed', request.channel_kind, saleCharge, caseId, 'charge already posted')
  }

  // Fresh settlement: every amount comes from the pinned versions.
  let pricing: PinnedPricing
  let breakdown: ReturnType<typeof computePinnedCharge>
  try {
    pricing = await loadPinnedPricing(client, tenantId, request, event.price_version_id)
    const billable = deriveBillableMetering(event, pricing)
    if (!billable.known) throw new BillingPermanentError('missing_usage', 'required priced usage dimension unknown')
    usage = billable.usage
    breakdown = computePinnedCharge(pricing, usage)
  } catch (error) {
    const code = error instanceof BillingPermanentError ? error.code : 'missing_price_version'
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: (isReconciliationReason(code) ? code : 'missing_price_version') as ReconciliationReason,
      usageEventId: anchorId,
      currency: request.charge_currency,
      note: error instanceof Error ? error.message : 'pinned pricing unavailable',
    })
    await audit(client, tenantId, 'billing.reconciliation_opened', request.id, { reason: code })
    return outcome(row, request.id, 'reconciled', request.channel_kind, 0n, kase.id, code)
  }

  // A completion that reports no tokens at all is not trustworthy enough to
  // write off. Keep the hold and let a human look (INVARIANT #12).
  if (event.schema_version === 1 && usage.input === 0 && usage.output === 0 && !estimated) {
    const kase = await openReconciliationCase(client, {
      tenantId,
      requestId: request.id,
      reason: 'missing_usage',
      usageEventId: anchorId,
      currency: request.charge_currency,
      note: 'completed event reported zero usage and was not marked estimated',
    })
    await audit(client, tenantId, 'billing.reconciliation_opened', request.id, { reason: 'missing_usage' })
    return outcome(row, request.id, 'reconciled', request.channel_kind, 0n, kase.id, 'missing_usage')
  }

  const projection = moneyProjection(breakdown, pricing, request.channel_kind)

  if (request.channel_kind === 'platform') {
    // Release the hold first, then debit the authoritative charge; both
    // operations retain the existing request-derived idempotency keys.
    const hold = await getReservedAmount(client, tenantId, request.id, toMicros(request.reservation_amount))
    await releaseReservation(client, {
      tenantId,
      requestId: request.id,
      currency: request.charge_currency,
      amount: hold,
      description: 'reservation release on settlement',
    })
    await postUsageCharge(client, {
      tenantId,
      requestId: request.id,
      currency: request.charge_currency,
      amount: breakdown.saleCharge,
      channelKind: 'platform',
      estimated,
    })
  } else {
    // BYOK: the tenant pays the provider directly. Record the estimated provider
    // cost on memo accounts and never debit the wallet or credit revenue.
    await postUsageCharge(client, {
      tenantId,
      requestId: request.id,
      currency: request.charge_currency,
      amount: breakdown.upstreamCostInCharge,
      channelKind: 'byok',
      estimated,
    })
  }

  await recordUsage(client, {
    tenantId,
    requestId: request.id,
    usageEventRowId: anchorId,
    authoritativeMetering: event,
    frozenPricing: pricing,
    usage,
    chargeAmount: projection.chargeAmount,
    chargeCurrency: request.charge_currency,
    upstreamCostAmount: projection.upstreamCostAmount,
    upstreamCostCurrency: projection.upstreamCostCurrency,
    estimated,
  })
  await updateRequestMoney(client, {
    tenantId,
    requestId: request.id,
    status: 'completed',
    chargeCurrency: request.charge_currency,
    chargeAmount: projection.chargeAmount,
    upstreamCostAmount: projection.upstreamCostAmount,
    upstreamCostCurrency: projection.upstreamCostCurrency,
    costInChargeCurrency: projection.costInChargeCurrency,
    grossMarginAmount: projection.grossMarginAmount,
    grossMarginRate: projection.grossMarginRate,
    priceVersionId: pricing.priceVersionId,
    reservationReleased: request.channel_kind === 'platform',
  })
  await audit(client, tenantId, 'billing.settled', request.id, {
    chargeMicros: projection.chargeAmount.toString(),
    upstreamCostMicros: projection.upstreamCostAmount.toString(),
    channelKind: request.channel_kind,
    priceVersionId: pricing.priceVersionId,
    saleRuleSource: pricing.saleRuleSource,
    saleRuleId: pricing.saleRuleId,
    calculatorVersion: calculatorVersionFor(event),
    estimated,
    attempts: row.attempts,
  })
  return outcome(row, request.id, 'settled', request.channel_kind, projection.chargeAmount, undefined, undefined)
}

// ── failed ────────────────────────────────────────────────────────────

async function settleFailed(
  client: PoolClient,
  row: OutboxEventRow,
  request: RequestRecordRow,
  anchorId: string,
  event: BillingUsageEvent,
  usage: ReturnType<typeof usageFromEvent>,
  estimated: boolean,
): Promise<ProcessOutcome> {
  const tenantId = row.tenant_id

  // A conflicting late `failed` for an already-charged request must not release
  // the hold again (release is idempotent, but it must also not mask a success).
  const alreadyCharged = await getPostedDebitTotal(client, tenantId, usageKey(request.id))
  if (alreadyCharged !== null) {
    await recordUsage(client, {
      tenantId,
      requestId: request.id,
      usageEventRowId: anchorId,
      authoritativeMetering: event,
      usage,
      chargeAmount: alreadyCharged,
      chargeCurrency: request.charge_currency,
      estimated,
    })
    return outcome(
      row,
      request.id,
      'already_settled',
      request.channel_kind,
      alreadyCharged,
      undefined,
      'request already charged',
    )
  }

  if (request.channel_kind === 'platform') {
    const hold = await getReservedAmount(client, tenantId, request.id, toMicros(request.reservation_amount))
    await releaseReservation(client, {
      tenantId,
      requestId: request.id,
      currency: request.charge_currency,
      amount: hold,
      description: 'reservation release on failure',
    })
  }
  await recordUsage(client, {
    tenantId,
    requestId: request.id,
    usageEventRowId: anchorId,
    authoritativeMetering: event,
    usage,
    chargeAmount: 0n,
    chargeCurrency: request.charge_currency,
    estimated,
  })
  await updateRequestMoney(client, {
    tenantId,
    requestId: request.id,
    status: 'failed',
    chargeCurrency: request.charge_currency,
    chargeAmount: 0n,
    priceVersionId: request.provider_price_version_id,
    reservationReleased: request.channel_kind === 'platform',
  })
  await audit(client, tenantId, 'billing.failed_released', request.id, {
    channelKind: request.channel_kind,
    eventType: row.event_type,
  })
  return outcome(row, request.id, 'released', request.channel_kind, 0n, undefined, undefined)
}

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Insert the idempotency anchor. Returns null when the event already exists.
 * `requestId`/`attemptId` are passed explicitly because an unlinkable event must
 * anchor without dangling foreign keys (usage_events.request_id → request_records).
 */
async function anchorEvent(
  client: PoolClient,
  row: OutboxEventRow,
  event: BillingUsageEvent,
  links: { requestId: string | null; attemptId: string | null },
): Promise<string | null> {
  const inserted = await insertUsageEvent(
    row.tenant_id,
    {
      eventId: event.event_id,
      eventType: row.event_type,
      requestId: links.requestId ?? undefined,
      attemptId: links.attemptId ?? undefined,
      providerRequestId: event.provider_request_id ?? undefined,
      payload: {
        // The contract event verbatim, plus the processor trace so a stored usage
        // fact can be traced to the calculator that produced it (requirement 1).
        event: event as unknown as Record<string, unknown>,
        processing: {
          calculator_version: calculatorVersionFor(event),
          outbox_event_id: row.id,
          outbox_event_type: row.event_type,
          idempotency_key: row.idempotency_key,
          attribution:
            event.schema_version === 2 ? event.attribution : { project_id: null, attribution_status: 'unknown' },
        },
      },
    },
    client,
  )
  return inserted ? (inserted.id as string) : null
}

async function checkAttemptFinality(
  client: PoolClient,
  tenantId: string,
  event: BillingUsageEvent,
): Promise<'final' | 'superseded' | 'unknown'> {
  if (!event.attempt_id) return 'unknown'
  const attempt = await client.query<{ attempt_number: number }>(
    `SELECT attempt_number FROM attempts WHERE id = $1 AND tenant_id = $2 AND request_id = $3 LIMIT 1`,
    [event.attempt_id, tenantId, event.request_id],
  )
  if (!attempt.rows.length) return 'unknown'
  const max = await client.query<{ max: number | null }>(
    `SELECT max(attempt_number) AS max FROM attempts WHERE request_id = $1 AND tenant_id = $2`,
    [event.request_id, tenantId],
  )
  const highest = max.rows[0]?.max
  if (highest === null || highest === undefined) return 'unknown'
  return attempt.rows[0].attempt_number < highest ? 'superseded' : 'final'
}

function validateRequestAuthority(request: RequestRecordRow, event: BillingUsageEvent): void {
  if (request.provider_price_version_id && request.provider_price_version_id !== event.price_version_id) {
    throw new BillingPermanentError('price_version_mismatch', 'event differs from durable provider price pin')
  }
  if (
    request.status !== event.status ||
    request.resolved_upstream_model_id !== event.model_id ||
    request.input_tokens !== event.usage.input_tokens ||
    request.output_tokens !== event.usage.output_tokens ||
    request.cached_tokens !== (event.usage.cached_input_tokens ?? 0) ||
    request.reasoning_tokens !== (event.usage.reasoning_tokens ?? 0)
  ) {
    throw new BillingPermanentError('request_fact_mismatch', 'event differs from durable terminal usage facts')
  }
}

/** Compare billing authority, preserving optional token zero compatibility. */
function eventAuthority(event: BillingUsageEvent): string {
  if (event.schema_version === 2) return JSON.stringify(canonicalObject(event))
  return JSON.stringify([
    event.tenant_id,
    event.request_id,
    event.attempt_id,
    event.model_id,
    event.status,
    event.price_version_id,
    event.catalog_version_id,
    event.policy_version_id ?? null,
    event.provider_request_id ?? null,
    event.usage.input_tokens,
    event.usage.output_tokens,
    event.usage.cached_input_tokens ?? 0,
    event.usage.reasoning_tokens ?? 0,
    event.usage.estimated,
  ])
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalObject(item)]),
    )
  return value
}

async function validateFrozenAuthority(
  client: PoolClient,
  request: RequestRecordRow,
  event: Extract<BillingUsageEvent, { schema_version: 2 }>,
  terminal = true,
): Promise<boolean> {
  const fact = (
    await client.query('SELECT * FROM request_project_facts WHERE tenant_id=$1 AND request_id=$2', [
      event.tenant_id,
      event.request_id,
    ])
  ).rows[0]
  const attempt = (
    await client.query('SELECT * FROM attempts WHERE tenant_id=$1 AND request_id=$2 AND id=$3', [
      event.tenant_id,
      event.request_id,
      event.attempt_id,
    ])
  ).rows[0]
  if (!fact || !attempt) return false
  const a = event.attribution
  const same = (actual: unknown, expected: unknown) => (actual ?? null) === (expected ?? null)
  const factPairs: [unknown, unknown][] = [
    [fact.organization_id, event.organization_id],
    [fact.project_id, a.project_id],
    [fact.project_name, a.project_name],
    [fact.api_key_id, a.api_key_id],
    [fact.key_kind, a.key_kind],
    [fact.principal_id, a.principal_id],
    [fact.execution_mode, a.execution_mode],
    [fact.attribution_status, a.attribution_status],
    [fact.requested_model, event.requested_model],
    [fact.streaming, event.streaming],
    [fact.catalog_version_id, event.catalog_version_id],
    [fact.policy_version_id, event.policy_version_id],
    [attempt.provider_id, event.provider_id],
    [attempt.provider_credential_id, a.credential_id],
    [attempt.channel_id, a.channel_id],
    [attempt.connection_id, a.connection_id],
    [attempt.execution_mode, a.execution_mode],
    [attempt.resolved_model, event.resolved_model],
    [attempt.price_version_id, event.price_version_id],
    [attempt.catalog_version_id, event.catalog_version_id],
    [attempt.policy_version_id, event.policy_version_id],
    [attempt.status, event.status],
    [event.model_id, event.resolved_model],
  ]
  if (terminal)
    factPairs.push(
      [request.provider_price_version_id, event.price_version_id],
      [request.status, event.status],
      [request.resolved_upstream_model_id, event.resolved_model],
      [request.resolved_provider_id, event.provider_id],
    )
  for (const [field, column] of [
    ['input_tokens', 'input_tokens'],
    ['output_tokens', 'output_tokens'],
    ['cached_input_tokens', 'cached_tokens'],
    ['reasoning_tokens', 'reasoning_tokens'],
  ] as const) {
    const observed = event.usage[field]
    if (observed !== null) {
      factPairs.push([attempt[column], observed])
      if (terminal) factPairs.push([request[column], observed])
    }
  }
  if (factPairs.some(([actual, expected]) => !same(actual, expected)))
    throw new BillingPermanentError('request_fact_mismatch', 'event differs from immutable request or attempt facts')
  return true
}

async function findUsageRecordByEventId(
  client: PoolClient,
  tenantId: string,
  usageEventRowId: string,
): Promise<{ chargeAmount: Micros } | null> {
  const result = await client.query<{ charge_amount: string }>(
    `SELECT charge_amount FROM usage_records WHERE tenant_id = $1 AND usage_event_id = $2 ORDER BY created_at LIMIT 1`,
    [tenantId, usageEventRowId],
  )
  const row = result.rows[0]
  return row ? { chargeAmount: BigInt(row.charge_amount) } : null
}

async function audit(
  client: PoolClient,
  tenantId: string,
  action: string,
  requestId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    tenantId,
    action,
    targetType: 'request',
    targetId: requestId,
    metadata,
    client,
  })
}

function outcome(
  row: OutboxEventRow,
  requestId: string,
  disposition: Disposition,
  channelKind: 'platform' | 'byok' | null,
  chargeMicros: Micros,
  reconciliationCaseId?: string,
  detail?: string,
): ProcessOutcome {
  return {
    eventId: (row.payload as { event_id?: string } | null)?.event_id ?? row.id,
    requestId,
    disposition,
    channelKind,
    chargeMicros,
    reconciliationCaseId,
    detail,
  }
}

function toMicros(value: string | number | null | undefined): Micros {
  if (value === null || value === undefined) return 0n
  return typeof value === 'bigint' ? value : BigInt(value)
}

function isReconciliationReason(code: string): boolean {
  return ['missing_price_version', 'missing_sale_snapshot', 'missing_sale_rule', 'missing_exchange_rate'].includes(code)
}
