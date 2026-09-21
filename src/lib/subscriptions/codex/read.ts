import { pool } from '@/db'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { connectionVisibility, observedVisibility, workspaceParams, WorkspaceError } from '@/lib/workspace/management'
import { presentQuota, type QuotaRow } from '@/lib/quota/read'
import type { AccountObservation, ObservedProjectActivity } from './types'

export async function readCodexAccountConnection(ctx: ControlPlaneContext, id: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const params = [...workspaceParams(ctx), id]
    const row = (
      await client.query<{ account_observation: AccountObservation | null }>(
        `SELECT c.account_observation FROM owned_connections c WHERE ${connectionVisibility} AND c.id=$5
       AND c.mode='subscription_interactive' AND c.provider='openai'`,
        params,
      )
    ).rows[0]
    if (!row) throw new WorkspaceError('not_found', '连接不存在', 404)
    const saved = row.account_observation?.organizationId === ctx.organizationId ? row.account_observation : null
    const quota = saved?.quota
      ? (
          await client.query<QuotaRow>(
            `SELECT * FROM quota_snapshots WHERE tenant_id=$1 AND connection_id=$2 AND source='codex_app_server'
       AND observation_id=ANY($3::text[]) ORDER BY window_type`,
            [ctx.tenantId, id, saved.quota.observationIds],
          )
        ).rows.map((q) => presentQuota(q))
      : []
    // Null token dimensions stay unknown if any contributing event omitted that dimension.
    const sums = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens']
      .map(
        (column, i) =>
          `CASE WHEN count(${column})=count(*) THEN sum(${column})::text ELSE NULL END "${['input', 'cached', 'output', 'reasoning', 'total'][i]}"`,
      )
      .join(',')
    const activity = (
      await client.query<ObservedProjectActivity>(
        `SELECT e.project_id "projectId",max(e.project_name) "projectName",count(DISTINCT external_session_id)::text sessions,
       count(*)::text events,${sums},array_remove(array_agg(DISTINCT model),NULL) models,max(occurred_at) "lastActivity"
       FROM external_observed_usage e WHERE ${observedVisibility} AND e.connection_id=$5
       GROUP BY e.project_id ORDER BY max(occurred_at) DESC`,
        params,
      )
    ).rows
    await client.query('COMMIT')
    // Do not expose internal account identity hashes or workspace binding identifiers.
    const observation = saved
      ? {
          source: saved.source,
          authority: saved.authority,
          scope: saved.scope,
          status: saved.status,
          lastAttemptAt: saved.lastAttemptAt,
          lastSuccessfulSyncAt: saved.lastSuccessfulSyncAt,
          lastSyncError: saved.lastSyncError,
          account: saved.account,
          usage: saved.usage,
          quota: saved.quota,
        }
      : null
    return { observation, quotas: quota, activity }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
