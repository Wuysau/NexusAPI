import { runReconciliation } from '@/lib/billing/reconcile'
import { pollOutboxOnce } from './consumer'
import type { WorkerConfig } from './config'
import type { PoolClient } from 'pg'

const REQUIRED_OUTBOX_COLUMNS = ['next_attempt_at', 'claimed_by', 'claimed_at'] as const

/**
 * Fail closed if the worker's retry columns are missing. They arrive with
 * drizzle/0003_worker_outbox_retry.sql; starting without them would silently
 * disable backoff and dead-lettering.
 */
export async function assertWorkerSchema(client: PoolClient): Promise<void> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'outbox_events'
        AND column_name = ANY($1::text[])`,
    [[...REQUIRED_OUTBOX_COLUMNS]],
  )
  const present = new Set(result.rows.map((row) => row.column_name))
  const missing = REQUIRED_OUTBOX_COLUMNS.filter((column) => !present.has(column))
  if (missing.length) {
    throw new Error(
      `[worker] outbox_events is missing ${missing.join(', ')}; apply drizzle/0003_worker_outbox_retry.sql before starting the worker`,
    )
  }
}

export interface TickResult {
  published: number
  retried: number
  deadLettered: number
  reconciliation: Awaited<ReturnType<typeof runReconciliation>> | null
}

/**
 * One poll cycle in a single transaction. Exported so an operator (or a smoke
 * test) can run the worker once without starting the loop.
 */
export async function runWorkerTick(
  client: PoolClient,
  config: WorkerConfig,
  options: { reconcile?: boolean } = {},
): Promise<TickResult> {
  await client.query('BEGIN')
  try {
    const poll = await pollOutboxOnce(client, config)
    const reconciliation = options.reconcile ? await runReconciliation(client, { limit: config.batchSize }) : null
    await client.query('COMMIT')
    return {
      published: poll.published,
      retried: poll.retried,
      deadLettered: poll.deadLettered,
      reconciliation,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

