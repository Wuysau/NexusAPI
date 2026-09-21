// Reconciliation job + manual case closure.
//
// The billing pipeline refuses to guess. Anything the outbox consumer cannot
// prove — an upstream completion we never observed, usage the provider did not
// report, an amount that no longer reproduces from the pinned versions, a hold
// stranded by a crashed gateway — becomes a reconciliation case that a human
// resolves. INVARIANT #12: `unknown` must never be auto-classified as success,
// failure or zero cost, and it must never be retried onto another channel
// (a blind retry is how you pay twice for one request).
//
// Three jobs, each idempotent and safe to run concurrently:
//   1. reconcileUnknownTerminals — flag `unknown` requests; keep the hold.
//   2. releaseExpiredReservations — free holds on requests that never reached a
//      terminal state, and flag them for investigation.
//   3. auditSettledCharges — re-derive recent completed charges from their
//      pinned versions and open a case on any mismatch.
//
// Case creation is idempotent per (tenant, request, reason) while a case is
// open/investigating, so repeated runs do not multiply cases. Resolution is a
// separate, explicit human action (resolveReconciliationCase).

import { pool } from '@/db'
import { logAudit } from '@/lib/audit'
import {
  getReservedAmount,
  loadRequestRecord,
  releaseReservation,
  type Queryable,
  type RequestRecordRow,
} from './pipeline'
import { recomputeRequestCharge } from './recompute'
import type { PoolClient } from 'pg'

export type ReconciliationReason =
  | 'unknown_completion'
  | 'missing_usage'
  | 'missing_request'
  | 'missing_price_version'
  | 'missing_sale_snapshot'
  | 'missing_sale_rule'
  | 'missing_exchange_rate'
  | 'amount_mismatch'
  | 'reservation_timeout'
  | 'superseded_attempt'

export interface ReconciliationCaseRow {
  id: string
  tenant_id: string | null
  request_id: string | null
  status: 'open' | 'investigating' | 'resolved' | 'unresolved'
  reason: string
  expected_amount: string | null
  actual_amount: string | null
  currency: string | null
  resolution: string | null
}

export interface OpenCaseInput {
  tenantId: string
  /** Null when the event could not be linked to a request_records row. */
  requestId: string | null
  reason: ReconciliationReason
  usageEventId?: string | null
  expectedAmount?: bigint | null
  actualAmount?: bigint | null
  currency?: string | null
  note?: string
}

/**
 * Open a case, or return the existing open one for the same
 * (tenant, request, reason). Idempotent so a retried event, a re-run job and a
 * concurrent worker all converge on one case.
 */
export async function openReconciliationCase(
  client: Queryable,
  input: OpenCaseInput,
): Promise<{ id: string; created: boolean }> {
  // IS NOT DISTINCT FROM so a request-less case (request_id NULL) is still
  // deduplicated on re-runs.
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM reconciliation_cases
      WHERE tenant_id = $1 AND request_id IS NOT DISTINCT FROM $2 AND reason = $3
        AND status IN ('open','investigating')
      ORDER BY created_at DESC LIMIT 1`,
    [input.tenantId, input.requestId, input.reason],
  )
  if (existing.rows.length) return { id: existing.rows[0].id, created: false }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO reconciliation_cases
       (id, tenant_id, request_id, usage_event_id, status, reason, expected_amount, actual_amount, currency, resolution)
     VALUES (gen_random_uuid(), $1, $2, $3, 'open', $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.tenantId,
      input.requestId,
      input.usageEventId ?? null,
      input.reason,
      input.expectedAmount === undefined || input.expectedAmount === null ? null : input.expectedAmount.toString(),
      input.actualAmount === undefined || input.actualAmount === null ? null : input.actualAmount.toString(),
      input.currency ?? null,
      input.note ?? null,
    ],
  )
  const id = inserted.rows[0].id
  await logAudit({
    tenantId: input.tenantId,
    action: 'billing.reconciliation_opened',
    targetType: 'request',
    targetId: input.requestId ?? undefined,
    metadata: {
      caseId: id,
      reason: input.reason,
      expectedAmount: input.expectedAmount?.toString() ?? null,
      actualAmount: input.actualAmount?.toString() ?? null,
      note: input.note ?? null,
    },
    client: client as PoolClient,
  })
  return { id, created: true }
}

export interface ResolveCaseInput {
  tenantId: string
  caseId: string
  status: 'resolved' | 'unresolved'
  resolution: string
  resolvedBy: string
  /**
   * Manual release of a retained hold. Only valid for cases whose hold Nexus
   * decided to keep (unknown_completion / missing_usage); it posts the normal
   * idempotent reservation_release entry and never touches a balance directly.
   */
  releaseHold?: boolean
}

/**
 * Close a case by hand. This is the only path that clears an `unknown` request:
 * an operator has confirmed the upstream outcome and states what the money
 * should do. The compensation itself is a normal ledger posting.
 * The caller must hold a transaction until this function completes; the scoped
 * case lock serializes concurrent manual resolutions.
 */
export async function resolveReconciliationCase(
  client: PoolClient,
  input: ResolveCaseInput,
): Promise<{ resolved: boolean; reservationReleased: boolean }> {
  if (typeof input.tenantId !== 'string' || !input.tenantId.trim()) throw new Error('tenantId is required')
  const caseResult = await client.query<ReconciliationCaseRow>(
    `SELECT id, tenant_id, request_id, status, reason, expected_amount, actual_amount, currency, resolution
       FROM reconciliation_cases WHERE tenant_id = $1 AND id = $2 LIMIT 1 FOR UPDATE`,
    [input.tenantId, input.caseId],
  )
  const row = caseResult.rows[0]
  if (!row || row.tenant_id !== input.tenantId) throw new Error(`reconciliation case ${input.caseId} not found`)
  if (row.status === 'resolved' || row.status === 'unresolved') {
    return { resolved: false, reservationReleased: false }
  }

  let reservationReleased = false
  if (input.releaseHold && row.request_id) {
    const request = await loadRequestRecord(client, input.tenantId, row.request_id)
    if (request && !request.reservation_released) {
      const amount = await getReservedAmount(
        client,
        input.tenantId,
        row.request_id,
        toMicros(request.reservation_amount),
      )
      const released = await releaseReservation(client, {
        tenantId: input.tenantId,
        requestId: row.request_id,
        currency: request.charge_currency ?? row.currency ?? 'USD',
        amount,
        description: 'manual reconciliation release',
      })
      await client.query(
        `UPDATE request_records SET reservation_released = true, status = 'reconciled'
          WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, row.request_id],
      )
      reservationReleased = released.amount > 0n
    }
  }

  await client.query(
    `UPDATE reconciliation_cases
        SET status = $3, resolution = $4, resolved_by = $5, resolved_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.caseId, input.status, input.resolution, input.resolvedBy],
  )
  await logAudit({
    tenantId: input.tenantId,
    action: 'billing.reconciliation_resolved',
    targetType: 'reconciliation_case',
    targetId: input.caseId,
    metadata: {
      status: input.status,
      resolution: input.resolution,
      resolvedBy: input.resolvedBy,
      releaseHold: input.releaseHold === true,
      reservationReleased,
    },
    client,
  })
  return { resolved: true, reservationReleased }
}

export interface ReconciliationSummary {
  unknownFlagged: number
  reservationsReleased: number
  amountMismatches: number
}

/**
 * Flag `unknown` requests. The hold is deliberately NOT released and no charge
 * is posted: we cannot prove whether the upstream produced tokens, so treating
 * it as success (charge) or failure (release + zero) would both be a guess. The
 * request is also never re-routed — a blind retry risks paying twice
 * (INVARIANT #12).
 */
export async function reconcileUnknownTerminals(client: PoolClient, limit = 100): Promise<number> {
  const rows = await client.query<{ id: string; tenant_id: string; charge_currency: string | null }>(
    `SELECT id, tenant_id, charge_currency
       FROM request_records
      WHERE status = 'unknown' AND reservation_released = false
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
  let flagged = 0
  for (const row of rows.rows) {
    const result = await openReconciliationCase(client, {
      tenantId: row.tenant_id,
      requestId: row.id,
      reason: 'unknown_completion',
      currency: row.charge_currency,
      note: 'upstream terminal outcome unknown; hold retained, no auto-retry',
    })
    if (result.created) flagged += 1
  }
  return flagged
}

/**
 * Release holds stranded past their TTL on requests that never reached any
 * terminal state (crashed gateway, lost settle call). The release frees the
 * available balance; the case keeps the *outcome* unresolved, so this is a
 * liquidity action, not a billing decision. A later authoritative usage event
 * can still charge the request normally.
 */
export async function releaseExpiredReservations(client: PoolClient, limit = 100): Promise<number> {
  const rows = await client.query<{
    id: string
    tenant_id: string
    charge_currency: string | null
    reservation_amount: string
  }>(
    `SELECT id, tenant_id, charge_currency, reservation_amount
       FROM request_records r
      WHERE r.status IN ('created','reserved','sent','streaming')
        AND r.reservation_released = false
        AND r.reservation_expires_at IS NOT NULL
        AND r.reservation_expires_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions lt
           WHERE lt.tenant_id = r.tenant_id
             AND lt.idempotency_key = 'reservation_release:' || r.id
        )
      ORDER BY r.reservation_expires_at
      LIMIT $1
      FOR UPDATE OF r SKIP LOCKED`,
    [limit],
  )
  let released = 0
  for (const row of rows.rows) {
    const currency = row.charge_currency ?? 'USD'
    const amount = await getReservedAmount(client, row.tenant_id, row.id, toMicros(row.reservation_amount))
    await releaseReservation(client, {
      tenantId: row.tenant_id,
      requestId: row.id,
      currency,
      amount,
      description: 'reservation expired without a terminal state',
    })
    await client.query(`UPDATE request_records SET reservation_released = true WHERE tenant_id = $1 AND id = $2`, [
      row.tenant_id,
      row.id,
    ])
    await openReconciliationCase(client, {
      tenantId: row.tenant_id,
      requestId: row.id,
      reason: 'reservation_timeout',
      expectedAmount: amount,
      currency,
      note: 'hold released on expiry; upstream outcome still unresolved',
    })
    released += 1
  }
  return released
}

/**
 * Re-derive recently settled charges from their pinned versions. A mismatch
 * means the stored amount and the pinned fact diverged — the historical bill is
 * no longer reproducible, which is exactly what the invariant forbids. Nothing
 * is auto-corrected; a case is opened with both numbers.
 */
export async function auditSettledCharges(client: PoolClient, limit = 100): Promise<number> {
  const rows = await client.query<RequestRecordRow>(
    `SELECT id, tenant_id, channel_kind, status, provider_price_version_id, sale_price_snapshot_id,
            exchange_rate_snapshot_id, reservation_amount, reservation_released, charge_amount,
            charge_currency, upstream_cost_amount, upstream_cost_currency, resolved_provider_id,
            resolved_upstream_model_id, request_model,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens
       FROM request_records
      WHERE status = 'completed' AND charge_amount > 0 AND provider_price_version_id IS NOT NULL
      ORDER BY completed_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  )
  let mismatches = 0
  for (const request of rows.rows) {
    const audit = await recomputeRequestCharge(client, request.tenant_id, request)
    if (!audit.computable || audit.matchesStored) continue
    const result = await openReconciliationCase(client, {
      tenantId: request.tenant_id,
      requestId: request.id,
      reason: 'amount_mismatch',
      expectedAmount: audit.recomputedChargeAmount,
      actualAmount: audit.storedChargeAmount,
      currency: request.charge_currency,
      note: `recompute[${audit.roundingVersion}] does not match stored charge`,
    })
    if (result.created) mismatches += 1
  }
  return mismatches
}

/**
 * Run all reconciliation jobs in one transaction. The worker calls this on a
 * slower cadence than the outbox poll; it is also safe to invoke ad hoc.
 */
export async function runReconciliation(
  existingClient?: PoolClient,
  options: { limit?: number } = {},
): Promise<ReconciliationSummary> {
  const limit = options.limit ?? 100
  if (existingClient) return runJobs(existingClient, limit)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const summary = await runJobs(client, limit)
    await client.query('COMMIT')
    return summary
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function runJobs(client: PoolClient, limit: number): Promise<ReconciliationSummary> {
  return {
    unknownFlagged: await reconcileUnknownTerminals(client, limit),
    reservationsReleased: await releaseExpiredReservations(client, limit),
    amountMismatches: await auditSettledCharges(client, limit),
  }
}

function toMicros(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n
  return typeof value === 'bigint' ? value : BigInt(value)
}
