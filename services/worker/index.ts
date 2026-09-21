// Worker entry point.
//
// One process, two cadences:
//   - every WORKER_POLL_INTERVAL_MS: claim + process one outbox batch,
//   - every WORKER_RECONCILE_INTERVAL_MS: run the reconciliation jobs.
//
// Run the compiled artifact with: node dist/worker.cjs
// See services/worker/README.md for the environment contract and the migration
// prerequisite.
//
// Graceful shutdown: SIGINT/SIGTERM stop the loop after the in-flight batch
// commits. A kill -9 is also safe — the batch transaction rolls back and the
// events become claimable again (ADR-0005, INVARIANT #9).

import 'dotenv/config'
import { pool } from '@/db'
import { loadWorkerConfig } from './config'
import { Logger } from '@/../packages/observability/logger'
import { metrics } from '@/../packages/observability/metrics'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'

export { assertWorkerSchema, runWorkerTick } from './tick'
import { assertWorkerSchema, runWorkerTick } from './tick'

function log(message: string, fields: Record<string, unknown> = {}): void {
  workerLogger.info(message, fields)
}

const workerLogger = new Logger({ service: 'worker', worker_id: process.env.WORKER_ID })

const heartbeatPath = () => process.env.WORKER_HEARTBEAT_FILE || join(tmpdir(), 'nexus-worker-heartbeat.json')

/** Health probes require recent committed work, a live Worker and the retry schema. */
export async function checkWorkerReadiness(): Promise<void> {
  const config = loadWorkerConfig()
  const heartbeat = JSON.parse(await readFile(heartbeatPath(), 'utf8')) as { pid: number; completedAt: number }
  const age = Date.now() - heartbeat.completedAt
  if (
    !Number.isInteger(heartbeat.pid) ||
    heartbeat.pid <= 0 ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 2 * config.pollIntervalMs
  ) {
    throw new Error('worker heartbeat unavailable or stale')
  }
  process.kill(heartbeat.pid, 0)
  const healthPool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  })
  try {
    const client = await healthPool.connect()
    try {
      await assertWorkerSchema(client)
    } finally {
      client.release()
    }
  } finally {
    await healthPool.end()
  }
}

async function writeHeartbeat(): Promise<void> {
  const file = heartbeatPath()
  try {
    await writeFile(`${file}.next`, JSON.stringify({ pid: process.pid, completedAt: Date.now() }), { mode: 0o600 })
    await rename(`${file}.next`, file)
  } catch {
    await unlink(file).catch(() => {})
    log('heartbeat unavailable', { error_kind: 'heartbeat_write_failed' })
  }
}

async function main(): Promise<void> {
  const config = loadWorkerConfig()
  workerLogger.child({ worker_id: config.workerId })
  log('starting', { worker_id: config.workerId })

  let running = true
  const shutdown = new AbortController()
  const stop = () => {
    running = false
    shutdown.abort()
    log('shutdown requested; finishing the current batch')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    await unlink(heartbeatPath()).catch(() => {})
    const bootstrap = await pool.connect()
    try {
      await assertWorkerSchema(bootstrap)
    } finally {
      bootstrap.release()
    }

    const reconcileEveryTicks = Math.max(1, Math.ceil(config.reconcileIntervalMs / config.pollIntervalMs))
    let ticksSinceReconcile = 0

    while (running) {
      const client = await pool.connect()
      try {
        const reconcile = ticksSinceReconcile >= reconcileEveryTicks
        const result = await runWorkerTick(client, config, { reconcile })
        // This is outside the committed transaction: readiness failure never
        // changes accounting or makes a committed batch run again.
        await writeHeartbeat()
        ticksSinceReconcile = reconcile ? 0 : ticksSinceReconcile + 1
        if (result.published || result.retried || result.deadLettered) {
          log('batch', {
            published_count: result.published,
            retried_count: result.retried,
            dead_letter_count: result.deadLettered,
          })
          // F7: outbox age, duplicate, dead-letter metrics (ADR-0005).
          metrics.published().inc(result.published)
          metrics.retried().inc(result.retried)
          metrics.deadLetters().inc(result.deadLettered)
        }
      } catch (error) {
        log('batch failed; events stay claimable', { error_kind: error instanceof Error ? error.name : 'unknown' })
      } finally {
        client.release()
      }
      if (running)
        await delay(config.pollIntervalMs, undefined, { signal: shutdown.signal }).catch((error) => {
          if ((error as Error).name !== 'AbortError') throw error
        })
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await unlink(heartbeatPath()).catch(() => {})
    await pool.end()
  }
  log('stopped')
}

void (process.argv.includes('--healthcheck') ? checkWorkerReadiness() : main()).catch((error) => {
  workerLogger.error('fatal', {
    error_kind: error instanceof Error ? error.name : 'unknown',
  })
  process.exitCode = 1
})
