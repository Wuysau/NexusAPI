import { homedir } from 'node:os'
import path from 'node:path'
import { pool } from '@/db'
import { AuthzError } from '@/lib/auth/capabilities'
import { desktopPickerHostAllowed, desktopPickerRequestAllowed } from '@/lib/observer/local-picker'
import {
  ObserverConfigurationError,
  observerSettings,
  readActiveObserverConfig,
  saveActiveObserverConfig,
} from '@/lib/observer/configuration'
import { CsrfError } from '@/lib/auth/csrf'
import { readObserverRuntime, requestObserverSync } from '@/lib/observer/service'
import { validateObserverConfig } from '@/lib/observer/importer'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  readJsonBody,
  requireContext,
  routeError,
  type ControlPlaneContext,
} from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const localReason = '请在本机 Windows 使用 npm run dev 或 npm run dev:local 启动 NexusAPI，再应用配置。'
function admin(ctx: ControlPlaneContext) {
  if (!['owner', 'admin'].includes(ctx.membership.role))
    throw new AuthzError('forbidden', '仅工作空间管理员可以管理本机 Observer')
}
function response(value: Response) {
  value.headers.set('Cache-Control', 'no-store')
  return value
}
const connectionQuery = `SELECT c.id,c.provider,c.capabilities FROM owned_connections c
  WHERE ${connectionVisibility} AND c.id=$5 AND c.mode='subscription_interactive'
  AND c.provider='openai' AND COALESCE(c.capabilities->>'subscription_product','openai_codex')='openai_codex'
  AND c.status IN ('active','pending') AND c.revoked_at IS NULL
  AND c.credential_ref IS NULL AND c.credential_fingerprint IS NULL`
async function connection(ctx: ControlPlaneContext, id: unknown) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new AuthzError('tenant_isolation', '连接不存在')
  const row = (await pool.query(connectionQuery, [...workspaceParams(ctx), id])).rows[0]
  if (!row) throw new AuthzError('tenant_isolation', '连接不存在')
  return row
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    admin(ctx)
    const conn = await connection(ctx, new URL(req.url).searchParams.get('connectionId'))
    if (!desktopPickerHostAllowed(req)) return response(jsonOk({ available: false, reason: localReason }))
    const settings = observerSettings()
    const config = await readActiveObserverConfig(settings)
    const configured =
      config?.tenantId === ctx.tenantId &&
      config.organizationId === ctx.organizationId &&
      config.providers.some((p) => p.connectionId === conn.id)
    const state = configured ? await readObserverRuntime(pool, ctx, settings) : null
    return response(
      jsonOk({
        available: true,
        configured,
        enabled: settings.enabled,
        intervalSeconds: settings.intervalSeconds,
        state: configured ? (state?.state ?? 'stopped') : 'not_configured',
        source: configured ? config.sources[0] : path.join(homedir(), '.codex', 'sessions'),
        runtime: state,
      }),
    )
  } catch (error) {
    if (error instanceof AuthzError) return response(routeError(error))
    if (error instanceof ObserverConfigurationError)
      return response(
        jsonOk({
          available: true,
          configured: false,
          state: 'error',
          reason: 'Observer 配置无效，请检查本机配置文件及环境变量。',
        }),
      )
    // No parser/OS/DB exception text reaches logs or the browser.
    return response(apiError(503, 'observer_unavailable', 'Observer 配置或数据库暂时不可用，请检查本机配置后重试'))
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    admin(ctx)
    if (!desktopPickerRequestAllowed(req)) return response(apiError(403, 'local_observer_unavailable', localReason))
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (
      !body ||
      Object.keys(body).some((key) => !['action', 'connectionId', 'source'].includes(key)) ||
      !['apply', 'sync'].includes(String(body.action))
    )
      return response(apiError(400, 'invalid_observer_request', 'Observer 参数无效'))
    const conn = await connection(ctx, body.connectionId)
    const settings = observerSettings()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['observer-config:' + settings.instanceId])
      // Recheck current membership/connection while holding a share lock until the local action completes.
      const actor = await client.query(
        `SELECT role FROM organization_memberships WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3 AND role IN ('owner','admin') FOR SHARE`,
        [ctx.tenantId, ctx.organizationId, ctx.session.userId],
      )
      if (
        !actor.rowCount ||
        !(await client.query(connectionQuery + ' FOR SHARE OF c', [...workspaceParams(ctx), conn.id])).rowCount
      )
        throw new AuthzError('forbidden', 'Observer 管理权限或连接状态已变更')
      const active = await readActiveObserverConfig(settings)
      if (active && (active.tenantId !== ctx.tenantId || active.organizationId !== ctx.organizationId))
        return response(
          apiError(409, 'observer_scope_conflict', '本机 Observer 已配置给其他工作空间，请由本机运维修改配置'),
        )
      if (body.action === 'sync') {
        if (!active?.providers.some((p) => p.connectionId === conn.id))
          return response(apiError(409, 'not_configured', '请先应用 Observer 配置'))
        const result = await requestObserverSync(client, ctx, settings)
        await client.query('COMMIT')
        if (result === 'worker_unavailable')
          return response(apiError(409, result, 'Observer 后台未运行，请使用本机启动入口启动 NexusAPI'))
        return response(jsonOk({ result }, 202))
      }
      const source =
        body.source === undefined || body.source === '' ? path.join(homedir(), '.codex', 'sessions') : body.source
      if (typeof source !== 'string' || source.length > 4096 || /[\x00-\x1f]/.test(source) || !path.isAbsolute(source))
        return response(apiError(400, 'invalid_source', '请填写 sessions 目录或 JSONL 文件的绝对路径'))
      const roots = (
        await client.query(
          `SELECT r.root,r.project_id AS "projectId" FROM project_workspace_roots r JOIN projects p ON p.id=r.project_id AND p.tenant_id=r.tenant_id AND p.organization_id=r.organization_id WHERE r.tenant_id=$1 AND r.organization_id=$2 AND p.archived_at IS NULL`,
          [ctx.tenantId, ctx.organizationId],
        )
      ).rows
      const mapping = {
        identifier: conn.capabilities.provider_identifier,
        provider: conn.provider,
        product: conn.capabilities.subscription_product,
        connectionId: conn.id,
      }
      const providers = [
        ...(active?.providers ?? []).filter((p) => p.identifier !== mapping.identifier && p.connectionId !== conn.id),
        mapping,
      ]
      for (const p of providers) {
        const valid = (
          await client.query(
            connectionQuery +
              " AND c.provider=$6 AND c.capabilities->>'provider_identifier'=$7 AND c.capabilities->>'subscription_product'=$8 FOR SHARE OF c",
            [...workspaceParams(ctx), p.connectionId, p.provider, p.identifier, p.product],
          )
        ).rowCount
        if (!valid)
          return response(apiError(409, 'observer_mapping_unavailable', '配置中存在不可用连接，请检查供应商映射'))
      }
      const config = validateObserverConfig({
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        sources: [source],
        ...(active?.claudeSources ? { claudeSources: active.claudeSources } : {}),
        roots,
        providers,
      })
      await saveActiveObserverConfig(settings, config)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    await auditControlPlane(ctx, 'observer.configuration_applied', { type: 'connection', id: conn.id }, {})
    return response(jsonOk({ result: 'applied' }))
  } catch (error) {
    // Keep auth/CSRF semantics while sanitizing all local I/O failures.
    if (error instanceof AuthzError || error instanceof CsrfError) return response(routeError(error))
    return response(apiError(503, 'observer_unavailable', 'Observer 操作失败，请检查本机配置与数据库后重试'))
  }
}
