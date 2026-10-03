import { pool } from '@/db'
import { sha256hex } from '@/lib/crypto'
import { scopeMatches } from '@/lib/auth/api-keys'
import { AuthzError } from '@/lib/auth/capabilities'
import { projectVisibility, workspaceParams } from '@/lib/workspace/management'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  requireContext,
  routeError,
  type ControlPlaneContext,
} from '@/app/api/_lib/control-plane'
import {
  PLAYGROUND_LIMITS,
  isPlaygroundChatInput,
  isPlaygroundModelsInput,
  projectPlaygroundChat,
  projectPlaygroundModels,
  type PlaygroundChatInput,
  type PlaygroundIdentity,
} from '../../packages/contracts/playground'

export class PlaygroundError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
function canceled() {
  return new PlaygroundError(504, 'playground_delivery_unknown', '调用已取消或超时，可能已产生用量；不会自动重发。')
}

/** The administrator selects a base; caller data cannot select destination or headers. */
export function playgroundGatewayURL(
  operation: 'models' | 'chat',
  configured: string | undefined,
  production = process.env.NODE_ENV === 'production',
): URL {
  if (!configured) throw new PlaygroundError(503, 'gateway_not_configured', '管理员需配置 NEXUS_GATEWAY_URL')
  const authority = /^https?:\/\/([^/?#]+)/i.exec(configured)?.[1]
  if (!authority || /[@%]/.test(authority) || /[\s\\?#]/.test(configured))
    throw new PlaygroundError(503, 'gateway_invalid_destination', '网关地址配置无效')
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new PlaygroundError(503, 'gateway_invalid_destination', '网关地址配置无效')
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  )
    throw new PlaygroundError(503, 'gateway_invalid_destination', '网关地址配置无效')
  if (production && url.protocol !== 'https:')
    throw new PlaygroundError(503, 'gateway_tls_required', '在线调试需要 HTTPS 网关')
  url.pathname = operation === 'models' ? '/v1/models' : '/v1/chat/completions'
  return url
}

/** Count decoded bytes as they arrive, including chunked bodies and decompressed fetch responses. */
export async function readPlaygroundJson(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
  input = false,
): Promise<unknown> {
  if (!body)
    throw new PlaygroundError(
      input ? 400 : 502,
      input ? 'invalid_playground_input' : 'playground_delivery_unknown',
      input ? '请提供有效的文本调试请求' : '网关响应无法确认，可能已产生用量；不会自动重发。',
    )
  const reader = body.getReader()
  let total = 0
  const chunks: Uint8Array[] = []
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const abort = () => {
    void reader.cancel().catch(() => {})
    rejectAbort(canceled())
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (signal.aborted) throw canceled()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        void reader.cancel().catch(() => {})
        throw new PlaygroundError(
          input ? 413 : 502,
          input ? 'playground_input_too_large' : 'playground_delivery_unknown',
          input ? '调试请求最多 65536 字节' : '网关响应超过限制，可能已产生用量；不会自动重发。',
        )
      }
      chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown
    } catch {
      throw new PlaygroundError(
        input ? 400 : 502,
        input ? 'invalid_playground_input' : 'playground_delivery_unknown',
        input ? '请提供有效的文本调试请求' : '网关响应无法确认，可能已产生用量；不会自动重发。',
      )
    }
  } catch (error) {
    if (error instanceof PlaygroundError) throw error
    throw input
      ? new PlaygroundError(400, 'invalid_playground_input', '请提供有效的文本调试请求')
      : new PlaygroundError(502, 'playground_delivery_unknown', '网关响应无法确认，可能已产生用量；不会自动重发。')
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      reader.releaseLock()
    } catch {
      /* A canceled reader may still have a pending read. */
    }
  }
}

export async function authorizePlayground(
  ctx: ControlPlaneContext,
  input: PlaygroundIdentity,
  operation: 'models' | 'chat',
): Promise<string> {
  const project = await pool.query(
    `SELECT p.id FROM projects p JOIN organizations o ON o.id=p.organization_id AND o.tenant_id=p.tenant_id
     WHERE ${projectVisibility} AND p.id=$5 AND p.status='active' AND p.archived_at IS NULL
       AND o.status='active' AND o.deleted_at IS NULL`,
    [...workspaceParams(ctx), input.projectId],
  )
  if (!project.rowCount) throw new AuthzError('tenant_isolation', '项目不存在', 404)
  const key = await pool.query<{ id: string; scopes: unknown }>(
    `SELECT k.id,k.scopes FROM downstream_api_keys k WHERE k.tenant_id=$1 AND k.organization_id=$2
      AND k.project_id=$3 AND k.hash=$4 AND k.enabled=true AND k.revoked_at IS NULL AND k.deleted_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at>now())`,
    [ctx.tenantId, ctx.organizationId, input.projectId, sha256hex(input.apiKey)],
  )
  const row = key.rows[0]
  if (
    !row ||
    !Array.isArray(row.scopes) ||
    !row.scopes.every((scope) => typeof scope === 'string') ||
    !scopeMatches(row.scopes, operation === 'models' ? 'models:read' : 'chat:write')
  )
    throw new PlaygroundError(403, 'project_key_required', 'API Key 未获此项目的操作授权')
  return row.id
}

export async function forwardPlayground(
  input: PlaygroundIdentity | PlaygroundChatInput,
  operation: 'models' | 'chat',
  signal: AbortSignal,
) {
  const url = playgroundGatewayURL(operation, process.env.NEXUS_GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_BASE_URL)
  const chat = input as PlaygroundChatInput
  let response: Response
  try {
    if (signal.aborted) throw canceled()
    response = await fetch(url, {
      method: operation === 'models' ? 'GET' : 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        ...(operation === 'chat' ? { 'content-type': 'application/json' } : {}),
      },
      ...(operation === 'chat'
        ? {
            body: JSON.stringify({
              model: chat.model,
              messages: chat.messages,
              max_tokens: chat.maxTokens,
              stream: false,
            }),
          }
        : {}),
    })
  } catch {
    throw signal.aborted
      ? canceled()
      : new PlaygroundError(502, 'playground_delivery_unknown', '网关调用结果未知，可能已产生用量；不会自动重发。')
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new PlaygroundError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      'playground_gateway_rejected',
      '网关未返回成功响应；请检查项目、模型、额度与资源策略。不会自动重发。',
    )
  }
  const raw = await readPlaygroundJson(response.body, PLAYGROUND_LIMITS.responseBytes, signal)
  try {
    return operation === 'models'
      ? projectPlaygroundModels(raw, response.headers.get('x-request-id'))
      : projectPlaygroundChat(raw, response.headers.get('x-request-id'))
  } catch {
    throw new PlaygroundError(502, 'playground_delivery_unknown', '网关响应无法确认，可能已产生用量；不会自动重发。')
  }
}

export async function handlePlayground(req: Request, operation: 'models' | 'chat') {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(PLAYGROUND_LIMITS.timeoutMs)])
  let response: Response
  try {
    const ctx = await requireContext(req, 'apikey:create')
    const input = await readPlaygroundJson(req.body, PLAYGROUND_LIMITS.inputBytes, signal, true)
    const valid = operation === 'models' ? isPlaygroundModelsInput(input) : isPlaygroundChatInput(input)
    if (!valid)
      throw new PlaygroundError(400, 'invalid_playground_input', '仅支持有限长度的用户/助手文本对话与有效的输出上限')
    const authorized = input as PlaygroundIdentity | PlaygroundChatInput
    const keyId = await authorizePlayground(ctx, authorized, operation)
    // Intent is metadata only. Execution, durable attempts and accounting belong to Gateway/Worker.
    await auditControlPlane(
      ctx,
      'playground.dispatch_intent',
      { type: 'project', id: authorized.projectId },
      { operation, keyId },
    )
    response = jsonOk(await forwardPlayground(authorized, operation, signal), 200, req)
  } catch (error) {
    response =
      error instanceof PlaygroundError ? apiError(error.status, error.code, error.message, req) : routeError(error, req)
  }
  response.headers.set('cache-control', 'no-store')
  return response
}
