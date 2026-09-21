import { createHash, randomUUID } from 'node:crypto'
import { pool } from '@/db'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { resolveQuotaConnection } from '@/lib/quota/access'
import { WorkspaceError } from '@/lib/workspace/management'
import { connectCodexAccount, CodexClientError } from './client'
import { mapAccount, mapQuotas, mapUsage } from './mapper'
import type { AccountObservation } from './types'

const state = globalThis as typeof globalThis & { nexusCodexAccountBusy?: boolean }
export function localAccountRequestAllowed(req: Request, mutation = false) {
  try {
    const origin = new URL(process.env.NEXUS_DESKTOP_ORIGIN ?? '')
    return (
      process.env.NODE_ENV !== 'production' &&
      ['http:', 'https:'].includes(origin.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      origin.origin === process.env.NEXUS_DESKTOP_ORIGIN &&
      req.headers.get('host') === origin.host &&
      (!mutation || req.headers.get('origin') === origin.origin)
    )
  } catch {
    return false
  }
}

async function authorize(ctx: ControlPlaneContext, id: string) {
  const c = await resolveQuotaConnection(pool, ctx, id, { write: true })
  if (!['owner', 'admin'].includes(c.role) || c.mode !== 'subscription_interactive' || c.provider !== 'openai')
    throw new WorkspaceError('invalid_account_connection', '仅管理员可同步 OpenAI Codex 订阅连接', 403)
}
const safeError = (error: unknown) => (error instanceof CodexClientError ? error.code : 'sync_error')

/** Protected POST reads. Automatic quota refresh is independent of historical usage. */
export async function syncCodexAccountConnection(
  ctx: ControlPlaneContext,
  id: string,
  refresh: 'account' | 'quota' = 'account',
) {
  await authorize(ctx, id)
  if (state.nexusCodexAccountBusy)
    throw new WorkspaceError('account_sync_busy', '已有账户同步正在进行，请稍后刷新', 409)
  state.nexusCodexAccountBusy = true
  let rpc: Awaited<ReturnType<typeof connectCodexAccount>> | undefined
  const observedAt = new Date().toISOString()
  let account: ReturnType<typeof mapAccount> | undefined
  let quota: ReturnType<typeof mapQuotas> | undefined
  let usage: ReturnType<typeof mapUsage> | undefined
  let failure: string | null = null
  try {
    try {
      rpc = await connectCodexAccount()
      account = mapAccount(await rpc.read('account/read'))
      if (account && refresh === 'quota' && account.type !== 'chatgpt') {
        failure = 'quota:unsupported'
      } else if (account) {
        const results = await Promise.allSettled([
          rpc.read('account/rateLimits/read').then(mapQuotas),
          refresh === 'account' ? rpc.read('account/usage/read').then(mapUsage) : Promise.resolve(undefined),
        ])
        if (results[0].status === 'fulfilled') quota = results[0].value
        else failure = 'quota:' + safeError(results[0].reason)
        if (results[1].status === 'fulfilled') usage = results[1].value
        else failure = [failure, 'usage:' + safeError(results[1].reason)].filter(Boolean).join('; ')
      }
    } catch (error) {
      failure = safeError(error)
    } finally {
      rpc?.close()
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const authorized = await resolveQuotaConnection(client, ctx, id, { write: true, lock: true })
      if (
        !['owner', 'admin'].includes(authorized.role) ||
        authorized.mode !== 'subscription_interactive' ||
        authorized.provider !== 'openai'
      )
        throw new WorkspaceError('invalid_account_connection', '账户同步权限已变更，请重新登录后重试', 403)
      const previous = (
        await client.query<{ account_observation: AccountObservation | null }>(
          'SELECT account_observation FROM owned_connections WHERE tenant_id=$1 AND id=$2',
          [ctx.tenantId, id],
        )
      ).rows[0].account_observation
      if (previous && previous.organizationId !== ctx.organizationId)
        throw new WorkspaceError('account_scope_conflict', '账户观测已属于其他工作空间，请创建新连接', 409)
      const identity = account?.email
        ? createHash('sha256')
            .update(account.type + '\0' + account.email.toLowerCase())
            .digest('hex')
        : null
      // Never blend cached data from different accounts into one connection.
      const changed =
        account &&
        ((previous?.account && previous.account.type !== account.type) ||
          (previous?.identity && identity !== previous.identity))
      if (changed) {
        failure = 'account_changed'
        account = undefined
        quota = undefined
        usage = undefined
      }
      const observation: AccountObservation = {
        ...previous,
        source: 'codex_app_server',
        authority: 'provider_reported',
        scope: 'account',
        organizationId: ctx.organizationId,
        identity: previous?.identity ?? identity,
        status:
          failure === 'app_server_unavailable'
            ? 'app_server_unavailable'
            : failure
              ? 'sync_error'
              : account === null
                ? 'logged_out'
                : 'connected',
        lastAttemptAt: observedAt,
        lastSyncError: failure,
        lastSuccessfulSyncAt: !failure ? observedAt : (previous?.lastSuccessfulSyncAt ?? null),
      }
      if (account !== undefined) observation.account = account ? { ...account, observedAt } : null
      if (usage) observation.usage = { ...usage, observedAt }
      if (quota) {
        const observationIds: string[] = []
        for (const bucket of quota) {
          const observationId = randomUUID()
          await client.query(
            `INSERT INTO quota_snapshots(tenant_id,connection_id,observation_id,window_type,used,remaining,source,source_kind,
              confidence,scope,attribution_mode,availability,observed_at,stale_at,reset_at,provenance_version,metadata)
             VALUES($1,$2,$3,$4,$5,$6,'codex_app_server','official','reported','account','shared',$7,$8,$8::timestamptz + interval '5 minutes',$9,1,$10::jsonb)`,
            [
              ctx.tenantId,
              id,
              observationId,
              bucket.windowType,
              bucket.used,
              bucket.remaining,
              bucket.used === null ? 'unknown' : 'available',
              observedAt,
              bucket.resetAt,
              JSON.stringify(bucket.metadata),
            ],
          )
          observationIds.push(observationId)
        }
        observation.quota = { observationIds, observedAt }
      }
      await client.query(
        'UPDATE owned_connections SET account_observation=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [ctx.tenantId, id, JSON.stringify(observation)],
      )
      await client.query('COMMIT')
      return { status: observation.status, lastSyncError: failure }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    state.nexusCodexAccountBusy = false
  }
}
