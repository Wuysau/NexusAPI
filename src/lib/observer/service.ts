import type { Pool, PoolClient } from 'pg'
import { ObserverBusyError, scanCodex, type ObserverConfig, type ObserverScope } from './importer'
import { ObserverConfigurationError, readActiveObserverConfig, type ObserverSettings } from './configuration'

export type ObserverState =
  'running' | 'syncing' | 'idle' | 'not_configured' | 'source_unavailable' | 'error' | 'stopped'
export interface ObserverResult {
  scannedFiles: number
  newSessions: number
  newEvents: number
  skippedDuplicates: number
  unassignedEvents: number
  bytesRead: number
  warnings: number
  durationMs: number
  sourceErrors?: Array<{ tool: string; code: string }>
}
export interface ObserverRuntime {
  state: ObserverState
  enabled: boolean
  interval_seconds: number
  heartbeat_at: Date
  last_sync_started_at: Date | null
  last_sync_completed_at: Date | null
  last_successful_sync_at: Date | null
  last_error: string | null
  next_sync_at: Date | null
  last_new_sessions: number
  last_new_events: number
  last_unassigned_events: number
  last_result: Partial<ObserverResult>
  requested_at: Date | null
}
const where = 'tenant_id=$1 AND organization_id=$2 AND instance_id=$3'
const params = (scope: ObserverScope, settings: ObserverSettings) => [
  scope.tenantId,
  scope.organizationId,
  settings.instanceId,
]
export async function readObserverRuntime(pool: Pool | PoolClient, scope: ObserverScope, settings: ObserverSettings) {
  const row = (
    await pool.query<ObserverRuntime>(
      `SELECT state,enabled,interval_seconds,heartbeat_at,last_sync_started_at,last_sync_completed_at,
      last_successful_sync_at,last_error,next_sync_at,last_new_sessions,last_new_events,last_unassigned_events,
      last_result,requested_at FROM observer_runtime WHERE ${where}`,
      params(scope, settings),
    )
  ).rows[0]
  if (!row) return null
  if (Date.now() - new Date(row.heartbeat_at).getTime() > 20000) {
    row.state = 'stopped'
    row.next_sync_at = null
  }
  return row
}

/** Durable Web-to-worker request, never starts a scan in the HTTP process. */
export async function requestObserverSync(pool: Pool | PoolClient, scope: ObserverScope, settings: ObserverSettings) {
  const accepted = await pool.query(
    `UPDATE observer_runtime SET requested_at=now() WHERE ${where} AND state NOT IN ('syncing','stopped','not_configured')
      AND requested_at IS NULL AND heartbeat_at>now()-interval '20 seconds' RETURNING instance_id`,
    params(scope, settings),
  )
  if (accepted.rowCount) return 'queued' as const
  const row = await readObserverRuntime(pool, scope, settings)
  if (!row || row.state === 'stopped') return 'worker_unavailable' as const
  return 'already_syncing' as const
}

export function safeObserverError(error: unknown) {
  if (error instanceof ObserverConfigurationError) return 'invalid_configuration'
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String((error as NodeJS.ErrnoException)?.code)))
    return 'source_unavailable'
  return 'sync_failed'
}

/** Independent process controller. tick is serialized; heartbeats continue during a long scan. */
export class ObserverService {
  private lease: PoolClient | null = null
  private config: ObserverConfig | null = null
  private configIdentity = ''
  private dueAt = 0
  private current: Promise<string> | null = null
  private closing = false
  private pulseTimer: ReturnType<typeof setInterval> | null = null
  private pulsing = false
  constructor(
    private pool: Pool,
    private settings: ObserverSettings,
  ) {}

  tick(): Promise<string> {
    if (this.closing) return Promise.resolve('stopped')
    if (this.current) return Promise.resolve('already_syncing')
    this.current = this.runTick().finally(() => {
      this.current = null
    })
    return this.current
  }

  private async update(sql: string, values: unknown[] = []) {
    if (!this.config || !this.lease) return
    await this.lease.query(`UPDATE observer_runtime SET ${sql} WHERE ${where}`, [
      ...params(this.config, this.settings),
      ...values,
    ])
  }

  private async heartbeat() {
    if (!this.lease || this.pulsing) return
    this.pulsing = true
    try {
      await this.update('heartbeat_at=now()')
    } catch {
      /* DB outage is retried by tick; no raw database errors in logs. */
    } finally {
      this.pulsing = false
    }
  }

  private async acquire() {
    if (this.lease) return true
    const lease = await this.pool.connect()
    try {
      const locked = (
        await lease.query('SELECT pg_try_advisory_lock(hashtext($1)) locked', [
          'observer-worker:' + this.settings.instanceId,
        ])
      ).rows[0].locked
      if (!locked) {
        lease.release()
        return false
      }
      this.lease = lease
      lease.on('error', () => {
        if (this.lease === lease) {
          this.lease = null
          this.configIdentity = ''
          lease.release(true)
        }
      })
      if (!this.pulseTimer) this.pulseTimer = setInterval(() => void this.heartbeat(), 5000)
      return true
    } catch (error) {
      lease.release(true)
      throw error
    }
  }

  private async runTick(): Promise<string> {
    try {
      if (!(await this.acquire())) return 'already_running'
      const config = await readActiveObserverConfig(this.settings)
      if (!config) {
        await this.update(
          "state='not_configured',last_error=NULL,next_sync_at=NULL,requested_at=NULL,heartbeat_at=now()",
        )
        this.configIdentity = ''
        return 'not_configured'
      }
      const identity = JSON.stringify(config)
      if (identity !== this.configIdentity) {
        if (
          this.config &&
          (this.config.tenantId !== config.tenantId || this.config.organizationId !== config.organizationId)
        )
          await this.update("state='stopped',next_sync_at=NULL,requested_at=NULL")
        this.config = config
        await this.lease!.query(
          `INSERT INTO observer_runtime(tenant_id,organization_id,instance_id,state,enabled,interval_seconds)
           VALUES($1,$2,$3,'running',$4,$5) ON CONFLICT(tenant_id,organization_id,instance_id)
           DO UPDATE SET state='running',enabled=excluded.enabled,interval_seconds=excluded.interval_seconds,heartbeat_at=now()`,
          [...params(config, this.settings), this.settings.enabled, this.settings.intervalSeconds],
        )
        this.configIdentity = identity
        this.dueAt = 0
      }
      const row = await readObserverRuntime(this.pool, config, this.settings)
      if (!row?.requested_at && (!this.settings.enabled || Date.now() < this.dueAt)) {
        if (!this.settings.enabled && row?.state === 'running') await this.update("state='idle',next_sync_at=NULL")
        return row?.state ?? 'idle'
      }
      const started = Date.now()
      await this.update(
        "state='syncing',last_sync_started_at=now(),last_error=NULL,next_sync_at=NULL,requested_at=NULL,heartbeat_at=now()",
      )
      try {
        const result = await scanCodex(this.pool, config)
        const summary: ObserverResult = {
          scannedFiles: result.scannedFiles,
          newSessions: result.newSessions,
          newEvents: result.newEvents,
          skippedDuplicates: result.skippedDuplicates,
          unassignedEvents: result.unassignedEvents,
          bytesRead: result.bytesRead,
          warnings: result.warnings,
          durationMs: Date.now() - started,
          sourceErrors: result.sourceErrors,
        }
        this.dueAt = Date.now() + this.settings.intervalSeconds * 1000
        await this.update(
          "state='idle',last_sync_completed_at=now(),last_successful_sync_at=now(),last_error=NULL,heartbeat_at=now(),next_sync_at=$4,last_new_sessions=$5,last_new_events=$6,last_unassigned_events=$7,last_result=$8::jsonb",
          [
            this.settings.enabled ? new Date(this.dueAt) : null,
            summary.newSessions,
            summary.newEvents,
            summary.unassignedEvents,
            JSON.stringify(summary),
          ],
        )
        return 'idle'
      } catch (error) {
        if (error instanceof ObserverBusyError) {
          this.dueAt = Date.now() + 1000
          await this.update("state='running',requested_at=$4,next_sync_at=$5", [
            row?.requested_at ?? null,
            new Date(this.dueAt),
          ])
          return 'already_syncing'
        }
        this.dueAt = Date.now() + this.settings.intervalSeconds * 1000
        const code = safeObserverError(error)
        const state = code === 'source_unavailable' ? code : 'error'
        await this.update('state=$4,last_error=$5,last_sync_completed_at=now(),next_sync_at=$6,heartbeat_at=now()', [
          state,
          code,
          this.settings.enabled ? new Date(this.dueAt) : null,
        ])
        return state
      }
    } catch (error) {
      try {
        await this.update("state='error',last_error=$4,next_sync_at=NULL", [safeObserverError(error)])
      } catch {
        /* retry on next tick */
      }
      return 'error'
    }
  }

  async stop() {
    this.closing = true
    if (this.pulseTimer) clearInterval(this.pulseTimer)
    await this.current
    try {
      await this.update("state='stopped',next_sync_at=NULL,heartbeat_at=now()")
    } finally {
      // Destroy the dedicated lease connection, releasing all session locks even on DB failure.
      this.lease?.release(true)
      this.lease = null
    }
  }
}
