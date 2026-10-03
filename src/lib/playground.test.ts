import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/db', () => ({ pool: { query: vi.fn() } }))
import { pool } from '@/db'
import {
  authorizePlayground,
  forwardPlayground,
  handlePlayground,
  PlaygroundError,
  playgroundGatewayURL,
  readPlaygroundJson,
} from './playground'
import { PLAYGROUND_LIMITS } from '../../packages/contracts/playground'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { sha256hex } from '@/lib/crypto'
import { SESSION_COOKIE } from '@/lib/auth/sessions'

const context = {
  tenantId: 'tenant',
  organizationId: 'org',
  session: { userId: 'user' },
  membership: { role: 'developer' },
} as ControlPlaneContext
const input = {
  projectId: 'project',
  apiKey: 'sk-nx-fixture-key-01234567890123456789',
  model: 'model',
  messages: [{ role: 'user' as const, content: 'private prompt' }],
  maxTokens: 32,
}
const response = {
  object: 'chat.completion',
  model: 'model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'reply' }, finish_reason: 'stop' }],
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.mocked(pool.query).mockReset()
})

describe('fixed Playground Gateway destination', () => {
  it('overwrites only fixed paths and never derives a destination from the caller', () => {
    expect(playgroundGatewayURL('models', 'https://gateway.example/base/', true).href).toBe(
      'https://gateway.example/v1/models',
    )
    expect(playgroundGatewayURL('chat', 'http://127.0.0.1:4312/prefix', false).href).toBe(
      'http://127.0.0.1:4312/v1/chat/completions',
    )
  })
  it.each([
    undefined,
    '',
    ' https://gateway.example',
    'https://gateway.example ',
    'file:///tmp/x',
    'https://user:pass@gateway.example',
    'https://@gateway.example',
    'https://%67ateway.example',
    'https:///gateway.example',
    'https://gateway.example?query',
    'https://gateway.example?',
    'https://gateway.example#hash',
    'https://gateway.example#',
    'https:\\gateway.example',
    '//gateway.example',
    'http://localhost',
  ])('rejects invalid/ambiguous or production plaintext configuration %j', (value) => {
    expect(() => playgroundGatewayURL('chat', value, true)).toThrow(PlaygroundError)
  })
})
describe('bounded JSON with cancellation', () => {
  it('counts bytes rather than text code points and ignores Content-Length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: '多'.repeat(100) }))
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    await expect(readPlaygroundJson(body(), bytes.length, new AbortController().signal, true)).resolves.toEqual({
      text: '多'.repeat(100),
    })
    await expect(
      readPlaygroundJson(body(), bytes.length - 1, new AbortController().signal, true),
    ).rejects.toMatchObject({ code: 'playground_input_too_large', status: 413 })
  })
  it('converts syntax excerpts and invalid UTF-8 to fixed errors', async () => {
    for (const bytes of [new TextEncoder().encode('{"secret prompt":'), new Uint8Array([0xff])]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
      await expect(readPlaygroundJson(body, 1000, new AbortController().signal, true)).rejects.toMatchObject({
        message: '请提供有效的文本调试请求',
      })
    }
  })
  it('cancels a pending body read even if the source never produces a chunk', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const result = readPlaygroundJson(body, 100, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'playground_delivery_unknown' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
describe('read-only project Key authorization', () => {
  it.each(['*', 'chat:*', 'chat:write'])(
    'uses established %s operation matching without touching Key usage',
    async (scope) => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'project' }] } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'key', scopes: [scope] }] } as never)
      await expect(authorizePlayground(context, input, 'chat')).resolves.toBe('key')
      expect(vi.mocked(pool.query).mock.calls.every(([sql]) => String(sql).trim().startsWith('SELECT'))).toBe(true)
      expect(vi.mocked(pool.query).mock.calls[1][1]).toEqual([
        'tenant',
        'org',
        'project',
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ])
      expect(JSON.stringify(vi.mocked(pool.query).mock.calls)).not.toContain(input.apiKey)
    },
  )
  it.each([{ 'chat:write': true }, 'chat:write', ['chat:write', 1], null, ['models:read']])(
    'rejects non-array/non-string/incorrect scopes %j',
    async (scopes) => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{}] } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'key', scopes }] } as never)
      await expect(authorizePlayground(context, input, 'chat')).rejects.toMatchObject({
        status: 403,
        code: 'project_key_required',
      })
    },
  )
})
describe('one-shot forwarding', () => {
  it.each(['caller', 'deadline'])(
    'the shared 60-second operation deadline and %s cancellation remain active after response headers',
    async (source) => {
      vi.stubEnv('NEXUS_GATEWAY_URL', 'http://127.0.0.1:4312')
      const deadline = new AbortController(),
        caller = new AbortController()
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
      const token = 'playground-session-fixture-01234567890123456789'
      vi.mocked(pool.query)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'session',
              user_id: 'user',
              token_hash: sha256hex(token),
              expires_at: new Date('2030-01-01'),
              created_at: new Date(),
              revoked_at: null,
            },
          ],
        } as never)
        .mockResolvedValueOnce({
          rows: [{ organization_id: 'org', tenant_id: 'tenant', name: 'Org', slug: 'org', role: 'owner' }],
        } as never)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'project' }] } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'key', scopes: ['chat:write'] }] } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'intent', tenant_id: 'tenant', created_at: new Date() }] } as never)
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"unfinished":'))
        },
        cancel,
      })
      let receive: () => void = () => {}
      const headers = new Promise<void>((resolve) => {
        receive = resolve
      })
      const fetch = vi.fn().mockImplementation(async () => {
        receive()
        return new Response(body)
      })
      vi.stubGlobal('fetch', fetch)
      const pending = handlePlayground(
        new Request('http://console.example/api/playground/chat', {
          method: 'POST',
          body: JSON.stringify(input),
          signal: caller.signal,
          headers: { cookie: `${SESSION_COOKIE}=${token}; nexus_csrf=fixture`, 'x-csrf-token': 'fixture' },
        }),
        'chat',
      )
      await headers
      ;(source === 'caller' ? caller : deadline).abort()
      const result = await pending
      expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000)
      expect(result.status).toBe(504)
      expect(result.headers.get('cache-control')).toBe('no-store')
      expect(await result.json()).toMatchObject({ error: { code: 'playground_delivery_unknown' } })
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
    },
  )
  it('sends exactly the text contract with stream:false, no identity or session headers', async () => {
    vi.stubEnv('NEXUS_GATEWAY_URL', 'http://127.0.0.1:4312/base')
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { headers: { 'x-request-id': 'gateway-real-id' } }))
    vi.stubGlobal('fetch', fetch)
    expect(await forwardPlayground(input, 'chat', new AbortController().signal)).toMatchObject({
      requestId: 'gateway-real-id',
      canContinue: true,
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, options] = fetch.mock.calls[0]
    expect(url.href).toBe('http://127.0.0.1:4312/v1/chat/completions')
    expect(options).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    })
    expect(Object.keys(options.headers)).toEqual(['authorization', 'content-type'])
    expect(JSON.parse(options.body)).toEqual({
      model: input.model,
      messages: input.messages,
      max_tokens: 32,
      stream: false,
    })
  })
  it.each(['malformed', 'oversized', 'network', 'rejected'])(
    'never replays a %s result or exposes diagnostics',
    async (mode) => {
      vi.stubEnv('NEXUS_GATEWAY_URL', 'http://127.0.0.1:4312')
      const fetch = vi.fn()
      if (mode === 'network') fetch.mockRejectedValue(new Error('private network credential'))
      else
        fetch.mockResolvedValue(
          new Response(
            mode === 'oversized' ? 'x'.repeat(PLAYGROUND_LIMITS.responseBytes + 1) : 'private upstream diagnostic',
            { status: mode === 'rejected' ? 403 : 200 },
          ),
        )
      vi.stubGlobal('fetch', fetch)
      await expect(forwardPlayground(input, 'chat', new AbortController().signal)).rejects.toSatisfy(
        (error: Error) => error instanceof PlaygroundError && !error.message.includes('private'),
      )
      expect(fetch).toHaveBeenCalledOnce()
    },
  )
})
