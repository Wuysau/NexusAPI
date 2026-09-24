import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ResourceObservation } from '../local-agent/adapter'
import type { TaskScope } from './store'
import { TaskRuntimeError } from './configuration'

/** Local adapter supplies official, profile-specific account/limits. No auth payload crosses this boundary. */
export async function recordProfileQuota(
  client: PoolClient,
  scope: TaskScope,
  connectionId: string,
  observation: ResourceObservation,
) {
  const { account, quotas, identity, source } = observation
  await client.query('BEGIN')
  try {
    const row = (
      await client.query(
        `SELECT account_observation FROM owned_connections WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL
      AND (project_id=$3 OR project_id IS NULL) FOR UPDATE`,
        [scope.tenantId, connectionId, scope.projectId],
      )
    ).rows[0]
    if (!row) throw new TaskRuntimeError('connection_unavailable')
    const previous = row.account_observation
    if (
      previous &&
      (previous.organizationId !== scope.organizationId || (previous.identity && previous.identity !== identity))
    )
      throw new TaskRuntimeError('profile_account_mismatch')
    const ids: string[] = []
    const now = new Date().toISOString()
    for (const q of quotas) {
      const id = randomUUID()
      ids.push(id)
      await client.query(
        `INSERT INTO quota_snapshots(tenant_id,connection_id,observation_id,window_type,used,remaining,source,source_kind,confidence,scope,attribution_mode,availability,observed_at,stale_at,reset_at,provenance_version,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$11,'official','reported','account','shared',$7,$8,$8::timestamptz+interval '5 minutes',$9,1,$10::jsonb)`,
        [
          scope.tenantId,
          connectionId,
          id,
          q.windowType,
          q.used,
          q.remaining,
          q.used === null ? 'unknown' : 'available',
          now,
          q.resetAt,
          JSON.stringify(q.metadata),
          source,
        ],
      )
    }
    await client.query(
      "UPDATE owned_connections SET account_observation=$3::jsonb,status=CASE WHEN status='pending' THEN 'active' ELSE status END,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [
        scope.tenantId,
        connectionId,
        JSON.stringify({
          ...previous,
          source,
          authority: 'provider_reported',
          scope: 'account',
          organizationId: scope.organizationId,
          identity,
          status: 'connected',
          lastAttemptAt: now,
          lastSuccessfulSyncAt: now,
          lastSyncError: null,
          account: { ...account, observedAt: now },
          quota: { observationIds: ids, observedAt: now },
        }),
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function recordRuntimeFailure(client: PoolClient, scope: TaskScope, connectionId: string, reason: string) {
  const state =
    reason === 'quota_exhausted' ? 'exhausted' : reason === 'rate_limit' ? 'rate_limited' : 'temporarily_unavailable'
  const observation = {
    state,
    reason,
    source: 'tool_runtime',
    observedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 60000).toISOString(),
  }
  await client.query(
    'UPDATE owned_connections SET runtime_observation=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
    [scope.tenantId, connectionId, JSON.stringify(observation)],
  )
}
