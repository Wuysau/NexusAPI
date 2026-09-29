import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { clearTimeout, setTimeout } from 'node:timers'

const { query, connectorState, requireContext } = vi.hoisted(() => ({
  query: vi.fn(),
  connectorState: vi.fn(),
  requireContext: vi.fn(),
}))
vi.mock('@/db', () => ({ pool: { query } }))
vi.mock('@/lib/connectors/control', () => ({ connectorState, tokenHash: () => 'synthetic-key-hash' }))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext,
  readJsonBody: (request: Request) => request.json(),
  apiError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  jsonOk: (body: unknown) => Response.json(body),
  routeError: (error: { status?: number }) =>
    Response.json({ error: { code: 'fixture_denied' } }, { status: error.status ?? 500 }),
}))

import { POST } from '@/app/api/connections/[id]/connector/test/route'

const model = 'synthetic-local-model'
const privateMarker = 'synthetic-private-abort-or-upstream-marker'
const params = { params: Promise.resolve({ id: 'connection-fixture' }) }
const context = { tenantId: 'tenant-fixture', organizationId: 'org-fixture' }
const servers: Server[] = []
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
const request = (signal?: AbortSignal) =>
  new Request('http://console.invalid/api/connections/connection-fixture/connector/test', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'synthetic-project-key', model }),
  })
const attributionChecks = () => query.mock.calls.filter(([sql]) => sql.includes('SELECT id FROM attempts'))

async function settleWithin<T>(promise: Promise<T>, delay = 1000): Promise<T | undefined> {
  let cancelTimer: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), delay)
        cancelTimer = () => clearTimeout(timer)
      }),
    ])
  } finally {
    cancelTimer?.()
  }
}

// Fetch remains real. Only authority and SQL are fixtures, so cancellation must
// close an actual HTTP connection rather than merely pass a signal to a mock.
async function gateway(handler: (response: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-request-id', 'request-fixture')
    handler(res)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  vi.stubEnv('NEXUS_GATEWAY_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}`)
}

beforeEach(() => {
  requireContext.mockReset().mockResolvedValue(context)
  connectorState.mockReset().mockResolvedValue({ readyModels: [model] })
  query.mockReset().mockResolvedValue({ rowCount: 1, rows: [{ id: 'fixture' }] })
  vi.stubEnv('NODE_ENV', 'test')
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('does not dispatch a constructed Request whose signal is already canceled', async () => {
  let calls = 0
  await gateway((res) => {
    calls++
    res.end(JSON.stringify({ model }))
  })
  const controller = new AbortController()
  const req = request(controller.signal)
  controller.abort(new Error(privateMarker))
  const response = await POST(req, params)
  expect(req.signal.aborted).toBe(true)
  expect(calls).toBe(0)
  expect(response.status).toBe(504)
  const body = await response.text()
  expect(JSON.parse(body)).toMatchObject({ error: { code: 'connector_test_timeout' } })
  expect(body).not.toContain(privateMarker)
  expect(attributionChecks()).toHaveLength(0)
})

it.each(['before_headers', 'during_body'] as const)(
  'cancels the real gateway connection %s without reporting completed attribution',
  async (phase) => {
    let release!: () => void
    let started!: () => void
    let startedReading!: () => void
    let canceled!: () => void
    let calls = 0
    let closedBeforeFinish = false
    const received = new Promise<void>((resolve) => {
      started = resolve
    })
    const readingBody = new Promise<void>((resolve) => {
      startedReading = resolve
    })
    const canceledConnection = new Promise<void>((resolve) => {
      canceled = resolve
    })
    if (phase === 'during_body') {
      const realFetch = globalThis.fetch.bind(globalThis)
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        const response = await realFetch(...args)
        const readJSON = response.json.bind(response)
        response.json = () => {
          startedReading()
          return readJSON()
        }
        return response
      })
    }
    await gateway((res) => {
      calls++
      res.on('close', () => {
        if (!res.writableFinished) {
          closedBeforeFinish = true
          canceled()
        }
      })
      if (phase === 'during_body') {
        res.writeHead(200)
        res.write('{"model":')
        res.flushHeaders()
      }
      release = () => res.end(phase === 'during_body' ? JSON.stringify(model) + '}' : JSON.stringify({ model }))
      started()
    })
    const controller = new AbortController()
    const req = request(controller.signal)
    const pending = POST(req, params)
    await received
    if (phase === 'during_body') await readingBody
    controller.abort(new Error(privateMarker))
    const early = await settleWithin(pending)
    await settleWithin(canceledConnection)
    const promptlyCanceled = closedBeforeFinish
    // Always release the fixture so a regression cannot strand the handler.
    release()
    const response = await pending
    const body = await response.text()
    expect(req.signal.aborted).toBe(true)
    expect(body).not.toContain(privateMarker)
    expect(calls).toBe(1)
    expect(promptlyCanceled).toBe(true)
    expect(early?.status).toBe(504)
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'connector_test_timeout' } })
    expect(attributionChecks()).toHaveLength(0)
  },
)

it('retains the independent 60000 ms deadline when the caller signal stays active', async () => {
  let calls = 0
  let canceled!: () => void
  const canceledConnection = new Promise<void>((resolve) => {
    canceled = resolve
  })
  await gateway((res) => {
    calls++
    res.on('close', () => {
      if (!res.writableFinished) canceled()
    })
  })
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => nativeTimeout(500))
  const controller = new AbortController()
  const req = request(controller.signal)
  const response = await POST(req, params)
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000)
  expect(req.signal.aborted).toBe(false)
  expect(calls).toBe(1)
  expect(response.status).toBe(504)
  expect(await response.json()).toMatchObject({ error: { code: 'connector_test_timeout' } })
  expect(await settleWithin(canceledConnection.then(() => true))).toBe(true)
  expect(attributionChecks()).toHaveLength(0)
})

it('retains one successful gateway call and its connection attribution check', async () => {
  let calls = 0
  await gateway((res) => {
    calls++
    res.end(JSON.stringify({ model }))
  })
  const req = request()
  const response = await POST(req, params)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, model, requestId: 'request-fixture' })
  expect(calls).toBe(1)
  expect(requireContext).toHaveBeenCalledWith(req, 'credential:read')
  expect(connectorState).toHaveBeenCalledWith(context, 'connection-fixture')
  expect(query.mock.calls[0][1]).toEqual(['connection-fixture', 'tenant-fixture', 'org-fixture', 'synthetic-key-hash'])
  expect(attributionChecks()).toHaveLength(1)
  expect(attributionChecks()[0][1]).toEqual(['request-fixture', 'tenant-fixture', 'connection-fixture'])
  expect(query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true)
})

it.each(['permission', 'project_key'] as const)('rejects %s without contacting the gateway', async (kind) => {
  let calls = 0
  await gateway((res) => {
    calls++
    res.end(JSON.stringify({ model }))
  })
  if (kind === 'permission') requireContext.mockRejectedValue({ status: 403 })
  else query.mockResolvedValue({ rowCount: 0, rows: [] })
  const response = await POST(request(), params)
  expect(response.status).toBe(403)
  expect(calls).toBe(0)
  expect(attributionChecks()).toHaveLength(0)
  if (kind === 'permission') expect(query).not.toHaveBeenCalled()
})

it('keeps gateway failures static and does not query completed attribution', async () => {
  await gateway((res) => {
    res.writeHead(503)
    res.end(JSON.stringify({ error: { message: privateMarker } }))
  })
  const response = await POST(request(), params)
  const body = await response.text()
  expect(response.status).toBe(503)
  expect(JSON.parse(body)).toMatchObject({ error: { code: 'connector_test_failed' } })
  expect(body).not.toContain(privateMarker)
  expect(attributionChecks()).toHaveLength(0)
})

it('does not report success when the completed request used a different connection', async () => {
  await gateway((res) => res.end(JSON.stringify({ model })))
  query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 })
  const response = await POST(request(), params)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'different_channel_selected' } })
  expect(attributionChecks()).toHaveLength(1)
})
