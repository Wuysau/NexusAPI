import { once } from 'node:events'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiGet, apiSend, errorMessage } from './api'

const nativeFetch = globalThis.fetch
const invalidResponseMessage = '响应内容无法读取，请刷新页面确认操作结果。'
const privateMarker = 'synthetic-private-response-marker'
const fixtures: { server: Server; requests: () => number }[] = []

type Outcome<T> = { state: 'fulfilled'; value: T } | { state: 'rejected'; error: unknown }

async function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { state: 'fulfilled', value: await promise }
  } catch (error) {
    return { state: 'rejected', error }
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('response body fixture did not settle')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function serve(status: number, body: string, holdOpen = false, headers: Record<string, string> = {}) {
  let requests = 0
  let activeResponse: ServerResponse | undefined
  const server = createServer((request, response) => {
    requests++
    request.resume()
    activeResponse = response
    response.writeHead(status, { 'content-type': 'application/json', ...headers })
    if (holdOpen) {
      response.write(body)
      response.flushHeaders()
    } else {
      response.end(body)
    }
  })
  fixtures.push({ server, requests: () => requests })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('unexpected response fixture address')
  return {
    url: `http://127.0.0.1:${address.port}/api/fixture`,
    incomplete: () => !!activeResponse && !activeResponse.writableEnded && !activeResponse.destroyed,
    disconnect: () => activeResponse?.destroy(),
  }
}

// Only observe the real Response.json call and its rejection. Fetch, the HTTP
// connection, and body consumption remain native so the gate follows headers.
async function interruptBody(invoke: () => Promise<unknown>, interrupt: () => void) {
  let started!: () => void
  let readError: unknown
  const readingBody = new Promise<void>((resolve) => {
    started = resolve
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await nativeFetch(...args)
    const readJSON = response.json.bind(response)
    response.json = () => {
      const pending = readJSON()
      started()
      return pending.catch((error: unknown) => {
        readError = error
        throw error
      })
    }
    return response
  })
  const pending = observe(invoke())
  await within(readingBody)
  interrupt()
  const result = await within(pending)
  return { result, readError }
}

function expectApiError(result: Outcome<unknown>, status: number, code: string, message: string) {
  expect(result.state).toBe('rejected')
  if (result.state !== 'rejected') throw new Error('expected response rejection')
  // Boolean checks avoid including a raw response/parser message in test output.
  expect(result.error instanceof ApiError).toBe(true)
  if (!(result.error instanceof ApiError)) throw new Error('expected ApiError')
  expect(result.error.status).toBe(status)
  expect(result.error.code).toBe(code)
  expect(result.error.message === message).toBe(true)
  expect(errorMessage(result.error) === message).toBe(true)
  expect(result.error.message.includes(privateMarker)).toBe(false)
  return result.error
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) {
    fixture.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      fixture.server.close((error) => (error ? reject(error) : resolve()))
    })
    expect(fixture.requests()).toBe(1)
  }
})

describe.each(['apiGet', 'apiSend'] as const)('%s response bodies', (mode) => {
  const invoke = (url: string, signal?: AbortSignal) =>
    mode === 'apiGet' ? apiGet(url, signal) : apiSend(url, 'POST', { operation: 'synthetic-operation' }, signal)

  it('preserves the original AbortError when canceled after JSON reading starts', async () => {
    const fixture = await serve(200, '{"ok":', true)
    const controller = new AbortController()
    const { result, readError } = await interruptBody(
      () => invoke(fixture.url, controller.signal),
      () => {
        expect(fixture.incomplete()).toBe(true)
        controller.abort()
      },
    )
    expect(controller.signal.aborted).toBe(true)
    expect(readError instanceof Error && readError.name === 'AbortError').toBe(true)
    expect(result.state).toBe('rejected')
    if (result.state === 'rejected') expect(result.error === readError).toBe(true)
  })

  it('rejects a broken successful body with a static error and the original HTTP status', async () => {
    const status = mode === 'apiGet' ? 200 : 202
    const fixture = await serve(status, `{"private":"${privateMarker}","ok":`, true)
    const { result, readError } = await interruptBody(
      () => invoke(fixture.url),
      () => {
        expect(fixture.incomplete()).toBe(true)
        fixture.disconnect()
      },
    )
    expect(readError instanceof Error).toBe(true)
    expectApiError(result, status, 'invalid_response', invalidResponseMessage)
  })

  it('rejects malformed successful JSON without exposing the parser message', async () => {
    const status = mode === 'apiGet' ? 200 : 201
    const fixture = await serve(status, privateMarker)
    expectApiError(await observe(invoke(fixture.url)), status, 'invalid_response', invalidResponseMessage)
  })

  it.each(['', ' \r\n\t '])('rejects a non-JSON successful empty or whitespace body (%j)', async (body) => {
    const fixture = await serve(200, body)
    expectApiError(await observe(invoke(fixture.url)), 200, 'invalid_response', invalidResponseMessage)
  })

  it('rejects a successful body that cannot be decoded as the declared gzip encoding', async () => {
    const fixture = await serve(200, privateMarker, false, { 'content-encoding': 'gzip' })
    expectApiError(await observe(invoke(fixture.url)), 200, 'invalid_response', invalidResponseMessage)
  })

  it('returns a valid JSON object', async () => {
    const fixture = await serve(200, '{"ok":true}')
    expect(await invoke(fixture.url)).toEqual({ ok: true })
  })

  it.each([
    ['null', null],
    ['false', false],
  ] as const)('preserves the valid JSON %s value', async (body, expected) => {
    const fixture = await serve(200, body)
    expect(await invoke(fixture.url)).toBe(expected)
  })

  it.each([204, 205])('preserves a successful empty %i response', async (status) => {
    const fixture = await serve(status, '')
    expect(await invoke(fixture.url)).toBeNull()
  })

  it('preserves structured HTTP error normalization', async () => {
    const fixture = await serve(403, '{"error":{"code":"forbidden","message":"Denied"}}')
    const error = expectApiError(await observe(invoke(fixture.url)), 403, 'forbidden', 'Denied')
    expect(error.isForbidden).toBe(true)
    expect(error.isUnauthenticated).toBe(false)
  })

  it('preserves the 401 forbidden error used by high-risk reauthentication', async () => {
    const fixture = await serve(401, '{"error":{"code":"forbidden","message":"Reauthenticate"}}')
    const error = expectApiError(await observe(invoke(fixture.url)), 401, 'forbidden', 'Reauthenticate')
    expect(error.isUnauthenticated).toBe(true)
    expect(error.isForbidden).toBe(false)
  })

  it('preserves the static HTTP error fallback for a non-JSON error body', async () => {
    const fixture = await serve(502, `<html>${privateMarker}</html>`)
    expectApiError(await observe(invoke(fixture.url)), 502, 'http_error', '请求失败（502）')
  })

  it('preserves HTTP error normalization when its body is canceled after headers', async () => {
    const fixture = await serve(502, '{"error":', true)
    const controller = new AbortController()
    const { result, readError } = await interruptBody(
      () => invoke(fixture.url, controller.signal),
      () => {
        expect(fixture.incomplete()).toBe(true)
        controller.abort()
      },
    )
    expect(readError instanceof Error && readError.name === 'AbortError').toBe(true)
    expectApiError(result, 502, 'http_error', '请求失败（502）')
  })
})

it('does not run an await-only mutation success continuation after malformed JSON', async () => {
  const fixture = await serve(200, `{"private":"${privateMarker}","ok":`)
  let announcedSuccess = false
  const result = await observe(
    (async () => {
      await apiSend(fixture.url, 'PATCH', { enabled: false })
      announcedSuccess = true // ChannelTable and KeyManager announce success after this await.
    })(),
  )
  expect(announcedSuccess).toBe(false)
  expectApiError(result, 200, 'invalid_response', invalidResponseMessage)
})

it('rejects before a typed caller can dereference a fabricated null token response', async () => {
  const fixture = await serve(201, `{"private":"${privateMarker}","token":`)
  let continued = false
  const result = await observe(
    (async () => {
      const response = await apiSend<{ token: string }>(fixture.url, 'POST')
      continued = true
      return response.token // KeyManager reads the newly created token here.
    })(),
  )
  expect(continued).toBe(false)
  expectApiError(result, 201, 'invalid_response', invalidResponseMessage)
})
