import { homedir } from 'node:os'
import path from 'node:path'
import { pool } from '@/db'
import { AuthzError } from '@/lib/auth/capabilities'
import { CsrfError } from '@/lib/auth/csrf'
import { desktopPickerHostAllowed, desktopPickerRequestAllowed } from '@/lib/observer/local-picker'
import { observerSettings, readActiveObserverConfig, saveActiveObserverConfig } from '@/lib/observer/configuration'
import { discoverAgentSources, sourceExists, validateAgentSource } from '@/lib/observer/agent-sources'
import { AGENT_TOOLS, AGENT_TOOL_ID, sourceTool } from '@/lib/observer/agent-tools'
import { readObserverRuntime, requestObserverSync } from '@/lib/observer/service'
import type { AgentSource } from '@/lib/observer/agent-types'
import type { ObserverConfig } from '@/lib/observer/importer'
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
const localReason = '请通过本机 Windows 的 NexusAPI 开发入口管理本机采集。'
function admin(ctx: ControlPlaneContext) {
  if (!['owner', 'admin'].includes(ctx.membership.role))
    throw new AuthzError('forbidden', '仅工作空间管理员可以管理本机采集')
}
function response(result: Response) {
  result.headers.set('Cache-Control', 'no-store')
  return result
}
function scopeConflict(config: ObserverConfig | null, ctx: ControlPlaneContext) {
  return config !== null && (config.tenantId !== ctx.tenantId || config.organizationId !== ctx.organizationId)
}
function conflict() {
  return response(apiError(409, 'observer_scope_conflict', '本机 Observer 已配置给其他工作空间，请由本机运维修改配置'))
}
function failure(error: unknown) {
  if (error instanceof AuthzError || error instanceof CsrfError) return response(routeError(error))
  return response(apiError(503, 'observer_unavailable', '本机采集暂时不可用，请检查配置及数据库后重试'))
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    admin(ctx)
    if (!desktopPickerHostAllowed(req)) return response(jsonOk({ available: false, reason: localReason }))
    const settings = observerSettings()
    const config = await readActiveObserverConfig(settings)
    if (scopeConflict(config, ctx)) return conflict()
    const detected = await discoverAgentSources()
    for (const [tool, sourcePath] of [
      ['codex', path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions')],
      ['claude_code', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects')],
    ])
      if (await sourceExists(sourcePath)) detected.push({ tool, path: sourcePath, format: 'native' })
    const configured = await Promise.all(
      [
        ...(config?.agentSources ?? []).map((source) => ({ ...source, removable: true })),
        ...(config?.sources ?? []).map((sourcePath) => ({
          tool: 'codex',
          path: sourcePath,
          format: 'native' as const,
          removable: false,
        })),
        ...(config?.claudeSources ?? []).map((sourcePath) => ({
          tool: 'claude_code',
          path: sourcePath,
          format: 'native' as const,
          removable: false,
        })),
      ].map(async (source) => ({ ...source, exists: await sourceExists(source.path) })),
    )
    const counts = (
      await pool.query<{ source: string; events: string; sessions: string; lastObserved: Date | null }>(
        `SELECT usage_source AS source,COUNT(*)::text AS events,COUNT(DISTINCT external_session_id)::text AS sessions,MAX(occurred_at) AS "lastObserved"
       FROM external_observed_usage WHERE tenant_id=$1 AND organization_id=$2
       AND (usage_source IN ('codex_local','claude_code_local') OR usage_source ~ '^agent:[a-z][a-z0-9_]{0,47}$') GROUP BY usage_source`,
        [ctx.tenantId, ctx.organizationId],
      )
    ).rows
    const state = config ? await readObserverRuntime(pool, ctx, settings) : null
    const ids = new Set<string>(AGENT_TOOLS.map((tool) => tool.id))
    const totals = new Map<string, { events: bigint; sessions: bigint; lastObserved: Date | null }>()
    for (const source of [...configured, ...detected]) ids.add(source.tool)
    for (const count of counts) {
      const tool = sourceTool(count.source)
      if (!tool || !AGENT_TOOL_ID.test(tool)) continue
      ids.add(tool)
      const total = totals.get(tool) ?? { events: 0n, sessions: 0n, lastObserved: null }
      total.events += BigInt(count.events)
      total.sessions += BigInt(count.sessions)
      const observed = count.lastObserved === null ? null : new Date(count.lastObserved)
      if (observed && Number.isFinite(observed.getTime()) && (!total.lastObserved || observed > total.lastObserved))
        total.lastObserved = observed
      totals.set(tool, total)
    }
    const tools = [...ids].map((tool) => ({
      ...(AGENT_TOOLS.find((entry) => entry.id === tool) ?? {
        id: tool,
        name: tool,
        capture: 'bridge',
        hint: '自定义工具，通过通用用量事件接入。',
      }),
      events: String(totals.get(tool)?.events ?? 0n),
      sessions: String(totals.get(tool)?.sessions ?? 0n),
      lastObserved: totals.get(tool)?.lastObserved ?? null,
    }))
    return response(
      jsonOk({
        available: true,
        configured: Boolean(config),
        autoDiscover: config?.autoDiscover === true,
        enabled: settings.enabled,
        intervalSeconds: settings.intervalSeconds,
        tools,
        detected,
        sources: configured,
        runtime: state
          ? {
              state: state.state,
              lastSync: state.last_sync_completed_at,
              lastSuccessfulSync: state.last_successful_sync_at,
              nextSync: state.next_sync_at,
              requested: Boolean(state.requested_at),
              error: state.last_error ? 'sync_failed' : null,
              sourceErrors: (Array.isArray(state.last_result?.sourceErrors) ? state.last_result.sourceErrors : [])
                .filter((entry) => entry && typeof entry.tool === 'string' && AGENT_TOOL_ID.test(entry.tool))
                .map((entry) => ({
                  tool: entry.tool,
                  code: entry.code === 'source_unavailable' ? 'source_unavailable' : 'capture_failed',
                })),
            }
          : null,
      }),
    )
  } catch (error) {
    return failure(error)
  }
}

export async function POST(req: Request) {
  try {
    // requireContext performs the shared CSRF check before any local I/O.
    const ctx = await requireContext(req, 'credential:create')
    admin(ctx)
    if (!desktopPickerRequestAllowed(req)) return response(apiError(403, 'local_observer_unavailable', localReason))
    const body = await readJsonBody<Record<string, unknown>>(req)
    const invalid = () =>
      response(apiError(400, 'invalid_observer_request', '采集参数无效，请检查工具、格式和绝对路径'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
    const allowed: Record<string, string[]> = {
      discovery: ['action', 'enabled'],
      addSource: ['action', 'source'],
      removeSource: ['action', 'tool', 'path'],
      sync: ['action'],
    }
    const action = typeof body.action === 'string' ? body.action : ''
    if (!Object.hasOwn(allowed, action) || Object.keys(body).some((key) => !allowed[action].includes(key)))
      return invalid()
    let source: AgentSource | undefined
    if (action === 'discovery' && typeof body.enabled !== 'boolean') return invalid()
    if (action === 'addSource') {
      try {
        source = validateAgentSource(body.source)
      } catch {
        return invalid()
      }
    }
    if (
      action === 'removeSource' &&
      (typeof body.tool !== 'string' ||
        !AGENT_TOOL_ID.test(body.tool) ||
        typeof body.path !== 'string' ||
        body.path.length > 4096 ||
        !path.isAbsolute(body.path))
    )
      return invalid()
    const settings = observerSettings()
    const client = await pool.connect()
    let result = 'saved'
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['observer-config:' + settings.instanceId])
      const actor = await client.query(
        `SELECT role FROM organization_memberships WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3 AND role IN ('owner','admin') FOR SHARE`,
        [ctx.tenantId, ctx.organizationId, ctx.session.userId],
      )
      if (!actor.rowCount) throw new AuthzError('forbidden', '本机采集管理权限已变更')
      const active = await readActiveObserverConfig(settings)
      if (scopeConflict(active, ctx)) return conflict()
      if (action === 'sync') {
        if (!active) return response(apiError(409, 'not_configured', '请先启用发现或添加采集来源'))
        result = await requestObserverSync(client, ctx, settings)
        if (result === 'worker_unavailable')
          return response(apiError(409, result, '采集后台未运行，请通过本机入口启动 NexusAPI'))
      } else {
        const config: ObserverConfig = active ?? {
          tenantId: ctx.tenantId,
          organizationId: ctx.organizationId,
          sources: [],
          claudeSources: [],
          providers: [],
          roots: [],
          agentSources: [],
          autoDiscover: true,
        }
        if (action === 'discovery') config.autoDiscover = body.enabled as boolean
        if (action === 'addSource' && source) {
          config.agentSources = [
            ...(config.agentSources ?? []).filter((entry) => entry.tool !== source.tool || entry.path !== source.path),
            source,
          ]
          if (config.agentSources.length > 100) return invalid()
        }
        if (action === 'removeSource')
          config.agentSources = (config.agentSources ?? []).filter(
            (entry) => entry.tool !== body.tool || entry.path !== body.path,
          )
        await saveActiveObserverConfig(settings, config)
      }
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    await auditControlPlane(
      ctx,
      'observer.agent_' + action,
      { type: 'observer', id: settings.instanceId },
      {
        ...(source ? { tool: source.tool, format: source.format } : {}),
        ...(action === 'discovery' ? { enabled: body.enabled } : {}),
      },
    )
    return response(jsonOk({ result }, action === 'sync' ? 202 : 200))
  } catch (error) {
    return failure(error)
  }
}
