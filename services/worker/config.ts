// Worker configuration — fail closed.
//
// A worker that starts without a database URL, or with a nonsensical retry
// policy, must not fall back to a default that silently mis-bills. Every value
// is validated at startup and the process refuses to run otherwise.

export interface WorkerConfig {
  databaseUrl: string
  /** How often the outbox is polled. Default 5s (brief). */
  pollIntervalMs: number
  /** Events claimed per poll, in one transaction. */
  batchSize: number
  /** Attempts (including the first) before an event is dead-lettered. */
  maxAttempts: number
  /** First retry delay; doubles per attempt up to backoffMaxMs. */
  backoffBaseMs: number
  backoffMaxMs: number
  /** How often the reconciliation jobs run. Default 60s. */
  reconcileIntervalMs: number
  /** Included in audit metadata and outbox claimed_by. */
  workerId: string
}

const DEFAULTS = {
  pollIntervalMs: 5_000,
  batchSize: 25,
  maxAttempts: 5,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  reconcileIntervalMs: 60_000,
}

function positiveInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[worker:config] ${name} must be an integer in [${min}, ${max}], got "${raw}"`)
  }
  return value
}

export function loadWorkerConfig(source: Record<string, string | undefined> = process.env): WorkerConfig {
  const databaseUrl = source.DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) {
    throw new Error('[worker:config] DATABASE_URL is required (fail-closed)')
  }
  const workerId = source.WORKER_ID?.trim() || `worker-${process.pid}`

  return {
    databaseUrl,
    workerId,
    pollIntervalMs: positiveInt(source.WORKER_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs, 100, 3_600_000, 'WORKER_POLL_INTERVAL_MS'),
    batchSize: positiveInt(source.WORKER_BATCH_SIZE, DEFAULTS.batchSize, 1, 1_000, 'WORKER_BATCH_SIZE'),
    maxAttempts: positiveInt(source.WORKER_MAX_ATTEMPTS, DEFAULTS.maxAttempts, 1, 100, 'WORKER_MAX_ATTEMPTS'),
    backoffBaseMs: positiveInt(source.WORKER_BACKOFF_BASE_MS, DEFAULTS.backoffBaseMs, 100, 3_600_000, 'WORKER_BACKOFF_BASE_MS'),
    backoffMaxMs: positiveInt(source.WORKER_BACKOFF_MAX_MS, DEFAULTS.backoffMaxMs, 100, 86_400_000, 'WORKER_BACKOFF_MAX_MS'),
    reconcileIntervalMs: positiveInt(
      source.WORKER_RECONCILE_INTERVAL_MS,
      DEFAULTS.reconcileIntervalMs,
      1_000,
      86_400_000,
      'WORKER_RECONCILE_INTERVAL_MS',
    ),
  }
}

/** Exponential backoff for the given (already incremented) attempt count. */
export function backoffMs(config: WorkerConfig, attempt: number): number {
  if (attempt <= 1) return config.backoffBaseMs
  const delay = config.backoffBaseMs * 2 ** (attempt - 1)
  return Math.min(config.backoffMaxMs, delay)
}
