import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { POST as createConnection } from '@/app/api/connections/route'
import { POST as configure, GET as state } from '@/app/api/connections/[id]/connector/route'
import { POST as pair } from '@/app/api/connector/pair/route'
import { POST as lease } from '@/app/api/connector/lease/route'
import { POST as authorize } from '@/app/api/internal/gateway/connector/route'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { tokenHash } from '@/lib/connectors/control'
import { processOutboxEvent } from '../../services/worker/processor'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTLSServer, request as httpsRequest, Agent as HTTPSAgent } from 'node:https'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

// This suite resets one explicitly named disposable database. URL query options
// could override pg's host/port, so reject them before making a connection.
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
let database: URL
try {
  database = new URL(process.env.DATABASE_URL)
} catch {
  throw new Error('Invalid disposable DATABASE_URL')
}
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.port !== '55439' ||
  database.search !== '' ||
  !['/connector_test_attribution_round49', '/convergence_ci15'].includes(database.pathname)
)
  throw new Error('Dedicated loopback attribution database required')

const tenant = 'attribution-tenant'
const organization = 'attribution-org'
const project = 'attribution-project'
const apiKeyId = 'attribution-key'
const apiKey = 'sk-nx-connector-project-key-0123456789'
const localCredential = 'upstream-test-secret'
const privatePrompt = 'private attribution prompt marker 49'
const sharedModel = 'attribution-shared'
const targetModel = 'attribution-target-only'
const fallbackModel = 'attribution-fallback-only'
const allModels = [sharedModel, targetModel, fallbackModel].sort()
const artifactRoot = path.resolve('.test-artifacts/connector-test-attribution')
const fixtureEnv = {
  NEXUS_CONNECTORS_ENABLED: 'true',
  GATEWAY_INTERNAL_TOKEN: 'attribution-control-fixture-token',
  SNAPSHOT_SIGNING_KEY: 'attribution-independent-signing-fixture',
  UPSTREAM_ENCRYPTION_KEY: 'attribution-wrapping-fixture',
  SNAPSHOT_SIGNING_KEY_VERSION: '1',
  SNAPSHOT_SIGNING_KEY_PREVIOUS: '',
  SNAPSHOT_SIGNING_KEY_PREVIOUS_VERSION: '',
}
const originalEnv = Object.fromEntries(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]))
interface Connector {
  connectionId: string
  channelId: string
  credentialId: string
  models: string[]
}
interface RouteResult {
  status: number
  ok: boolean
  code: string | null
  requestId: string | null
  modelMatches: boolean
}
let folder = '',
  cookie = '',
  gatewayURL = '',
  controlURL = '',
  gatewayExe = '',
  cliExe = ''
let target: Connector, fallback: Connector, gateway: ChildProcess | undefined, tlsAgent: HTTPSAgent | undefined
const children: ChildProcess[] = []
const servers: ReturnType<typeof createTLSServer>[] = []
let processLogs = '',
  remoteCredentialLeak = false
const upstreamCalls: Array<{ side: 'target' | 'fallback'; model: string; valid: boolean }> = []
let releaseTarget: (() => void) | undefined
let targetEntered: (() => void) | undefined
let fallbackRequestId = '',
  occupierRequestId = ''

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const admin = (pathname: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      cookie: `${cookie}; nexus_csrf=attribution-csrf`,
      'x-csrf-token': 'attribution-csrf',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: database.href, ...fixtureEnv, ...extra }
  for (const key of [
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'ComSpec',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'HOME',
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}
async function waitFor(check: () => Promise<boolean>, label: string, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Attribution fixture timed out: ${label}`)
}
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `https://127.0.0.1:${(server.address() as { port: number }).port}`
}
function recordChild(child: ChildProcess) {
  children.push(child)
  child.stdout?.on('data', (chunk) => {
    processLogs += chunk
  })
  child.stderr?.on('data', (chunk) => {
    processLogs += chunk
  })
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill()
  await closed
}
async function gatewayFetch(route: string, body?: unknown, signal = AbortSignal.timeout(30000)) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      gatewayURL + route,
      {
        agent: tlsAgent,
        method: body === undefined ? 'GET' : 'POST',
        signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      },
      (response) =>
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode,
            headers: response.headers as Record<string, string>,
          }),
        ),
    )
    request.on('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function relay(req: IncomingMessage, res: ServerResponse) {
  try {
    remoteCredentialLeak ||= Object.values(req.headers).some((value) => String(value).includes(localCredential))
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = new Request(controlURL + req.url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
    const pathname = new URL(request.url).pathname
    const handler =
      pathname === '/api/connector/pair'
        ? pair
        : pathname === '/api/connector/lease'
          ? lease
          : pathname === '/api/internal/gateway/connector'
            ? authorize
            : pathname === '/api/internal/gateway/snapshot'
              ? snapshot
              : null
    const response = handler ? await handler(request) : new Response('', { status: 404 })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    res.writeHead(500)
    res.end('fixture failed')
  }
}
async function ready() {
  for (const fixture of [target, fallback]) {
    const response = await state(
      admin(`/api/connections/${fixture.connectionId}/connector`),
      params(fixture.connectionId),
    )
    if (response.status !== 200) return false
    const body = await response.json()
    if (
      body.state !== 'online' ||
      JSON.stringify([...body.readyModels].sort()) !== JSON.stringify([...fixture.models].sort())
    )
      return false
  }
  const response = await gatewayFetch('/v1/models')
  return (
    response.ok &&
    JSON.stringify((await response.json()).data.map((model: { id: string }) => model.id).sort()) ===
      JSON.stringify(allModels)
  )
}
async function invokeRoute(): Promise<RouteResult> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/connector-test-route.ts'], {
    env: childEnv({ NODE_EXTRA_CA_CERTS: path.join(folder, 'tls-cert.pem'), NEXUS_GATEWAY_URL: gatewayURL }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(15000),
  })
  children.push(child)
  let stdout = '',
    stderr = ''
  child.stdout!.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr!.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin!.end(JSON.stringify({ cookie, apiKey, model: sharedModel, connectionId: target.connectionId }))
  const [code] = await once(child, 'close')
  expect(code, 'Native route helper exit').toBe(0)
  expect(stderr === '', 'Native route helper stderr is empty').toBe(true)
  for (const value of [apiKey, cookie, localCredential, database.href])
    expect((stdout + stderr).includes(value), 'Helper output omits fixture credentials').toBe(false)
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error('Invalid safe route helper output')
  }
}

beforeAll(async () => {
  Object.assign(process.env, fixtureEnv)
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrationPath = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(migrationPath)
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,'Attribution fixture','attribution-org')`,
    [organization, tenant],
  )
  await pool.query(
    `INSERT INTO users(id,email,password_hash) VALUES('attribution-admin','attribution@example.invalid','synthetic-unused-hash')`,
  )
  await pool.query(
    `INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,'attribution-admin','admin')`,
    [organization, tenant],
  )
  await pool.query(`INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,'Attribution project')`, [
    project,
    tenant,
    organization,
  ])
  await pool.query(
    `INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes)
    VALUES($1,$2,$3,$4,'Attribution key',$5,'sk-nx','["models:read","chat:write"]')`,
    [apiKeyId, tenant, organization, project, tokenHash(apiKey)],
  )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: 'attribution-admin' })).token}`
  await mkdir(artifactRoot, { recursive: true })
  folder = await mkdtemp(path.join(artifactRoot, 'run-'))
  gatewayExe = path.join(folder, process.platform === 'win32' ? 'gateway.exe' : 'gateway')
  cliExe = path.join(folder, process.platform === 'win32' ? 'nexus-connector.exe' : 'nexus-connector')
  const buildOptions = { cwd: 'services/gateway', windowsHide: true, env: childEnv(), stdio: 'pipe' as const }
  execFileSync('go', ['run', '../../tests/fixtures/connector-tls.go', folder], buildOptions)
  execFileSync('go', ['build', '-o', gatewayExe, '.'], buildOptions)
  execFileSync('go', ['build', '-o', cliExe, './cmd/nexus-connector'], buildOptions)
  const cert = await readFile(path.join(folder, 'tls-cert.pem'))
  const tlsKey = await readFile(path.join(folder, 'tls-key.pem'))
  tlsAgent = new HTTPSAgent({ ca: cert })
  const control = createTLSServer({ cert, key: tlsKey }, (req, res) => {
    void relay(req, res)
  })
  servers.push(control)
  controlURL = await listen(control)
  const reservation = createServer()
  gatewayURL = await listen(reservation)
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const connectors: Connector[] = []
  for (const [side, approvedModels, priority] of [
    ['target', [sharedModel, targetModel], 0],
    ['fallback', [sharedModel, fallbackModel], 10],
  ] as const) {
    const created = await createConnection(
      admin('/api/connections', 'POST', { provider: 'ollama', mode: 'local_sidecar', projectId: project }),
    )
    expect(created.status).toBe(201)
    const connectionId = (await created.json()).connection.id as string
    const configured = await configure(
      admin(`/api/connections/${connectionId}/connector`, 'POST', { models: approvedModels }),
      params(connectionId),
    )
    expect(configured.status).toBe(200)
    const configuredBody = await configured.json()
    const channel = (
      await pool.query('UPDATE channels SET priority=$1 WHERE id=$2 RETURNING provider_credential_id', [
        priority,
        configuredBody.channelId,
      ])
    ).rows[0]
    const fixture = {
      connectionId,
      channelId: configuredBody.channelId as string,
      credentialId: channel.provider_credential_id as string,
      models: [...approvedModels],
    }
    connectors.push(fixture)
    const upstream = createTLSServer({ cert, key: tlsKey }, (req, res) => {
      void (async () => {
        if (req.url === '/v1/models') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ data: approvedModels.map((id) => ({ id })) }))
          return
        }
        if (req.url !== '/v1/chat/completions') {
          res.writeHead(404)
          res.end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        upstreamCalls.push({
          side,
          model: body.model,
          valid:
            body.stream === true &&
            approvedModels.includes(body.model) &&
            req.headers.authorization === `Bearer ${localCredential}`,
        })
        if (side === 'target' && body.model === targetModel) {
          targetEntered?.()
          await new Promise<void>((resolve) => {
            releaseTarget = resolve
          })
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-private-fixture-header': 'private attribution header',
        })
        const event = (value: unknown) =>
          `data: ${JSON.stringify({ id: 'synthetic-message', model: body.model, ...(value as object) })}\n\n`
        res.write(event({ choices: [{ index: 0, delta: { content: 'Round49 reply' }, finish_reason: null }] }))
        res.write(event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
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
      })().catch(() => {
        res.destroy()
      })
    })
    servers.push(upstream)
    const upstreamURL = await listen(upstream)
    const configFile = path.join(folder, `${side}.json`)
    const identityFile = path.join(folder, `${side}-identity.json`)
    await writeFile(
      configFile,
      JSON.stringify({
        controlUrl: controlURL,
        gatewayUrl: gatewayURL,
        upstreamUrl: upstreamURL + '/v1',
        models: approvedModels,
        apiKeyEnv: 'ROUND49_LOCAL_KEY',
        caFile: path.join(folder, 'tls-cert.pem'),
        upstreamTimeoutSeconds: 20,
      }),
      { mode: 0o600 },
    )
    const pairing = recordChild(
      spawn(cliExe, ['pair', '--config', configFile, '--identity', identityFile], {
        env: childEnv({ ROUND49_LOCAL_KEY: localCredential }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(10000),
      }),
    )
    pairing.stdin!.end(configuredBody.pairingToken + '\n')
    expect((await once(pairing, 'close'))[0], `${side} CLI pairing`).toBe(0)
  }
  ;[target, fallback] = connectors
  gateway = recordChild(
    spawn(gatewayExe, [], {
      env: childEnv({
        GATEWAY_ENV: 'test',
        CONTROL_PLANE_URL: controlURL,
        GATEWAY_ADDR: new URL(gatewayURL).host,
        GATEWAY_REPLICAS: '1',
        GATEWAY_OTEL_DISABLED: 'true',
        GATEWAY_CHANNEL_MAX_CONCURRENT: '1',
        GATEWAY_CONCURRENCY_WAIT_MS: '0',
        GATEWAY_MAX_CONCURRENT: '8',
        GATEWAY_TENANT_MAX_CONCURRENT: '8',
        GATEWAY_SNAPSHOT_REFRESH_SECONDS: '1',
        GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS: '10',
        GATEWAY_TOTAL_TIMEOUT_SECONDS: '30',
        NEXUS_LOCAL_CREDENTIAL_DIR: '',
        REDIS_URL: '',
        GATEWAY_TLS_CERT: path.join(folder, 'tls-cert.pem'),
        GATEWAY_TLS_KEY: path.join(folder, 'tls-key.pem'),
        CONTROL_PLANE_CA_FILE: path.join(folder, 'tls-cert.pem'),
      }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  await waitFor(async () => {
    try {
      return (await gatewayFetch('/readyz')).ok
    } catch {
      return false
    }
  }, 'Gateway ready')
  for (const side of ['target', 'fallback'])
    recordChild(
      spawn(
        cliExe,
        [
          'run',
          '--config',
          path.join(folder, `${side}.json`),
          '--identity',
          path.join(folder, `${side}-identity.json`),
        ],
        { env: childEnv({ ROUND49_LOCAL_KEY: localCredential }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    )
  await waitFor(ready, 'both live candidates')
  const bundle = await snapshot(
    new Request(`${controlURL}/api/internal/gateway/snapshot?tenant_id=${tenant}`, {
      headers: { authorization: `Bearer ${fixtureEnv.GATEWAY_INTERNAL_TOKEN}` },
    }),
  )
  expect(bundle.status).toBe(200)
  const signed = await bundle.json()
  expect(signed.signature).toBeTruthy()
  expect(
    signed.bundle.channels
      .map((channel: { id: string; priority: number }) => ({ id: channel.id, priority: channel.priority }))
      .sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority),
  ).toEqual([
    { id: target.channelId, priority: 0 },
    { id: fallback.channelId, priority: 10 },
  ])
  expect(upstreamCalls).toHaveLength(0)
}, 90000)

afterAll(async () => {
  releaseTarget?.()
  await Promise.all(children.map(stop))
  tlsAgent?.destroy()
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await pool.end()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (folder && path.dirname(path.resolve(folder)) === artifactRoot && path.basename(folder).startsWith('run-'))
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  for (const value of [apiKey, cookie, localCredential, privatePrompt, database.href, 'private attribution header'])
    expect(processLogs.includes(value), 'Process logs omit private fixture inputs').toBe(false)
})

async function requestFacts(
  requestId: string,
  winner: Connector,
  attempts: Array<{ fixture: Connector; status: string; error_code: string | null }>,
) {
  const record = (await pool.query('SELECT * FROM request_records WHERE id=$1', [requestId])).rows[0]
  expect(record).toMatchObject({
    tenant_id: tenant,
    organization_id: organization,
    downstream_key_id: apiKeyId,
    project_id: project,
    provider_credential_id: winner.credentialId,
    status: 'completed',
    input_tokens: 5,
    output_tokens: 2,
    cached_tokens: 0,
    reasoning_tokens: 0,
    execution_mode: 'byok',
    provider_price_version_id: null,
  })
  const fact = (await pool.query('SELECT * FROM request_project_facts WHERE request_id=$1', [requestId])).rows[0]
  expect(fact).toMatchObject({
    tenant_id: tenant,
    organization_id: organization,
    project_id: project,
    api_key_id: apiKeyId,
    execution_mode: 'byok',
    streaming: false,
  })
  const actual = (await pool.query('SELECT * FROM attempts WHERE request_id=$1 ORDER BY attempt_number', [requestId]))
    .rows
  expect(actual).toHaveLength(attempts.length)
  for (const [index, expected] of attempts.entries()) {
    expect(actual[index]).toMatchObject({
      tenant_id: tenant,
      attempt_number: index + 1,
      connection_id: expected.fixture.connectionId,
      channel_id: expected.fixture.channelId,
      provider_credential_id: expected.fixture.credentialId,
      status: expected.status,
      error_code: expected.error_code,
      execution_mode: 'byok',
      price_version_id: null,
    })
    expect(actual[index]).toMatchObject(
      expected.status === 'completed'
        ? { input_tokens: 5, output_tokens: 2, cached_tokens: 0, reasoning_tokens: 0 }
        : { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 },
    )
  }
  const events = (
    await pool.query("SELECT * FROM outbox_events WHERE aggregate_type='usage' AND aggregate_id=$1", [requestId])
  ).rows
  expect(events).toHaveLength(1)
  expect(events[0].payload).toMatchObject({
    schema_version: 2,
    request_id: requestId,
    attempt_id: actual.at(-1).id,
    status: 'completed',
    price_version_id: null,
    attribution: {
      project_id: project,
      api_key_id: apiKeyId,
      channel_id: winner.channelId,
      connection_id: winner.connectionId,
      credential_id: winner.credentialId,
      execution_mode: 'byok',
    },
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      estimated: false,
    },
  })
  const stored = JSON.stringify([record, fact, actual, events])
  for (const value of [apiKey, cookie, localCredential, privatePrompt, 'Reply with OK.', 'private attribution header'])
    expect(stored.includes(value), 'Durable facts omit private input').toBe(false)
}

it('rejects a target test when capacity admission fails there and another live connector completes it', async () => {
  const controller = new AbortController()
  let entered = false
  targetEntered = () => {
    entered = true
  }
  const occupying = gatewayFetch(
    '/v1/chat/completions',
    { model: targetModel, messages: [{ role: 'user', content: privatePrompt }], stream: false, max_tokens: 32 },
    controller.signal,
  )
  let verdict: RouteResult | undefined
  try {
    await waitFor(async () => entered, 'target upstream gate', 10000)
    await waitFor(ready, 'both candidates remain online while target is occupied')
    const pending = (await pool.query('SELECT id FROM request_records WHERE request_model=$1', [targetModel])).rows
    expect(pending).toHaveLength(1)
    occupierRequestId = pending[0].id
    verdict = await invokeRoute()
    const completed = (await pool.query('SELECT id FROM request_records WHERE request_model=$1', [sharedModel])).rows
    expect(completed).toHaveLength(1)
    fallbackRequestId = completed[0].id
    await requestFacts(fallbackRequestId, fallback, [
      { fixture: target, status: 'failed', error_code: 'concurrency_exceeded' },
      { fixture: fallback, status: 'completed', error_code: '' },
    ])
    expect(upstreamCalls).toEqual([
      { side: 'target', model: targetModel, valid: true },
      { side: 'fallback', model: sharedModel, valid: true },
    ])
  } finally {
    releaseTarget?.()
    if (!releaseTarget) controller.abort()
    const response = await occupying
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toBe('Round49 reply')
    await requestFacts(occupierRequestId, target, [{ fixture: target, status: 'completed', error_code: '' }])
  }
  // Assert the desired route verdict last so the OLD run still proves the real
  // pre-dispatch failure, completed winner and occupier cleanup.
  expect(verdict!.status).toBe(409)
  expect(verdict!.code).toBe('different_channel_selected')
  expect(verdict!.ok).toBe(false)
}, 30000)

it('accepts the target completed attempt and retains one unpriced terminal event per actual execution', async () => {
  const verdict = await invokeRoute()
  expect(verdict).toMatchObject({ status: 200, ok: true, code: null, modelMatches: true })
  expect(verdict.requestId).toBeTruthy()
  await requestFacts(verdict.requestId!, target, [{ fixture: target, status: 'completed', error_code: '' }])
  expect(new Set([occupierRequestId, fallbackRequestId, verdict.requestId]).size).toBe(3)
  expect(upstreamCalls).toEqual([
    { side: 'target', model: targetModel, valid: true },
    { side: 'fallback', model: sharedModel, valid: true },
    { side: 'target', model: sharedModel, valid: true },
  ])
  expect(remoteCredentialLeak).toBe(false)
  expect((await pool.query('SELECT id FROM request_records')).rowCount).toBe(3)
  expect((await pool.query('SELECT request_id FROM request_project_facts')).rowCount).toBe(3)
  expect((await pool.query('SELECT id FROM attempts')).rowCount).toBe(4)
  const events = (await pool.query("SELECT * FROM outbox_events WHERE aggregate_type='usage'")).rows
  expect(events).toHaveLength(3)
  expect(new Set(events.map((event) => event.payload.event_id)).size).toBe(3)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const event of events)
      expect(await processOutboxEvent(client, event)).toMatchObject({
        requestId: event.aggregate_id,
        disposition: 'reconciled',
        channelKind: 'byok',
        chargeMicros: 0n,
      })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  const anchors = (await pool.query('SELECT request_id,attempt_id,payload FROM usage_events')).rows
  expect(anchors).toHaveLength(3)
  for (const anchor of anchors) {
    const event = events.find((entry) => entry.aggregate_id === anchor.request_id)!
    expect(anchor.attempt_id).toBe(event.payload.attempt_id)
    expect(anchor.payload.event).toEqual(event.payload)
  }
  expect((await pool.query("SELECT id FROM reconciliation_cases WHERE reason='missing_price_version'")).rowCount).toBe(
    3,
  )
  for (const table of ['usage_records', 'ledger_transactions', 'ledger_postings', 'wallet_ledger_entries'])
    expect((await pool.query(`SELECT id FROM ${table}`)).rowCount, table).toBe(0)
}, 15000)
