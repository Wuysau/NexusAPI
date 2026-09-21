import { normalizeLocalEndpoint } from './local-credentials'
import { diagnosticRequest } from './outbound'

export interface ChannelVerification {
  checkedAt: string
  ok: boolean
  status: number | string
  inputTokens: string | null
  outputTokens: string | null
  responseId: string | null
  message: string
}
const token = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ? String(v)
    : typeof v === 'string' && /^\d{1,20}$/.test(v)
      ? v
      : null

/** Explicit, bounded diagnostic; never a proxy API, gateway request or financial event. */
export async function diagnoseConnection(
  config: { base_url: string; protocol: 'anthropic' | 'openai'; model: string },
  secret: string,
): Promise<ChannelVerification> {
  const checkedAt = new Date().toISOString()
  const result: ChannelVerification = {
    checkedAt,
    ok: false,
    status: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    responseId: null,
    message: '连接失败，请检查地址、模型与 API Key',
  }
  const base = normalizeLocalEndpoint(config.base_url)
  const anthropic = config.protocol === 'anthropic'
  const path = anthropic ? (/\/v1$/.test(base) ? '/messages' : '/v1/messages') : '/chat/completions'
  const signal = AbortSignal.timeout(30_000)
  try {
    const response = await diagnosticRequest(
      base + path,
      {
        'content-type': 'application/json',
        ...(anthropic
          ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${secret}` }),
      },
      JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        max_tokens: 16,
        stream: false,
      }),
      signal,
    )
    result.status = response.status
    if (!response.ok) {
      await response.body?.cancel()
      result.message =
        response.status === 401 || response.status === 403
          ? '认证失败，请检查 API Key 和接口权限'
          : response.status === 404
            ? '接口或模型不存在，请检查地址与协议'
            : response.status === 429
              ? '上游限流或额度不足'
              : '上游未通过测试，请检查地址、协议与模型'
      return result
    }
    const reader = response.body?.getReader()
    if (!reader) return result
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 64 * 1024) {
          await reader.cancel()
          result.status = 'response_too_large'
          return result
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (
      !body ||
      typeof body !== 'object' ||
      (anthropic ? !Array.isArray(body.content) : !Array.isArray(body.choices))
    ) {
      result.status = 'invalid_response'
      return result
    }
    const usage = body.usage as Record<string, unknown> | undefined
    result.ok = true
    result.message = '上游测试成功（独立连接测试，不计入网关结算）'
    result.inputTokens = token(anthropic ? usage?.input_tokens : usage?.prompt_tokens)
    result.outputTokens = token(anthropic ? usage?.output_tokens : usage?.completion_tokens)
    result.responseId =
      typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(body.id) && !body.id.includes(secret)
        ? body.id
        : null
    return result
  } catch {
    result.status = signal.aborted ? 'timeout' : 'unavailable'
    result.message = signal.aborted ? '上游请求超时，请稍后再试' : '未取得有效响应，请检查接口地址和网络'
    return result
  }
}
