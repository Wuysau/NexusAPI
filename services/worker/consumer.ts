// Outbox consumer — the relay half of ADR-0005.
//
// Claiming: one transaction per poll, `SELECT ... FOR UPDATE SKIP LOCKED`, plus a
// poll-level advisory lock so two worker instances never sweep the same batch.
// The row locks are the real claim: they are released by COMMIT/ROLLBACK even if
// the process is killed mid-batch, so a crash simply makes the events claimable
// again. `claimed_by`/`claimed_at` are observability only.
//
// Per-event isolation: each event runs inside a SAVEPOINT. A failure rolls back
// everything that event did (usage anchor, ledger postings, projections, audit)
// and then records the retry/dead-letter bookkeeping, leaving the rest of the
// batch unaffected.
//
// Idempotency: processing is safe to repeat because the ledger idempotency keys
// are derived from the request id (pipeline.ts) and the usage_events anchor is
// unique per (tenant_id, event_id). This is what makes at-least-once delivery
// safe (INVARIANT #9, ADR-0005).

import { logAudit } from '@/lib/audit'
import { BillingPermanentError } from '@/lib/billing/pipeline'
import { backoffMs, type WorkerConfig } from './config'
import { processOutboxEvent, type OutboxEventRow, type ProcessOutcome } from './processor'
import type { PoolClient } from 'pg'

const POLL_LOCK_KEY = 'nexus:worker:outbox'

export interface PollSummary {
  /** Another instance holds the poll lock. */
  skipped: boolean
  claimed: number
  published: number
  retried: number
  deadLettered: number
  outcomes: Record<string, number>
}

/**
 * Claim and process one batch. The CALLER owns the transaction — the worker loop
 * wraps this in BEGIN/COMMIT, and a test can wrap it in BEGIN/ROLLBACK to
 * simulate a crash between claim and commit.
 */
export async function pollOutboxOnce(client: PoolClient, config: WorkerConfig): Promise<PollSummary> {
  const summary: PollSummary = { skipped: false, claimed: 0, published: 0, retried: 0, deadLettered: 0, outcomes: {} }

  const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`, [
    POLL_LOCK_KEY,
  ])
  if (!lock.rows[0]?.locked) {
    summary.skipped = true
    return summary
  }

  const claimed = await client.query<OutboxEventRow>(
    `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, attempts
       FROM outbox_events
      WHERE status = 'pending'
        AND attempts < $2
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [config.batchSize, config.maxAttempts],
  )
  summary.claimed = claimed.rows.length

  for (const row of claimed.rows) {
    await client.query('SAVEPOINT nexus_event')
    try {
      const result = await processOutboxEvent(client, row)
      await client.query(
        `UPDATE outbox_events
            SET status = 'published', published_at = now(), claimed_by = $2, claimed_at = now(), last_error = NULL
          WHERE id = $1 AND tenant_id = $3`,
        [row.id, config.workerId, row.tenant_id],
      )
      await client.query('RELEASE SAVEPOINT nexus_event')
      summary.published += 1
      summary.outcomes[result.disposition] = (summary.outcomes[result.disposition] ?? 0) + 1
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT nexus_event')
      const attempt = row.attempts + 1
      const permanent = error instanceof BillingPermanentError
      const deadLetter = permanent || attempt >= config.maxAttempts
      const message = redactError(error)

      if (deadLetter) {
        await client.query(
          `UPDATE outbox_events
              SET status = 'failed', attempts = $2, last_error = $3, claimed_by = $4, claimed_at = now(),
                  next_attempt_at = NULL
            WHERE id = $1 AND tenant_id = $5`,
          [row.id, attempt, message, config.workerId, row.tenant_id],
        )
        summary.deadLettered += 1
        await auditDeadLetter(client, config, row, attempt, message, permanent)
      } else {
        const delay = backoffMs(config, attempt)
        await client.query(
          `UPDATE outbox_events
              SET status = 'pending', attempts = $2, last_error = $3, claimed_by = $4, claimed_at = now(),
                  next_attempt_at = now() + ($5::int * interval '1 millisecond')
            WHERE id = $1 AND tenant_id = $6`,
          [row.id, attempt, message, config.workerId, delay, row.tenant_id],
        )
        summary.retried += 1
      }
    }
  }

  return summary
}

export type { ProcessOutcome }

async function auditDeadLetter(
  client: PoolClient,
  config: WorkerConfig,
  row: OutboxEventRow,
  attempt: number,
  message: string,
  permanent: boolean,
): Promise<void> {
  // Its own savepoint: audit must never take the failed event's batch down with
  // it (the transaction may already be poisoned from the original error path).
  await client.query('SAVEPOINT nexus_audit')
  try {
    await logAudit({
      tenantId: row.tenant_id,
      action: 'billing.outbox_dead_letter',
      targetType: 'outbox_event',
      targetId: row.id,
      metadata: {
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        attempt,
        permanent,
        workerId: config.workerId,
        error: message,
      },
      client,
    })
    await client.query('RELEASE SAVEPOINT nexus_audit')
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT nexus_audit')
  }
}

/** Keep error text safe for storage: no upstream bodies, bounded length. */
function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}
