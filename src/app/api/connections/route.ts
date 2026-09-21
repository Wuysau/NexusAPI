import { pool } from '@/db'
import { resolveQuotaProject } from '@/lib/quota/access'
import { connectionVisibility, observedVisibility, workspaceParams } from '@/lib/workspace/management'
import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const result = await pool.query(
      `SELECT c.id,c.provider,c.mode,c.status,c.owner_user_id,c.project_id,p.name project_name,c.credential_fingerprint,
        CASE WHEN c.account_observation->>'organizationId'=$2 THEN c.account_observation->>'status' END "accountStatus",
        CASE WHEN c.account_observation->>'organizationId'=$2 THEN c.account_observation->'account'->>'planType' END "accountPlan",
        c.capabilities->>'provider_identifier' provider_identifier,c.capabilities->>'subscription_product' subscription_product,
        jsonb_build_object('connection_type',c.capabilities->'connection_type','execution_mode',c.capabilities->'execution_mode',
          'routing',c.capabilities->'routing','provider_identifier',c.capabilities->'provider_identifier','subscription_product',c.capabilities->'subscription_product') capabilities,
        c.last_heartbeat_at,c.revoked_at,c.created_at,observed.events "observedEvents",observed.sessions "observedSessions",observed.last_activity "lastObservedAt"
       FROM owned_connections c LEFT JOIN projects p ON p.id=c.project_id AND p.tenant_id=$1 AND p.organization_id=$2
       LEFT JOIN LATERAL (
        SELECT count(*)::text events,count(DISTINCT external_session_id)::text sessions,max(occurred_at) last_activity
        FROM external_observed_usage e WHERE e.connection_id=c.id AND ${observedVisibility}
       ) observed ON true WHERE ${connectionVisibility} ORDER BY c.created_at DESC`,
      workspaceParams(ctx),
    )
    return jsonOk({ connections: result.rows })
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          !['provider', 'mode', 'projectId', 'providerIdentifier', 'credentialFingerprint', 'capabilities'].includes(
            key,
          ),
      )
    )
      return apiError(400, 'invalid_connection', '连接参数无效，请勿提交密钥')
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    const mode = body.mode === undefined ? 'direct_api' : body.mode
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(provider) ||
      typeof mode !== 'string' ||
      !['direct_api', 'local_sidecar', 'customer_vpc_runner', 'external_endpoint', 'subscription_interactive'].includes(
        mode,
      )
    )
      return apiError(400, 'invalid_connection', '连接类型或供应商标识无效')
    if (
      body.projectId !== undefined &&
      body.projectId !== null &&
      (typeof body.projectId !== 'string' || !body.projectId.trim())
    )
      return apiError(400, 'invalid_project', '项目参数无效')
    const projectId = typeof body.projectId === 'string' ? body.projectId : null
    let capabilities: Record<string, unknown> = {}
    if (mode === 'subscription_interactive') {
      const identifier = body.providerIdentifier ?? 'openai'
      if (
        provider !== 'openai' ||
        typeof identifier !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(identifier) ||
        body.credentialFingerprint !== undefined ||
        body.capabilities !== undefined
      )
        return apiError(400, 'invalid_subscription', 'Codex 观测连接只接受供应商标识和项目，不接受凭据或路由能力')
      capabilities = {
        connection_type: 'subscription',
        execution_mode: 'interactive',
        routing: false,
        provider_identifier: identifier,
        subscription_product: 'openai_codex',
      }
    } else {
      if (
        body.capabilities !== undefined &&
        (!body.capabilities || typeof body.capabilities !== 'object' || Array.isArray(body.capabilities))
      )
        return apiError(400, 'invalid_capabilities', '连接能力参数无效')
      capabilities = (body.capabilities ?? {}) as Record<string, unknown>
    }
    const client = await pool.connect()
    let connection: { id: string; provider: string; mode: string; status: string }
    try {
      await client.query('BEGIN')
      if (projectId) await resolveQuotaProject(client, ctx, projectId, { write: true, lock: true })
      connection = (
        await client.query(
          'INSERT INTO owned_connections(tenant_id,owner_user_id,project_id,provider,mode,credential_fingerprint,capabilities) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id,provider,mode,status',
          [
            ctx.tenantId,
            ctx.session.userId,
            projectId,
            provider,
            mode,
            typeof body.credentialFingerprint === 'string' ? body.credentialFingerprint.slice(0, 128) : null,
            JSON.stringify(capabilities),
          ],
        )
      ).rows[0]
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(ctx, 'connection.created', { type: 'connection', id: connection.id }, { provider, mode })
    return jsonOk({ connection }, 201)
  } catch (error) {
    return routeError(error)
  }
}
