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
import { PATCH as patchChannel } from '@/app/api/channels/[id]/route'
import { GET as resources } from '@/app/api/resources/route'
import { isDeepStrictEqual } from 'node:util'
import { createHmac } from 'node:crypto'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { snapshotSigningKeyring } from '@/lib/secrets/snapshot-signing'
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
  !['/connector_test_capability_round51', '/convergence_ci15'].includes(database.pathname)
)
  throw new Error('Dedicated loopback eligibility database required')

const tenant = 'eligibility-tenant'
const organization = 'eligibility-org'
const project = 'eligibility-project'
const apiKeyId = 'eligibility-key'
const apiKey = 'sk-nx-connector-project-key-0123456789'
const localCredential = 'upstream-test-secret'
const privatePrompt = 'private eligibility prompt marker 51'
const sharedModel = 'eligibility-shared'
const allModels = [sharedModel]
const artifactRoot = path.resolve('.test-artifacts/connector-capability-audit/runtime')
const fixtureEnv = {
  NEXUS_CONNECTORS_ENABLED: 'true',
  GATEWAY_INTERNAL_TOKEN: 'eligibility-control-fixture-token',
  SNAPSHOT_SIGNING_KEY: 'eligibility-independent-signing-fixture',
  UPSTREAM_ENCRYPTION_KEY: 'eligibility-wrapping-fixture',
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
let folder = '',
  cookie = '',
  gatewayURL = '',
  controlURL = '',
  gatewayExe = '',
  cliExe = ''
let target: Connector, tlsAgent: HTTPSAgent | undefined
const children: ChildProcess[] = []
const servers: ReturnType<typeof createTLSServer>[] = []
let processLogs = '',
  remoteCredentialLeak = false
const upstreamCalls: Array<{ side: 'target'; model: string; valid: boolean }> = []
let currentLeaseToken = ''
let frozenSnapshot: { body: string; served: number; generation: string; checksum: string } | undefined
const completedCalls: Array<{ requestId: string; streaming: boolean; catalogVersion: string }> = []

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const admin = (pathname: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      cookie: `${cookie}; nexus_csrf=eligibility-csrf`,
      'x-csrf-token': 'eligibility-csrf',
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
  throw new Error(`Eligibility fixture timed out: ${label}`)
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
  const closed = once(child, 'close', { signal: AbortSignal.timeout(8000) })
  const force = setTimeout(() => child.kill('SIGKILL'), 2000)
  try {
    child.kill()
    await closed
  } catch {
    throw new Error('Connector fixture process did not stop')
  } finally {
    clearTimeout(force)
  }
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
    const response =
      pathname === '/api/internal/gateway/snapshot' &&
      new URL(request.url).searchParams.get('tenant_id') === tenant &&
      frozenSnapshot &&
      req.headers.authorization === `Bearer ${fixtureEnv.GATEWAY_INTERNAL_TOKEN}`
        ? (frozenSnapshot.served++,
          new Response(frozenSnapshot.body, {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          }))
        : handler
          ? await handler(request)
          : new Response('', { status: 404 })
    if (pathname === '/api/connector/lease' && response.ok)
      currentLeaseToken = (await response.clone().json()).leaseToken
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    res.writeHead(500)
    res.end('fixture failed')
  }
}
async function ready() {
  for (const fixture of [target]) {
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
beforeAll(async () => {
  Object.assign(process.env, fixtureEnv)
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrationPath = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(migrationPath)
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,'Eligibility fixture','eligibility-org')`,
    [organization, tenant],
  )
  await pool.query(
    `INSERT INTO users(id,email,password_hash) VALUES('eligibility-admin','eligibility@example.invalid','synthetic-unused-hash')`,
  )
  await pool.query(
    `INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,'eligibility-admin','admin')`,
    [organization, tenant],
  )
  await pool.query(`INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,'Eligibility project')`, [
    project,
    tenant,
    organization,
  ])
  await pool.query(
    `INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes)
    VALUES($1,$2,$3,$4,'Eligibility key',$5,'sk-nx','["models:read","chat:write"]')`,
    [apiKeyId, tenant, organization, project, tokenHash(apiKey)],
  )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: 'eligibility-admin' })).token}`
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
  for (const [side, approvedModels, priority] of [['target', [sharedModel], 0]] as const) {
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
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-private-fixture-header': 'private eligibility header',
        })
        const event = (value: unknown) =>
          `data: ${JSON.stringify({ id: 'synthetic-message', model: body.model, ...(value as object) })}\n\n`
        res.write(event({ choices: [{ index: 0, delta: { content: 'Round51 reply' }, finish_reason: null }] }))
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
        apiKeyEnv: 'ROUND51_LOCAL_KEY',
        caFile: path.join(folder, 'tls-cert.pem'),
        upstreamTimeoutSeconds: 20,
      }),
      { mode: 0o600 },
    )
    const pairing = recordChild(
      spawn(cliExe, ['pair', '--config', configFile, '--identity', identityFile], {
        env: childEnv({ ROUND51_LOCAL_KEY: localCredential }),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(10000),
      }),
    )
    pairing.stdin!.end(configuredBody.pairingToken + '\n')
    expect((await once(pairing, 'close'))[0], `${side} CLI pairing`).toBe(0)
  }
  target = connectors[0]
  recordChild(
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
  for (const side of ['target'])
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
        { env: childEnv({ ROUND51_LOCAL_KEY: localCredential }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    )
  await waitFor(ready, 'live connector')
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
  ).toEqual([{ id: target.channelId, priority: 0 }])
  expect(upstreamCalls).toHaveLength(0)
}, 90000)

afterAll(async () => {
  const stopped = await Promise.allSettled(children.map(stop))
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
    await rm(folder, { recursive: true, force: true })
  for (const value of [apiKey, cookie, localCredential, privatePrompt, database.href, 'private eligibility header'])
    expect(processLogs.includes(value), 'Process logs omit private fixture inputs').toBe(false)
  if (stopped.some((result) => result.status === 'rejected')) throw new Error('Connector fixture process did not stop')
})

interface SignedEnvelope {
  signature: string
  bundle: {
    generated_at: string
    snapshot: { catalog_version: { id: string; checksum: string } }
    channels: Array<{ id: string; capabilities: string[]; priority: number; weight: number }>
    models: Array<{ id: string }>
  }
}
async function signedSnapshot() {
  const response = await snapshot(
    new Request(`${controlURL}/api/internal/gateway/snapshot?tenant_id=${tenant}`, {
      headers: { authorization: `Bearer ${fixtureEnv.GATEWAY_INTERNAL_TOKEN}` },
    }),
  )
  expect(response.status).toBe(200)
  const body = await response.text()
  const envelope = JSON.parse(body) as SignedEnvelope
  const expected = createHmac('sha256', snapshotSigningKeyring().current.key)
    .update(canonicalJson(envelope.bundle), 'utf8')
    .digest('hex')
  expect(envelope.signature === expected, 'The original production envelope is signed').toBe(true)
  return { body, envelope }
}
async function models() {
  const response = await gatewayFetch('/v1/models')
  expect(response.status).toBe(200)
  return (await response.json()).data.map((item: { id: string }) => item.id).sort() as string[]
}
async function projection() {
  const management = await state(
    admin(`/api/connections/${target.connectionId}/connector`),
    params(target.connectionId),
  )
  expect(management.status).toBe(200)
  const connection = await management.json()
  const catalog = await resources(admin('/api/resources'))
  expect(catalog.status).toBe(200)
  const resource = (await catalog.json()).resources.find(
    (item: { channelId: string }) => item.channelId === target.channelId,
  )
  expect(resource).toBeDefined()
  const { envelope } = await signedSnapshot()
  const channel = envelope.bundle.channels.find((item) => item.id === target.channelId)
  const stored = (
    await pool.query('SELECT capabilities,priority,weight,enabled FROM channels WHERE id=$1', [target.channelId])
  ).rows[0]
  return {
    stored,
    state: connection.state as string,
    readyModels: connection.readyModels as string[],
    resource: { capabilities: resource.capabilities, status: resource.status, health: resource.health },
    signed: {
      capabilities: channel?.capabilities ?? null,
      priority: channel?.priority ?? null,
      weight: channel?.weight ?? null,
      models: envelope.bundle.models.map((model) => model.id).sort(),
      checksum: envelope.bundle.snapshot.catalog_version.checksum,
    },
  }
}
async function patch(body: unknown) {
  return patchChannel(admin(`/api/channels/${target.channelId}`, 'PATCH', body), params(target.channelId))
}
async function liveAuthorization(scope: 'chat:write' | 'models:read') {
  const response = await authorize(
    new Request(`${controlURL}/api/internal/gateway/connector`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixtureEnv.GATEWAY_INTERNAL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseToken: currentLeaseToken,
        tenantId: tenant,
        organizationId: organization,
        projectId: project,
        keyId: apiKeyId,
        channelId: target.channelId,
        connectionId: target.connectionId,
        scope,
        ...(scope === 'models:read' ? { requestedModels: [sharedModel] } : { model: sharedModel }),
      }),
    }),
  )
  // Keep raw grant/token material out of assertion output.
  const body = await response.json()
  return { status: response.status, models: response.ok ? (body.models as string[]) : [] }
}
async function identityAndLease() {
  return {
    identity: (
      await pool.query('SELECT id,credential_hash,revoked_at FROM connector_identities WHERE connection_id=$1', [
        target.connectionId,
      ])
    ).rows,
    lease: (
      await pool.query(
        'SELECT id,lease_token_hash,connector_id,ready_models,revoked_at FROM connector_leases WHERE connection_id=$1',
        [target.connectionId],
      )
    ).rows,
  }
}
async function cardinality() {
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM request_records) requests,
    (SELECT count(*)::int FROM attempts) attempts,
    (SELECT count(*)::int FROM request_project_facts) frozen_facts,
    (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='usage') terminal_outboxes`)
  return { ...counts.rows[0], upstreamExecutions: upstreamCalls.length }
}
async function callChat(streaming = false) {
  const before = upstreamCalls.length
  const response = await gatewayFetch('/v1/chat/completions', {
    model: sharedModel,
    messages: [{ role: 'user', content: privatePrompt }],
    stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    max_tokens: 32,
  })
  expect(response.headers.get('x-private-fixture-header')).toBeNull()
  const body = await response.text()
  const requestId = response.headers.get('x-request-id') ?? ''
  expect(requestId).toMatch(/^req_[a-f0-9]{32}$/)
  if (response.status === 200) {
    const usage = {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }
    if (streaming) {
      expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)))
      expect(events.map((event) => event.choices[0]?.delta?.content ?? '').join('')).toBe('Round51 reply')
      expect(events.some((event) => event.choices[0]?.finish_reason === 'stop')).toBe(true)
      expect(events.find((event) => event.usage)?.usage).toEqual(usage)
    } else {
      const completion = JSON.parse(body)
      expect(completion.choices[0].message.content).toBe('Round51 reply')
      expect(completion.usage).toEqual(usage)
    }
    expect(upstreamCalls.length).toBe(before + 1)
    const event = (
      await pool.query("SELECT payload FROM outbox_events WHERE aggregate_type='usage' AND aggregate_id=$1", [
        requestId,
      ])
    ).rows
    expect(event).toHaveLength(1)
    completedCalls.push({ requestId, streaming, catalogVersion: event[0].payload.catalog_version_id })
  }
  // A failing request is represented only by its fixed status/code and counts.
  const errorCode = response.status === 200 ? null : (JSON.parse(body).error?.code as string | undefined)
  return { status: response.status, requestId, errorCode, upstreamExecutions: upstreamCalls.length - before }
}

it('preserves legacy text, public mixed capabilities, priority/weight and temporary pause without rotating identity', async () => {
  const identity = await identityAndLease()
  await pool.query('UPDATE channels SET capabilities=$2::jsonb WHERE id=$1', [
    target.channelId,
    JSON.stringify(['text']),
  ])
  const legacy = await projection()
  expect(legacy).toMatchObject({
    stored: { capabilities: ['text'] },
    state: 'online',
    readyModels: [sharedModel],
    resource: { capabilities: ['text'], status: 'active', health: 'healthy' },
    signed: { capabilities: ['streaming', 'text'], models: [sharedModel] },
  })
  await waitFor(ready, 'legacy text remains ready')
  expect((await callChat()).status).toBe(200)

  expect((await patch({ capabilities: ['chat', 'embeddings'], priority: 7, weight: 9 })).status).toBe(200)
  expect(await projection()).toMatchObject({
    stored: { capabilities: ['chat', 'embeddings'], priority: 7, weight: 9 },
    resource: { capabilities: ['chat', 'embeddings'], status: 'active', health: 'healthy' },
    signed: { capabilities: ['streaming', 'text'], priority: 7, weight: 9 },
  })
  await waitFor(ready, 'mixed capabilities remain ready')
  expect((await callChat(true)).status).toBe(200)

  const beforeInvalid = (await pool.query('SELECT * FROM channels WHERE id=$1', [target.channelId])).rows
  const audits = (await pool.query('SELECT id FROM audit_events')).rowCount
  for (const capabilities of [['text', 'streaming'], []]) {
    const invalid = await patch({ capabilities })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.code).toBe('invalid_request')
  }
  expect(
    isDeepStrictEqual((await pool.query('SELECT * FROM channels WHERE id=$1', [target.channelId])).rows, beforeInvalid),
  ).toBe(true)
  expect((await pool.query('SELECT id FROM audit_events')).rowCount).toBe(audits)
  expect((await patch({ enabled: false })).status).toBe(200)
  await waitFor(async () => (await models()).length === 0, 'paused model list')
  expect(await projection()).toMatchObject({
    state: 'online',
    readyModels: [],
    resource: { status: 'disabled', health: 'unknown' },
    signed: { capabilities: null, models: [] },
  })
  expect((await patch({ enabled: true })).status).toBe(200)
  await waitFor(ready, 'resumed model list')
  expect(
    isDeepStrictEqual(await identityAndLease(), identity),
    'Configuration preserves identity and lease authority',
  ).toBe(true)
}, 20000)

it('uses live eligibility despite the original signed bundle and restores actual Chat only after explicit chat PATCH', async () => {
  expect((await patch({ capabilities: ['chat'] })).status).toBe(200)
  await waitFor(ready, 'chat before stale snapshot')
  const identity = await identityAndLease()
  const original = await signedSnapshot()
  const retained = {
    body: original.body,
    served: 0,
    generation: original.envelope.bundle.generated_at,
    checksum: original.envelope.bundle.snapshot.catalog_version.checksum,
  }
  frozenSnapshot = retained
  try {
    await waitFor(async () => retained.served > 0, 'Gateway receives retained original signed generation')
    expect(await models()).toEqual([sharedModel])
    expect((await callChat()).status).toBe(200)
    expect(completedCalls.at(-1)?.catalogVersion).toBe(original.envelope.bundle.snapshot.catalog_version.id)
    const before = await cardinality()
    expect((await patch({ capabilities: ['embeddings'] })).status).toBe(200)

    // Collect every real OLD outcome before asserting desired eligibility. The
    // relay keeps serving the untouched production-signed bytes throughout.
    const latest = await projection()
    const listed = await models()
    const call = await callChat()
    const liveChat = await liveAuthorization('chat:write')
    const liveModels = await liveAuthorization('models:read')
    const after = await cardinality()
    const sameAuthority = isDeepStrictEqual(await identityAndLease(), identity)
    const retainedBytesUnchanged =
      frozenSnapshot.body === original.body &&
      frozenSnapshot.generation === original.envelope.bundle.generated_at &&
      frozenSnapshot.checksum === original.envelope.bundle.snapshot.catalog_version.checksum

    expect((await patch({ capabilities: ['chat'] })).status).toBe(200)
    const restored = await projection()
    const restoredModels = await models()
    const restoredCall = await callChat()
    const restoredAuthority = isDeepStrictEqual(await identityAndLease(), identity)

    expect(retainedBytesUnchanged && retained.served > 0, 'A routable original signed generation remains served').toBe(
      true,
    )
    expect.soft(latest).toMatchObject({
      stored: { capabilities: ['embeddings'] },
      state: 'online',
      readyModels: [],
      resource: { capabilities: ['embeddings'], status: 'pending', health: 'unknown' },
      signed: { capabilities: null, models: [] },
    })
    expect
      .soft(latest.signed.checksum === retained.checksum, 'Fresh ineligible configuration changes the checksum')
      .toBe(false)
    expect.soft(listed).toEqual([])
    expect
      .soft(call, 'Live authorization rejects Chat while stale configuration remains routable')
      .toMatchObject({ status: 503, errorCode: 'snapshot_unavailable' })
    expect.soft(call.upstreamExecutions).toBe(0)
    expect.soft(liveChat).toEqual({ status: 403, models: [] })
    expect.soft(liveModels).toEqual({ status: 403, models: [] })
    expect.soft(after).toEqual(before)
    expect(sameAuthority && restoredAuthority, 'Eligibility edits do not rotate identity or lease').toBe(true)
    expect(restored).toMatchObject({
      stored: { capabilities: ['chat'] },
      state: 'online',
      readyModels: [sharedModel],
      resource: { capabilities: ['chat'], status: 'active', health: 'healthy' },
      signed: { capabilities: ['streaming', 'text'], models: [sharedModel] },
    })
    expect(restoredModels).toEqual([sharedModel])
    expect(restoredCall).toMatchObject({ status: 200, upstreamExecutions: 1 })
  } finally {
    frozenSnapshot = undefined
    await pool.query('UPDATE channels SET capabilities=$2::jsonb WHERE id=$1', [
      target.channelId,
      JSON.stringify(['chat']),
    ])
  }
}, 20000)

it('denies unsupported-only, empty and non-array persisted values without changing transport or execution facts', async () => {
  const before = await cardinality()
  const identity = await identityAndLease()
  const observations = []
  try {
    for (const [name, value] of [
      ['streaming only', ['streaming']],
      ['empty array', []],
      ['object key', { chat: true }],
      ['string value', 'chat'],
      ['JSON null', null],
    ] as const) {
      await pool.query('UPDATE channels SET capabilities=$2::jsonb WHERE id=$1', [
        target.channelId,
        JSON.stringify(value),
      ])
      const current = await projection()
      observations.push({
        name,
        state: current.state,
        readyModels: current.readyModels,
        status: current.resource.status,
        health: current.resource.health,
        signedCapabilities: current.signed.capabilities,
        signedModels: current.signed.models,
        chat: await liveAuthorization('chat:write'),
        models: await liveAuthorization('models:read'),
      })
    }
  } finally {
    await pool.query('UPDATE channels SET capabilities=$2::jsonb WHERE id=$1', [
      target.channelId,
      JSON.stringify(['chat']),
    ])
  }
  expect(await cardinality()).toEqual(before)
  expect(isDeepStrictEqual(await identityAndLease(), identity)).toBe(true)
  for (const observation of observations)
    expect.soft(observation, observation.name).toMatchObject({
      state: 'online',
      readyModels: [],
      status: 'pending',
      health: 'unknown',
      signedCapabilities: null,
      signedModels: [],
      chat: { status: 403, models: [] },
      models: { status: 403, models: [] },
    })
}, 20000)

it('retains one known-usage terminal fact per actual execution with exact attribution and private inputs excluded', async () => {
  expect(completedCalls.length).toBeGreaterThanOrEqual(4)
  expect(new Set(completedCalls.map((call) => call.requestId)).size).toBe(completedCalls.length)
  expect(upstreamCalls.every((call) => call.valid && call.side === 'target' && call.model === sharedModel)).toBe(true)
  expect(await cardinality()).toEqual({
    requests: completedCalls.length,
    attempts: completedCalls.length,
    frozen_facts: completedCalls.length,
    terminal_outboxes: completedCalls.length,
    upstreamExecutions: completedCalls.length,
  })
  for (const { requestId, streaming, catalogVersion } of completedCalls) {
    const record = (await pool.query('SELECT * FROM request_records WHERE id=$1', [requestId])).rows
    const fact = (await pool.query('SELECT * FROM request_project_facts WHERE request_id=$1', [requestId])).rows
    const attempts = (await pool.query('SELECT * FROM attempts WHERE request_id=$1', [requestId])).rows
    const events = (
      await pool.query("SELECT * FROM outbox_events WHERE aggregate_type='usage' AND aggregate_id=$1", [requestId])
    ).rows
    expect(record).toHaveLength(1)
    expect(record[0]).toMatchObject({
      tenant_id: tenant,
      organization_id: organization,
      project_id: project,
      downstream_key_id: apiKeyId,
      provider_credential_id: target.credentialId,
      status: 'completed',
      execution_mode: 'byok',
      provider_price_version_id: null,
      input_tokens: 5,
      output_tokens: 2,
      cached_tokens: 0,
      reasoning_tokens: 0,
    })
    expect(fact).toHaveLength(1)
    expect(fact[0]).toMatchObject({
      tenant_id: tenant,
      organization_id: organization,
      project_id: project,
      api_key_id: apiKeyId,
      streaming,
      execution_mode: 'byok',
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      tenant_id: tenant,
      attempt_number: 1,
      channel_id: target.channelId,
      connection_id: target.connectionId,
      provider_credential_id: target.credentialId,
      status: 'completed',
      execution_mode: 'byok',
      price_version_id: null,
      input_tokens: 5,
      output_tokens: 2,
      cached_tokens: 0,
      reasoning_tokens: 0,
    })
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      schema_version: 2,
      request_id: requestId,
      attempt_id: attempts[0].id,
      status: 'completed',
      price_version_id: null,
      catalog_version_id: catalogVersion,
      attribution: {
        project_id: project,
        api_key_id: apiKeyId,
        channel_id: target.channelId,
        connection_id: target.connectionId,
        credential_id: target.credentialId,
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
    const stored = JSON.stringify([record, fact, attempts, events])
    for (const value of [apiKey, cookie, localCredential, privatePrompt, 'private eligibility header'])
      expect(stored.includes(value), 'Durable facts omit private fixture inputs').toBe(false)
  }
  // No Worker is run here: unknown price pins remain null, never fabricated.
  for (const table of ['usage_records', 'ledger_transactions', 'ledger_postings', 'wallet_ledger_entries'])
    expect((await pool.query(`SELECT id FROM ${table}`)).rowCount).toBe(0)
  expect(remoteCredentialLeak).toBe(false)
})
