import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { tokenHash } from '@/lib/connectors/control'
import { createLocalChannel } from '@/lib/channels/local-management'
import { resolveContext } from '@/app/api/_lib/control-plane'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'
import { POST as discover } from '@/app/api/playground/models/route'
import { POST as chat } from '@/app/api/playground/chat/route'
import { GET as trace } from '@/app/api/logs/[id]/trace/route'
import { processOutboxEvent } from '../../services/worker/processor'

const database = new URL(process.env.DATABASE_URL || 'https://invalid')
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.port !== '55439' ||
  database.search ||
  database.hash ||
  !['/convergence_playground_gateway_test', '/convergence_ci15'].includes(database.pathname)
)
  throw new Error('Explicit disposable Playground Gateway database required')

const artifactRoot = path.resolve('.test-artifacts/playground-gateway')
const key = 'sk-nx-playground-gateway-fixture-0123456789'
const project = 'playground-gateway-project'
const model = 'playground-fixture-model'
const prompt = 'PRIVATE_PLAYGROUND_PROMPT_CANARY'
const output = 'PRIVATE_PLAYGROUND_OUTPUT_CANARY'
const upstreamSecret = 'playground-provider-fixture-secret'
const envKeys = [
  'NEXUS_GATEWAY_URL',
  'NEXT_PUBLIC_GATEWAY_BASE_URL',
  'NEXUS_DESKTOP_ORIGIN',
  'NEXUS_LOCAL_CREDENTIAL_DIR',
  'NEXUS_CONNECTORS_ENABLED',
] as const
const original = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]))
let folder = '',
  controlURL = '',
  gatewayURL = '',
  cookie = '',
  connectionId = ''
let control: Server, upstream: Server, gateway: ChildProcess
let logs = '',
  calls = 0
const providerMessages: unknown[] = []
const requestIds: string[] = []

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
function consoleRequest(route: string, body?: unknown, signal?: AbortSignal) {
  return new Request(controlURL + route, {
    method: body === undefined ? 'GET' : 'POST',
    signal,
    headers: {
      cookie: `${cookie}; nexus_csrf=playground-gateway`,
      'x-csrf-token': 'playground-gateway',
      'content-type': 'application/json',
      host: new URL(controlURL).host,
      origin: controlURL,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function serveSnapshot(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!req.url?.startsWith('/api/internal/gateway/snapshot')) {
      res.writeHead(404).end()
      return
    }
    const response = await snapshot(
      new Request(controlURL + req.url, {
        headers: { authorization: req.headers.authorization || '', host: new URL(controlURL).host },
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  } catch {
    res.writeHead(500).end()
  }
}
async function waitReady() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error('Fixture Gateway exited before readiness')
    try {
      if ((await fetch(gatewayURL + '/readyz', { signal: AbortSignal.timeout(500) })).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('Fixture Gateway readiness deadline exceeded')
}

beforeAll(async () => {
  if ((await pool.query('SELECT current_database() AS name')).rows[0].name !== database.pathname.slice(1))
    throw new Error('Fixture database identity mismatch')
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const runner = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(runner)
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('playground-gateway-org','playground-gateway-tenant','Playground Gateway','playground-gateway');
    INSERT INTO users(id,email,password_hash) VALUES('playground-gateway-owner','playground-gateway@example.invalid','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES('playground-gateway-org','playground-gateway-tenant','playground-gateway-owner','owner');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('playground-gateway-project','playground-gateway-tenant','playground-gateway-org','Gateway Project');`)
  await pool.query(
    `INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes) VALUES('playground-gateway-key','playground-gateway-tenant','playground-gateway-org',$1,'Fixture',$2,'sk-nx','["models:read","chat:write"]')`,
    [project, tokenHash(key)],
  )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: 'playground-gateway-owner' })).token}`
  await mkdir(artifactRoot, { recursive: true })
  folder = await mkdtemp(path.join(artifactRoot, 'run-'))
  process.env.NEXUS_LOCAL_CREDENTIAL_DIR = path.join(folder, 'credentials')
  process.env.NEXUS_CONNECTORS_ENABLED = 'false'
  control = createServer((req, res) => {
    void serveSnapshot(req, res)
  })
  controlURL = await listen(control)
  process.env.NEXUS_DESKTOP_ORIGIN = controlURL
  upstream = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    expect(req.headers.authorization).toBe(`Bearer ${upstreamSecret}`)
    expect(body.model).toBe(model)
    expect(body.stream).toBe(true)
    calls++
    providerMessages.push(body.messages)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `provider-fixture-${calls}` })
    const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
    res.write(
      event({
        id: `fixture-${calls}`,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }],
      }),
    )
    if (calls === 3) return // Hold one in-flight stream until the downstream caller cancels.
    res.write(event({ id: `fixture-${calls}`, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    if (calls === 1)
      res.write(
        event({
          choices: [],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      )
    res.end('data: [DONE]\n\n')
  })
  const upstreamURL = await listen(upstream)
  const ctx = await resolveContext(consoleRequest('/api/channels'))
  if (!ctx) throw new Error('Fixture owner session unavailable')
  const channel = await createLocalChannel(ctx, {
    name: 'Playground fixture',
    providerId: 'custom',
    customProvider: true,
    secret: upstreamSecret,
    baseUrl: upstreamURL + '/v1',
    protocol: 'openai',
    models: [model],
    capabilities: ['chat'],
    weight: 10,
    priority: 0,
    region: 'global',
  })
  connectionId = (await pool.query(`SELECT metadata->>'connection_id' id FROM channels WHERE id=$1`, [channel.id]))
    .rows[0].id
  await pool.query('UPDATE owned_connections SET project_id=$1 WHERE id=$2', [project, connectionId])
  const reservation = createServer()
  gatewayURL = await listen(reservation)
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const binary = path.join(folder, process.platform === 'win32' ? 'gateway.exe' : 'gateway')
  execFileSync('go', ['build', '-o', binary, '.'], { cwd: 'services/gateway', windowsHide: true })
  gateway = spawn(binary, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GATEWAY_ENV: 'test',
      GATEWAY_ADDR: new URL(gatewayURL).host,
      CONTROL_PLANE_URL: controlURL,
      GATEWAY_OTEL_DISABLED: 'true',
      GATEWAY_SNAPSHOT_REFRESH_SECONDS: '1',
      GATEWAY_TOTAL_TIMEOUT_SECONDS: '10',
      GATEWAY_TLS_CERT: '',
      GATEWAY_TLS_KEY: '',
      CONTROL_PLANE_CA_FILE: '',
      REDIS_URL: '',
      BUDGET_SERVICE_URL: '',
      KMS_PROVIDER: 'local',
    },
  })
  gateway.stdout!.on('data', (chunk) => {
    logs += chunk
  })
  gateway.stderr!.on('data', (chunk) => {
    logs += chunk
  })
  await waitReady()
  process.env.NEXUS_GATEWAY_URL = gatewayURL
}, 60000)

afterAll(async () => {
  if (gateway && gateway.exitCode === null) {
    const ended = once(gateway, 'exit')
    gateway.kill()
    await ended
  }
  for (const server of [control, upstream])
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  await pool.end()
  if (folder) {
    const relative = path.relative(artifactRoot, path.resolve(folder))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Invalid fixture cleanup target')
    await rm(folder, { recursive: true, force: true })
  }
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  expect(logs).not.toContain(prompt)
  expect(logs).not.toContain(output)
  expect(logs).not.toContain(upstreamSecret)
  expect(logs).not.toContain(key)
})

it('discovers through the real signed Gateway without model execution or accounting', async () => {
  const response = await discover(consoleRequest('/api/playground/models', { projectId: project, apiKey: key }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ version: 1, models: [{ id: model }] })
  expect(calls).toBe(0)
  expect((await pool.query('SELECT id FROM request_records')).rowCount).toBe(0)
  expect((await pool.query('SELECT id FROM outbox_events')).rowCount).toBe(0)
})

it('sends two explicit turns once each and returns durable real request attribution with known and absent usage', async () => {
  for (const messages of [
    [{ role: 'user', content: prompt }],
    [
      { role: 'user', content: prompt },
      { role: 'assistant', content: output },
      { role: 'user', content: 'Follow up' },
    ],
  ]) {
    const response = await chat(
      consoleRequest('/api/playground/chat', { projectId: project, apiKey: key, model, messages, maxTokens: 32 }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const reply = await response.json()
    expect(reply.assistant.content).toBe(output)
    expect(reply.canContinue).toBe(true)
    expect(typeof reply.requestId).toBe('string')
    requestIds.push(reply.requestId)
    expect(reply.usage.inputTokens).toBe(calls === 1 ? '5' : null)
    const stored = (
      await pool.query(
        'SELECT r.status,f.project_id,a.connection_id FROM request_records r JOIN request_project_facts f ON f.request_id=r.id AND f.tenant_id=r.tenant_id JOIN attempts a ON a.request_id=r.id AND a.tenant_id=r.tenant_id WHERE r.id=$1',
        [reply.requestId],
      )
    ).rows[0]
    expect(stored).toMatchObject({ status: 'completed', project_id: project, connection_id: connectionId })
  }
  expect(calls).toBe(2)
  expect(providerMessages[1]).toEqual([
    { role: 'user', content: prompt },
    { role: 'assistant', content: output },
    { role: 'user', content: 'Follow up' },
  ])
  const facts = (
    await pool.query(
      `SELECT f.request_id,f.project_id,f.api_key_id,a.connection_id,a.execution_mode,a.attempt_number,a.status FROM request_project_facts f JOIN attempts a ON a.request_id=f.request_id AND a.tenant_id=f.tenant_id WHERE f.request_id=ANY($1::text[]) ORDER BY f.request_id`,
      [requestIds],
    )
  ).rows
  expect(facts).toHaveLength(2)
  for (const fact of facts)
    expect(fact).toMatchObject({
      project_id: project,
      api_key_id: 'playground-gateway-key',
      connection_id: connectionId,
      execution_mode: 'byok',
      attempt_number: 1,
      status: 'completed',
    })
})

it('keeps normal Worker reconciliation/idempotency and content-free trace evidence', async () => {
  const events = (await pool.query(`SELECT * FROM outbox_events WHERE aggregate_type='usage' ORDER BY id`)).rows
  expect(events).toHaveLength(2)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const event of events) await processOutboxEvent(client, event)
    for (const event of events) await processOutboxEvent(client, event)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  expect((await pool.query('SELECT id FROM usage_events')).rowCount).toBe(2)
  expect((await pool.query('SELECT id FROM reconciliation_cases')).rowCount).toBe(2)
  expect((await pool.query('SELECT id FROM usage_records')).rowCount).toBe(0)
  expect((await pool.query('SELECT id FROM ledger_transactions')).rowCount).toBe(0)
  for (const id of requestIds) {
    const response = await trace(consoleRequest(`/api/logs/${id}/trace`), { params: Promise.resolve({ id }) })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain(id)
    expect(text).not.toContain(prompt)
    expect(text).not.toContain(output)
    expect(text).not.toContain(upstreamSecret)
    expect(text).not.toContain(key)
  }
  for (const table of ['request_records', 'attempts', 'outbox_events', 'usage_events', 'reconciliation_cases']) {
    const serialized = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows)
    expect(serialized).not.toContain(prompt)
    expect(serialized).not.toContain(output)
    expect(serialized).not.toContain(upstreamSecret)
    expect(serialized).not.toContain(key)
  }
  expect(calls).toBe(2)
})

it('propagates caller cancellation to the real Gateway and records uncertainty without replay', async () => {
  const controller = new AbortController()
  const pending = chat(
    consoleRequest(
      '/api/playground/chat',
      {
        projectId: project,
        apiKey: key,
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 32,
      },
      controller.signal,
    ),
  )
  const startedDeadline = Date.now() + 5000
  while (calls < 3 && Date.now() < startedDeadline) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls).toBe(3)
  controller.abort()
  const response = await pending
  expect(response.status).toBe(504)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await response.json()).error.code).toBe('playground_delivery_unknown')
  let recorded: { id: string; status: string } | undefined
  const persistedDeadline = Date.now() + 5000
  while (Date.now() < persistedDeadline) {
    recorded = (await pool.query('SELECT id,status FROM request_records WHERE NOT(id=ANY($1::text[]))', [requestIds]))
      .rows[0]
    if (recorded?.status === 'unknown') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(recorded?.status).toBe('unknown')
  const event = (await pool.query('SELECT event_type,payload FROM outbox_events WHERE aggregate_id=$1', [recorded?.id]))
    .rows[0]
  expect(event.event_type).toBe('usage.v2.unknown')
  expect(event.payload.usage.input_tokens).toBe(null)
  expect(event.payload.usage.output_tokens).toBe(null)
  expect((await pool.query('SELECT id FROM attempts WHERE request_id=$1', [recorded?.id])).rowCount).toBe(1)
  expect(calls).toBe(3)
})
