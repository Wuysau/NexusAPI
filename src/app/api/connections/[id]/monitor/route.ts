import { pool } from '@/db'
import { AuthzError, hasCapability, isRole } from '@/lib/auth/capabilities'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
import {
  collectorAccounts,
  CollectorError,
  normalizeCollectorSnapshot,
  readCollectorObservation,
} from '@/lib/subscriptions/collector'
import { collectorConfigured, fetchCollectorSnapshot, readCollectorJson } from '@/lib/subscriptions/collector-fetch'
import { collectorProviders } from '@/lib/subscriptions/collector-providers'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  requireContext,
  routeError,
  type ControlPlaneContext,
} from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'
type Connection = {
  id: string
  owner_user_id: string | null
  product: string | null
  mode: string
  account_observation: unknown
}
type Database = { query: (sql: string, values: unknown[]) => Promise<{ rows: Connection[] }> }
async function connection(db: Database, ctx: ControlPlaneContext, id: string, lock = false) {
  const result = await db.query(
    `SELECT c.id,c.owner_user_id,c.mode,c.capabilities->>'subscription_product' product,c.account_observation
     FROM owned_connections c WHERE ${connectionVisibility} AND c.id=$5 AND c.revoked_at IS NULL
     AND (c.account_observation IS NULL OR c.account_observation->>'organizationId'=$2)${lock ? ' FOR UPDATE OF c' : ''}`,
    [...workspaceParams(ctx), id],
  )
  const row = result.rows[0]
  if (!row) throw new AuthzError('tenant_isolation', '连接不存在', 404)
  if (row.mode !== 'subscription_interactive' || !row.product || !collectorProviders(row.product).length)
    throw new CollectorError('unsupported_subscription')
  return row
}
function canManage(ctx: ControlPlaneContext, row: Connection) {
  return (
    ['owner', 'admin'].includes(ctx.membership.role) ||
    (ctx.membership.role === 'developer' && row.owner_user_id === ctx.session.userId)
  )
}
const collectorResponse = (value: unknown) => {
  const response = jsonOk(value)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
function fail(error: unknown) {
  if (error instanceof CollectorError)
    return apiError(error.status, error.code, `采集未完成（${error.code}），请检查采集器配置与账户绑定。`)
  return routeError(error)
}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const { id } = await params
    const row = await connection(pool, ctx, id)
    return collectorResponse({
      observation: readCollectorObservation(row.account_observation, ctx.organizationId),
      providers: collectorProviders(row.product!),
      configured: collectorConfigured(ctx.tenantId, ctx.organizationId),
      canManage: canManage(ctx, row),
      canRefresh: ['owner', 'admin'].includes(ctx.membership.role),
    })
  } catch (error) {
    return fail(error)
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    const { id } = await params
    const initial = await connection(pool, ctx, id)
    if (!canManage(ctx, initial)) throw new AuthzError('tenant_isolation', '连接不存在', 404)
    const body = (await readCollectorJson(req.body)) as Record<string, unknown>
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['action', 'providerId', 'accountId', 'snapshot'].includes(key)) ||
      !['preview', 'import', 'refresh'].includes(String(body.action))
    )
      throw new CollectorError('invalid_monitor_request')
    const previous = readCollectorObservation(initial.account_observation, ctx.organizationId)
    const providerId = body.action === 'refresh' ? previous?.providerId : body.providerId
    const accountId = body.action === 'refresh' ? previous?.accountId : body.accountId
    if (typeof providerId !== 'string' || !collectorProviders(initial.product!).includes(providerId))
      throw new CollectorError('invalid_provider_binding')
    if (
      body.action === 'refresh' &&
      (body.snapshot !== undefined || body.providerId !== undefined || body.accountId !== undefined)
    )
      throw new CollectorError('invalid_monitor_request')
    // A developer could forge an imported binding to a guessed account. Every shared collector read needs admin.
    if (body.snapshot === undefined && !['owner', 'admin'].includes(ctx.membership.role))
      throw new AuthzError('forbidden', '服务器采集器读取需要管理员权限')
    let observation
    try {
      const snapshot =
        body.snapshot === undefined
          ? await fetchCollectorSnapshot(ctx.tenantId, ctx.organizationId, providerId)
          : body.snapshot
      if (body.action === 'preview') return collectorResponse({ accounts: collectorAccounts(snapshot, providerId) })
      if (typeof accountId !== 'string') throw new CollectorError('invalid_account_binding')
      observation = normalizeCollectorSnapshot(snapshot, { providerId, accountId }, ctx.organizationId)
    } catch (error) {
      if (body.action !== 'refresh' || !previous || !(error instanceof CollectorError)) throw error
      observation = {
        ...previous,
        state: 'error' as const,
        receivedAt: new Date().toISOString(),
        errorCode: 'collection_failed',
      }
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const membership = await client.query<{ role: string }>(
        `SELECT m.role FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id AND o.tenant_id=m.tenant_id
         WHERE m.tenant_id=$1 AND m.organization_id=$2 AND m.user_id=$3
         AND o.status='active' AND o.deleted_at IS NULL FOR SHARE OF m,o`,
        [ctx.tenantId, ctx.organizationId, ctx.session.userId],
      )
      const role = membership.rows[0]?.role
      if (!isRole(role) || !hasCapability(role, 'credential:create'))
        throw new AuthzError('forbidden', '连接权限已变更，请刷新后重试')
      if (body.snapshot === undefined && !['owner', 'admin'].includes(role))
        throw new AuthzError('forbidden', '服务器采集器读取需要管理员权限')
      const currentContext = { ...ctx, membership: { ...ctx.membership, role } }
      const current = await connection(client, currentContext, id, true)
      if (!canManage(currentContext, current)) throw new AuthzError('tenant_isolation', '连接不存在', 404)
      if (current.product !== initial.product) throw new CollectorError('monitor_changed_retry', 409)
      if (JSON.stringify(current.account_observation) !== JSON.stringify(initial.account_observation))
        throw new CollectorError('monitor_changed_retry', 409)
      await client.query(
        'UPDATE owned_connections SET account_observation=$1::jsonb,updated_at=now() WHERE id=$2 AND tenant_id=$3',
        [JSON.stringify(observation), id, ctx.tenantId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(
      ctx,
      'connection.monitor_updated',
      { type: 'connection', id },
      { providerId, source: 'codexbar' },
    )
    return collectorResponse({ observation })
  } catch (error) {
    return fail(error)
  }
}
