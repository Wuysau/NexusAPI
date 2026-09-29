import { pool } from '@/db'
import { connectorState, tokenHash } from '@/lib/connectors/control'
import { apiError, jsonOk, readJsonBody, requireContext, routeError } from '../../../../_lib/control-plane'
export const dynamic = 'force-dynamic'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const { id } = await params
    const state = await connectorState(ctx, id)
    const body = await readJsonBody<{ apiKey?: unknown; model?: unknown }>(req)
    if (typeof body?.apiKey !== 'string' || typeof body.model !== 'string' || !state.readyModels.includes(body.model))
      return apiError(400, 'invalid_test', '请使用已就绪模型和绑定项目的 API Key')
    const key = await pool.query(
      `SELECT k.id FROM downstream_api_keys k JOIN owned_connections c ON c.project_id=k.project_id AND c.tenant_id=k.tenant_id
      WHERE c.id=$1 AND k.tenant_id=$2 AND k.organization_id=$3 AND k.hash=$4 AND k.enabled=true AND k.revoked_at IS NULL AND k.deleted_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at>now()) AND (k.scopes ? '*' OR k.scopes ? 'chat:write')`,
      [id, ctx.tenantId, ctx.organizationId, tokenHash(body.apiKey)],
    )
    if (!key.rowCount) return apiError(403, 'project_key_required', 'API Key 未获此连接项目的调用授权')
    const base = process.env.NEXUS_GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_BASE_URL
    if (!base) return apiError(503, 'gateway_not_configured', '管理员需配置 NEXUS_GATEWAY_URL')
    const url = new URL(base)
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
      return apiError(503, 'gateway_tls_required', '测试调用需要 HTTPS 网关')
    url.pathname = '/v1/chat/completions'
    url.search = ''
    url.hash = ''
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${body.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: body.model,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 32,
          stream: false,
        }),
      })
      const result = await response.json()
      if (!response.ok)
        return apiError(response.status, 'connector_test_failed', '网关测试调用失败；请检查连接、模型和项目授权')
      const actual = await pool.query(
        'SELECT id FROM attempts WHERE request_id=$1 AND tenant_id=$2 AND connection_id=$3',
        [response.headers.get('x-request-id'), ctx.tenantId, id],
      )
      if (!actual.rowCount)
        return apiError(409, 'different_channel_selected', '请求由其他候选渠道完成；请检查当前项目的同名模型路由')
      return jsonOk({
        ok: true,
        requestId: response.headers.get('x-request-id'),
        model: result.model,
        message: '测试调用成功；请求已按项目 API Key 归因。',
      })
    } catch {
      return apiError(504, 'connector_test_timeout', '网关测试未完成，请检查网络及本地模型')
    }
  } catch (e) {
    return routeError(e)
  }
}
