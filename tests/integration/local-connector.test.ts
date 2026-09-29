import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTLSServer, request as httpsRequest, Agent as HTTPSAgent } from 'node:https'
import { Readable } from 'node:stream'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { POST as createConnection, GET as listConnections } from '@/app/api/connections/route'
import { POST as configure, GET as state } from '@/app/api/connections/[id]/connector/route'
import { POST as heartbeat } from '@/app/api/connections/[id]/heartbeat/route'
import { DELETE as revoke } from '@/app/api/connections/[id]/route'
import { POST as pair } from '@/app/api/connector/pair/route'
import { POST as lease } from '@/app/api/connector/lease/route'
import { POST as authorize } from '@/app/api/internal/gateway/connector/route'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'
import { GET as resources } from '@/app/api/resources/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { tokenHash } from '@/lib/connectors/control'
import { processOutboxEvent } from '../../services/worker/processor'

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.includes('connector_test'))
  throw new Error('Dedicated connector_test DATABASE_URL is required; this suite resets its schema')
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const folder = path.resolve('.test-artifacts/local-connector')
const gatewayExe = path.join(folder, process.platform === 'win32' ? 'gateway.exe' : 'gateway')
const cliExe = path.join(folder, process.platform === 'win32' ? 'nexus-connector.exe' : 'nexus-connector')
const key = 'sk-nx-connector-project-key-0123456789'
const otherKey = 'sk-nx-other-project-key-0123456789'
const tenantKey = 'sk-nx-other-tenant-key-0123456789'
const models = ['qwen2.5:7b', 'llama3.2:3b']
let connectionId = '',
  cookie = '',
  viewerCookie = '',
  pairingToken = '',
  controlURL = '',
  gatewayURL = '',
  upstreamURL = ''
let gateway: ChildProcess, connector: ChildProcess, control: Server, upstream: Server
let gatewayLogs = '',
  cliLogs = '',
  mode = 'normal',
  calls = 0,
  cancelled = 0,
  modelBatchRequests = 0,
  singleModelAuthorizations = 0
let gatewayEnv: NodeJS.ProcessEnv
let tlsAgent: HTTPSAgent
const upstreamTokenLimits: Array<{ max_tokens?: number; max_completion_tokens?: number }> = []
const params = () => ({ params: Promise.resolve({ id: connectionId }) })
const admin = (method = 'GET', body?: unknown, authCookie = cookie) =>
  new Request('http://localhost/api/connections', {
    method,
    headers: {
      cookie: `${authCookie}; nexus_csrf=connector-test`,
      'x-csrf-token': 'connector-test',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const runtime = (token: string, body?: unknown) =>
  new Request('http://localhost/api/connector', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function waitFor(check: () => Promise<boolean>, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`condition timed out; gateway=${gatewayLogs}; connector=${cliLogs}`)
}
async function kill(child?: ChildProcess) {
  if (child && child.exitCode === null && !child.killed) {
    const done = once(child, 'exit')
    child.kill()
    await done
  }
}
async function gatewayFetch(route: string, body?: unknown, token = key, signal?: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      gatewayURL + route,
      {
        agent: tlsAgent,
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: signal ?? AbortSignal.timeout(12000),
      },
      (res) =>
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode,
            headers: res.headers as Record<string, string>,
          }),
        ),
    )
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const chat = (stream = false, model = models[0]) => ({
  model,
  messages: [{ role: 'user', content: 'private prompt marker 91fb' }],
  stream,
  max_tokens: 32,
})
async function relayRoute(req: IncomingMessage, res: ServerResponse) {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = new Request(controlURL + req.url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/internal/gateway/connector') {
      const metadata = JSON.parse(Buffer.concat(chunks).toString())
      if (Array.isArray(metadata.requestedModels)) modelBatchRequests++
      if (metadata.scope === 'models:read' && typeof metadata.model === 'string') singleModelAuthorizations++
    }
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
beforeAll(async () => {
  process.env.NEXUS_CONNECTORS_ENABLED = 'true'
  await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const runner = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(runner)
  await runMigrations(db)
  await db.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('connector-org','connector-tenant','Connector','connector-org'),('other-org','other-tenant','Other','connector-other');
    INSERT INTO users(id,email,password_hash) VALUES('connector-owner','connector@example.invalid','fixture'),('connector-viewer','connector-viewer@example.invalid','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES('connector-org','connector-tenant','connector-owner','owner'),('connector-org','connector-tenant','connector-viewer','viewer');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('connector-project','connector-tenant','connector-org','Ollama'),('other-project','connector-tenant','connector-org','Other project'),('foreign-project','other-tenant','other-org','Foreign');`)
  for (const [id, token, tenant, org, project] of [
    ['connector-key', key, 'connector-tenant', 'connector-org', 'connector-project'],
    ['other-key', otherKey, 'connector-tenant', 'connector-org', 'other-project'],
    ['tenant-key', tenantKey, 'other-tenant', 'other-org', 'foreign-project'],
  ])
    await db.query(
      `INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes) VALUES($1,$2,$3,$4,$1,$5,'sk-nx','["models:read","chat:write"]')`,
      [id, tenant, org, project, tokenHash(token)],
    )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: 'connector-owner' })).token}`
  viewerCookie = `${SESSION_COOKIE}=${(await createSession({ userId: 'connector-viewer' })).token}`
  await mkdir(folder, { recursive: true })
  execFileSync('go', ['run', '../../tests/fixtures/connector-tls.go', folder], {
    cwd: 'services/gateway',
    windowsHide: true,
  })
  const cert = await readFile(path.join(folder, 'tls-cert.pem'))
  const tlsKey = await readFile(path.join(folder, 'tls-key.pem'))
  tlsAgent = new HTTPSAgent({ ca: cert })
  execFileSync('go', ['build', '-o', gatewayExe, '.'], { cwd: 'services/gateway', windowsHide: true })
  execFileSync('go', ['build', '-o', cliExe, './cmd/nexus-connector'], { cwd: 'services/gateway', windowsHide: true })
  control = createTLSServer({ cert, key: tlsKey }, (req, res) => {
    void relayRoute(req, res)
  })
  controlURL = (await listen(control)).replace('http:', 'https:')
  upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
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
    upstreamTokenLimits.push({ max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens })
    calls++
    expect(body.stream).toBe(true)
    expect(models).toContain(body.model)
    let finished = false
    res.on('close', () => {
      if (!finished) cancelled++
    })
    if (mode === 'timeout') return
    if (mode === 'error') {
      finished = true
      res.writeHead(429)
      res.end(JSON.stringify({ error: { message: 'SECRET-UPSTREAM-KEY private prompt marker 91fb' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.write(event({ role: 'assistant', content: 'Hello ' }))
    if (mode === 'cancel') return
    if (mode === 'truncated') {
      setTimeout(() => res.destroy(), 80)
      return
    }
    res.write(event({ content: 'Ollama' }))
    res.write(event({}, 'stop'))
    if (mode !== 'unknown')
      res.write(
        `data: ${JSON.stringify({ id: 'mock-1', model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\n`,
      )
    finished = true
    res.end('data: [DONE]\n\n')
  })
  upstreamURL = await listen(upstream)
}, 60000)
afterAll(async () => {
  await kill(connector)
  await kill(gateway)
  tlsAgent?.destroy()
  for (const server of [control, upstream]) {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  await writeFile(path.join(folder, 'process-summary.log'), `Gateway:\n${gatewayLogs}\nConnector:\n${cliLogs}`)
  await db.end()
})

it('creates an owned connection, blocks viewer pairing and forged heartbeat, stores only a one-use pairing hash', async () => {
  const created = await createConnection(
    admin('POST', { provider: 'ollama', mode: 'local_sidecar', projectId: 'connector-project' }),
  )
  expect(created.status).toBe(201)
  connectionId = (await created.json()).connection.id
  expect((await configure(admin('POST', { models }, viewerCookie), params())).status).toBe(403)
  expect((await heartbeat(admin('POST', { status: 'healthy' }), params())).status).toBe(403)
  const configured = await configure(admin('POST', { models: [...models, 'not-installed'] }), params())
  expect(configured.status).toBe(200)
  pairingToken = (await configured.json()).pairingToken
  const stored = (await db.query('SELECT token_hash FROM connector_pairings WHERE connection_id=$1', [connectionId]))
    .rows[0]
  expect(stored.token_hash).toBe(tokenHash(pairingToken))
  expect(JSON.stringify(stored)).not.toContain(pairingToken)
  expect((await pair(runtime('nxpair_' + 'a'.repeat(43)))).status).toBe(401)
  expect((await lease(admin('POST', { readyModels: models }))).status).toBe(401)
  const competing = await Promise.all([pair(runtime(pairingToken)), pair(runtime(pairingToken))])
  expect(competing.map((response) => response.status).sort()).toEqual([200, 401])
  const oldIdentity = await competing.find((response) => response.status === 200)!.json()
  const rotation = await configure(admin('POST', { models: [...models, 'not-installed'] }), params())
  pairingToken = (await rotation.json()).pairingToken
  expect((await lease(runtime(oldIdentity.credential, { readyModels: models }))).status).toBe(401)
})

it('authorizes bounded model batches with live ownership checks and no heartbeat side effects', async () => {
  const created = await createConnection(
    admin('POST', { provider: 'ollama', mode: 'local_sidecar', projectId: 'connector-project' }),
  )
  expect(created.status).toBe(201)
  const fixtureConnectionId = (await created.json()).connection.id
  const fixtureParams = { params: Promise.resolve({ id: fixtureConnectionId }) }
  try {
    const configured = await configure(admin('POST', { models: [...models, 'not-installed'] }), fixtureParams)
    expect(configured.status).toBe(200)
    const configuration = await configured.json()
    const paired = await pair(runtime(configuration.pairingToken))
    expect(paired.status).toBe(200)
    const identity = await paired.json()
    const leased = await lease(runtime(identity.credential, { readyModels: [models[0]] }))
    expect(leased.status).toBe(200)
    const grant = await leased.json()
    const channel = (await db.query('SELECT * FROM channels WHERE id=$1', [configuration.channelId])).rows[0]
    const batch = {
      leaseToken: grant.leaseToken,
      tenantId: 'connector-tenant',
      organizationId: 'connector-org',
      projectId: 'connector-project',
      keyId: 'connector-key',
      connectionId: fixtureConnectionId,
      channelId: configuration.channelId,
      scope: 'models:read',
      requestedModels: [...models, 'not-installed', 'unapproved-model'],
    }
    const check = (overrides: Record<string, unknown> = {}) =>
      authorize(runtime(process.env.GATEWAY_INTERNAL_TOKEN!, { ...batch, ...overrides }))
    const denied = async (name: string, overrides: Record<string, unknown> = {}) => {
      const response = await check(overrides)
      expect(response.status, name).toBe(403)
      const body = await response.text()
      expect(body).not.toContain(grant.leaseToken)
      expect(body).not.toContain(identity.credential)
    }
    await db.query(
      `UPDATE connector_leases SET transport_seen_at='2000-01-01',last_heartbeat_at='2000-01-02' WHERE id=$1`,
      [grant.leaseId],
    )
    const activity = async () =>
      (
        await db.query(
          `SELECT l.transport_seen_at,l.last_heartbeat_at,c.last_heartbeat_at connection_heartbeat
           FROM connector_leases l JOIN owned_connections c ON c.id=l.connection_id WHERE l.id=$1`,
          [grant.leaseId],
        )
      ).rows[0]
    const before = await activity()
    const partial = await check()
    expect(partial.status).toBe(200)
    expect(partial.headers.get('cache-control')).toBe('no-store')
    expect(await partial.json()).toMatchObject({
      leaseId: grant.leaseId,
      connectorId: identity.connectorId,
      tenantId: 'connector-tenant',
      connectionId: fixtureConnectionId,
      models: [models[0]],
    })
    expect((await (await check({ requestedModels: [models[0], models[0]] })).json()).models).toEqual([models[0]])
    expect(
      (await (await check({ requestedModels: [models[1], 'not-installed', 'unapproved-model'] })).json()).models,
    ).toEqual([])
    // A ready declaration cannot override a channel's approved model list.
    await db.query('UPDATE connector_leases SET ready_models=$1::jsonb WHERE id=$2', [
      JSON.stringify(models),
      grant.leaseId,
    ])
    await db.query(`UPDATE channels SET metadata=jsonb_set(metadata,'{models}',$1::jsonb) WHERE id=$2`, [
      JSON.stringify([models[0], 'not-installed']),
      configuration.channelId,
    ])
    expect((await (await check()).json()).models).toEqual([models[0]])
    await db.query('UPDATE channels SET metadata=$1::jsonb WHERE id=$2', [
      JSON.stringify(channel.metadata),
      configuration.channelId,
    ])
    await db.query('UPDATE connector_leases SET ready_models=$1::jsonb WHERE id=$2', [
      JSON.stringify([models[0]]),
      grant.leaseId,
    ])

    for (const [name, overrides] of [
      ['wrong tenant', { tenantId: 'other-tenant' }],
      ['wrong organization', { organizationId: 'other-org' }],
      ['wrong project', { projectId: 'other-project' }],
      ['other project key', { keyId: 'other-key' }],
      ['other tenant key', { keyId: 'tenant-key' }],
      ['wrong connection', { connectionId }],
      ['wrong channel', { channelId: 'missing-channel' }],
      ['mixed chat scope', { scope: 'chat:write' }],
      ['mixed single model', { model: models[0] }],
      ['mixed transport heartbeat', { transport: true }],
      ['empty batch', { requestedModels: [] }],
      ['non-array batch', { requestedModels: models[0] }],
      ['null batch', { requestedModels: null }],
      ['oversized batch', { requestedModels: Array.from({ length: 65 }, (_, i) => `model-${i}`) }],
      ['oversized duplicate batch', { requestedModels: Array.from({ length: 65 }, () => models[0]) }],
      ['invalid model ID', { requestedModels: [models[0], '../private model'] }],
    ] as const)
      await denied(name, overrides)
    for (const field of ['tenantId', 'organizationId', 'projectId', 'keyId', 'connectionId', 'channelId'])
      await denied(`missing ${field}`, { [field]: undefined })

    const blockedStates = [
      ['provider disabled', 'providers', channel.provider_id, 'enabled', false, true],
      ['credential disabled', 'provider_credentials', channel.provider_credential_id, 'enabled', false, true],
      [
        'credential belongs to another organization',
        'provider_credentials',
        channel.provider_credential_id,
        'organization_id',
        'other-org',
        'connector-org',
      ],
      ['channel disabled', 'channels', channel.id, 'enabled', false, true],
      ['key disabled', 'downstream_api_keys', 'connector-key', 'enabled', false, true],
      ['key revoked', 'downstream_api_keys', 'connector-key', 'revoked_at', new Date().toISOString(), null],
      ['key expired', 'downstream_api_keys', 'connector-key', 'expires_at', '2000-01-01', null],
      [
        'key lacks models scope',
        'downstream_api_keys',
        'connector-key',
        'scopes',
        '["chat:write"]',
        '["models:read","chat:write"]',
      ],
      [
        'malformed key scopes scalar',
        'downstream_api_keys',
        'connector-key',
        'scopes',
        '"models:read"',
        '["models:read","chat:write"]',
      ],
      [
        'malformed key scopes object',
        'downstream_api_keys',
        'connector-key',
        'scopes',
        '{"models:read":true}',
        '["models:read","chat:write"]',
      ],
      [
        'malformed key scopes wildcard',
        'downstream_api_keys',
        'connector-key',
        'scopes',
        '{"*":true}',
        '["models:read","chat:write"]',
      ],
      ['lease expired', 'connector_leases', grant.leaseId, 'expires_at', '2000-01-01', grant.expiresAt],
      ['lease revoked', 'connector_leases', grant.leaseId, 'revoked_at', new Date().toISOString(), null],
      ['identity revoked', 'connector_identities', identity.connectorId, 'revoked_at', new Date().toISOString(), null],
      ['connection revoked', 'owned_connections', fixtureConnectionId, 'revoked_at', new Date().toISOString(), null],
      ['project archived', 'projects', 'connector-project', 'archived_at', new Date().toISOString(), null],
      ['organization deleted', 'organizations', 'connector-org', 'deleted_at', new Date().toISOString(), null],
      [
        'malformed ready models',
        'connector_leases',
        grant.leaseId,
        'ready_models',
        JSON.stringify(models[0]),
        JSON.stringify([models[0]]),
      ],
      [
        'malformed channel models',
        'channels',
        channel.id,
        'metadata',
        JSON.stringify({ ...channel.metadata, models: {} }),
        JSON.stringify(channel.metadata),
      ],
    ] as const
    for (const [name, table, id, field, blocked, restored] of blockedStates) {
      // Identifiers come only from this fixed fixture matrix, never a request.
      await db.query(`UPDATE ${table} SET ${field}=$1 WHERE id=$2`, [blocked, id])
      try {
        await denied(name)
        if (field === 'scopes')
          await denied(`${name} single-model authorization`, { requestedModels: undefined, model: models[0] })
      } finally {
        await db.query(`UPDATE ${table} SET ${field}=$1 WHERE id=$2`, [restored, id])
      }
    }
    expect((await check()).status).toBe(200)
    expect(await activity()).toEqual(before)
  } finally {
    expect((await revoke(admin('DELETE'), fixtureParams)).status).toBe(200)
  }
})

it('pairs through the standalone CLI, starts a separate Gateway and lists only ready project-authorized models', async () => {
  const reservation = createServer()
  gatewayURL = (await listen(reservation)).replace('http:', 'https:')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const config = {
    controlUrl: controlURL,
    gatewayUrl: gatewayURL,
    upstreamUrl: upstreamURL + '/v1',
    models,
    caFile: path.join(folder, 'tls-cert.pem'),
    upstreamTimeoutSeconds: 3,
  }
  await writeFile(path.join(folder, 'connector.json'), JSON.stringify(config))
  const identityFile = path.join(folder, `identity-${Date.now()}.json`)
  const pairing = spawn(cliExe, ['pair', '--config', path.join(folder, 'connector.json'), '--identity', identityFile], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  pairing.stdout!.on('data', (b) => {
    cliLogs += b
  })
  pairing.stderr!.on('data', (b) => {
    cliLogs += b
  })
  pairing.stdin!.end(pairingToken + '\n')
  expect((await once(pairing, 'exit'))[0]).toBe(0)
  expect((await pair(runtime(pairingToken))).status).toBe(401)
  const identity = JSON.parse(await readFile(identityFile, 'utf8'))
  expect(
    (await db.query('SELECT credential_hash FROM connector_identities WHERE connection_id=$1', [connectionId])).rows[0]
      .credential_hash,
  ).toBe(tokenHash(identity.credential))
  gatewayEnv = {
    ...process.env,
    GATEWAY_ENV: 'test',
    CONTROL_PLANE_URL: controlURL,
    GATEWAY_ADDR: new URL(gatewayURL).host,
    GATEWAY_REPLICAS: '1',
    NEXUS_CONNECTORS_ENABLED: 'true',
    GATEWAY_OTEL_DISABLED: 'true',
    GATEWAY_ENABLE_RESPONSES: 'true',
    GATEWAY_SNAPSHOT_REFRESH_SECONDS: '1',
    GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS: '2',
    GATEWAY_TOTAL_TIMEOUT_SECONDS: '8',
    NEXUS_LOCAL_CREDENTIAL_DIR: '',
    REDIS_URL: '',
    GATEWAY_TLS_CERT: path.join(folder, 'tls-cert.pem'),
    GATEWAY_TLS_KEY: path.join(folder, 'tls-key.pem'),
    CONTROL_PLANE_CA_FILE: path.join(folder, 'tls-cert.pem'),
  }
  gateway = spawn(gatewayExe, [], { env: gatewayEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  gateway.stdout!.on('data', (b) => {
    gatewayLogs += b
  })
  gateway.stderr!.on('data', (b) => {
    gatewayLogs += b
  })
  await waitFor(async () => {
    try {
      return (await gatewayFetch('/healthz')).ok
    } catch {
      return false
    }
  })
  connector = spawn(cliExe, ['run', '--config', path.join(folder, 'connector.json'), '--identity', identityFile], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  connector.stdout!.on('data', (b) => {
    cliLogs += b
  })
  connector.stderr!.on('data', (b) => {
    cliLogs += b
  })
  await waitFor(async () => {
    const res = await gatewayFetch('/v1/models')
    return res.ok && (await res.json()).data.length === 2
  })
  const batchesBefore = modelBatchRequests
  const singlesBefore = singleModelAuthorizations
  expect((await (await gatewayFetch('/v1/models')).json()).data.map((m: { id: string }) => m.id).sort()).toEqual(
    [...models].sort(),
  )
  expect(modelBatchRequests - batchesBefore).toBe(1)
  expect(singleModelAuthorizations - singlesBefore).toBe(0)
  expect((await (await gatewayFetch('/v1/models', undefined, otherKey)).json()).data).toEqual([])
  expect((await (await gatewayFetch('/v1/models', undefined, tenantKey)).json()).data).toEqual([])
  const projected = (await (await resources(admin())).json()).resources.filter(
    (r: { connectionId: string }) => r.connectionId === connectionId,
  )
  expect(projected).toHaveLength(1)
  expect(projected[0].id).toMatch(/^channel:/)
}, 30000)

it('projects connector readiness from current channel, provider, credential and approved-model facts', async () => {
  const channel = (await db.query(`SELECT * FROM channels WHERE metadata->>'connection_id'=$1`, [connectionId])).rows[0]
  const reportedLease = (await db.query('SELECT * FROM connector_leases WHERE connection_id=$1', [connectionId]))
    .rows[0]
  const projection = async () =>
    (await (await resources(admin())).json()).resources.filter(
      (resource: { connectionId: string }) => resource.connectionId === connectionId,
    )
  const originalResources = await projection()
  expect(originalResources).toHaveLength(1)
  expect((await (await state(admin(), params())).json()).readyModels).toEqual(models)
  const beforeCalls = calls
  const otherProvider = 'connector-projection-other-provider'
  await db.query('INSERT INTO providers(id,code,name,official_base_url) VALUES($1,$1,$1,$2)', [
    otherProvider,
    'https://unused.example.invalid/v1',
  ])
  const mutations: {
    name: string
    table: string
    id: string
    field: string
    blocked: unknown
    restored: unknown
    expected: string[]
    resourceStatus?: string
    hiddenChannel?: boolean
  }[] = [
    {
      name: 'provider disabled',
      table: 'providers',
      id: channel.provider_id,
      field: 'enabled',
      blocked: false,
      restored: true,
      expected: [],
      resourceStatus: 'pending',
    },
    {
      name: 'credential disabled',
      table: 'provider_credentials',
      id: channel.provider_credential_id,
      field: 'enabled',
      blocked: false,
      restored: true,
      expected: [],
      resourceStatus: 'disabled',
    },
    {
      name: 'channel disabled',
      table: 'channels',
      id: channel.id,
      field: 'enabled',
      blocked: false,
      restored: true,
      expected: [],
      resourceStatus: 'disabled',
    },
    {
      name: 'credential provider mismatch',
      table: 'provider_credentials',
      id: channel.provider_credential_id,
      field: 'provider_id',
      blocked: otherProvider,
      restored: channel.provider_id,
      expected: [],
      resourceStatus: 'pending',
    },
    {
      name: 'credential organization mismatch',
      table: 'provider_credentials',
      id: channel.provider_credential_id,
      field: 'organization_id',
      blocked: 'other-org',
      restored: 'connector-org',
      expected: [],
      hiddenChannel: true,
    },
    ...(
      [
        ['only one approved model', { ...channel.metadata, models: [models[0]] }, [models[0]]],
        ['approved models have no ready intersection', { ...channel.metadata, models: ['not-installed'] }, []],
        ['empty approved models', { ...channel.metadata, models: [] }, []],
        ['malformed approved models', { ...channel.metadata, models: { [models[0]]: true } }, []],
        ['partially malformed approved models', { ...channel.metadata, models: [models[0], 42] }, []],
        ['wrong transport', { ...channel.metadata, transport: 'direct_api' }, []],
      ] satisfies [string, Record<string, unknown>, string[]][]
    ).map(([name, metadata, expected]) => ({
      name,
      table: 'channels',
      id: channel.id,
      field: 'metadata',
      blocked: JSON.stringify(metadata),
      restored: JSON.stringify(channel.metadata),
      expected,
      resourceStatus: expected.length ? 'active' : 'pending',
    })),
    {
      name: 'malformed reported models',
      table: 'connector_leases',
      id: reportedLease.id,
      field: 'ready_models',
      blocked: JSON.stringify([models[0], 42]),
      restored: JSON.stringify(models),
      expected: [],
      resourceStatus: 'pending',
    },
  ]
  try {
    for (const mutation of mutations) {
      // SQL identifiers are fixed fixture values. Every fact is restored before
      // the next case so the running connector keeps its original identity.
      await db.query(`UPDATE ${mutation.table} SET ${mutation.field}=$1 WHERE id=$2`, [mutation.blocked, mutation.id])
      try {
        const displayed = await (await state(admin(), params())).json()
        expect.soft(displayed.state, mutation.name).toBe('online')
        expect.soft(displayed.readyModels, mutation.name).toEqual(mutation.expected)
        const projected = await projection()
        if (mutation.hiddenChannel) {
          // The foreign-organization channel is hidden while this workspace's
          // original connection remains a visible, unconfigured resource.
          expect.soft(projected, mutation.name).toHaveLength(1)
          expect.soft(projected[0]?.id, mutation.name).toBe(`connection:${connectionId}`)
          expect.soft(projected[0]?.channelId, mutation.name).toBeNull()
          expect.soft(projected[0]?.status, mutation.name).toBe('pending')
          expect.soft(projected[0]?.health, mutation.name).toBe('unknown')
        } else {
          expect.soft(projected, mutation.name).toHaveLength(1)
          expect.soft(projected[0]?.id, mutation.name).toBe(originalResources[0].id)
          expect.soft(projected[0]?.status, mutation.name).toBe(mutation.resourceStatus)
          expect.soft(projected[0]?.health, mutation.name).toBe(mutation.expected.length ? 'healthy' : 'unknown')
        }
        const listed = await gatewayFetch('/v1/models')
        expect(listed.status, mutation.name).toBe(200)
        expect(
          (await listed.json()).data.map((model: { id: string }) => model.id),
          mutation.name,
        ).toEqual(mutation.expected)
        expect(calls, mutation.name).toBe(beforeCalls)
      } finally {
        await db.query(`UPDATE ${mutation.table} SET ${mutation.field}=$1 WHERE id=$2`, [
          mutation.restored,
          mutation.id,
        ])
      }
      expect((await (await state(admin(), params())).json()).readyModels).toEqual(models)
    }
  } finally {
    await db.query('DELETE FROM providers WHERE id=$1', [otherProvider])
  }
  // Management readiness describes the connection, not the authorization of
  // whichever downstream key a caller might choose for a later inference.
  await db.query(`UPDATE downstream_api_keys SET enabled=false WHERE id='connector-key'`)
  try {
    expect((await (await state(admin(), params())).json()).readyModels).toEqual(models)
  } finally {
    await db.query(`UPDATE downstream_api_keys SET enabled=true WHERE id='connector-key'`)
  }
  await waitFor(async () => (await (await gatewayFetch('/v1/models')).json()).data?.length === 2)
  expect(calls).toBe(beforeCalls)
})

it('unions eligible models for a connection while projecting each channel resource independently', async () => {
  const channel = (await db.query(`SELECT * FROM channels WHERE metadata->>'connection_id'=$1`, [connectionId])).rows[0]
  const secondID = 'connector-projection-second-channel'
  const projection = async () =>
    (await (await resources(admin())).json()).resources.filter(
      (resource: { connectionId: string }) => resource.connectionId === connectionId,
    )
  const beforeCalls = calls
  await db.query(
    `INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name,capabilities,metadata)
     SELECT $1,tenant_id,provider_id,provider_credential_id,'Second connector model',capabilities,$2::jsonb FROM channels WHERE id=$3`,
    [secondID, JSON.stringify({ ...channel.metadata, models: ['not-installed'] }), channel.id],
  )
  try {
    const ids = [`channel:${channel.id}`, `channel:${secondID}`].sort()
    const check = async (ready: string[], primaryStatus: string, secondaryStatus: string) => {
      const displayed = await (await state(admin(), params())).json()
      expect.soft(displayed.state).toBe('online')
      expect.soft(displayed.readyModels).toEqual(ready)
      const projected = await projection()
      expect.soft(projected.map((resource: { id: string }) => resource.id).sort()).toEqual(ids)
      for (const [id, status] of [
        [channel.id, primaryStatus],
        [secondID, secondaryStatus],
      ]) {
        const resource = projected.find((row: { channelId: string }) => row.channelId === id)
        expect.soft(resource?.status, id).toBe(status)
        expect.soft(resource?.health, id).toBe(status === 'active' ? 'healthy' : 'unknown')
      }
    }
    await check(models, 'active', 'pending')
    await db.query(`UPDATE channels SET metadata=jsonb_set(metadata,'{models}',$1::jsonb) WHERE id=$2`, [
      JSON.stringify([models[0]]),
      channel.id,
    ])
    await db.query(`UPDATE channels SET metadata=jsonb_set(metadata,'{models}',$1::jsonb) WHERE id=$2`, [
      JSON.stringify([models[1], models[1]]),
      secondID,
    ])
    await check(models, 'active', 'active')
    await db.query('UPDATE channels SET enabled=false WHERE id=$1', [channel.id])
    await check([models[1]], 'disabled', 'active')
    await db.query('UPDATE channels SET enabled=false WHERE id=$1', [secondID])
    await check([], 'disabled', 'disabled')
  } finally {
    await db.query('UPDATE channels SET enabled=true,metadata=$1::jsonb WHERE id=$2', [
      JSON.stringify(channel.metadata),
      channel.id,
    ])
    await db.query('DELETE FROM channels WHERE id=$1', [secondID])
  }
  expect((await (await state(admin(), params())).json()).readyModels).toEqual(models)
  expect(await projection()).toHaveLength(1)
  expect(calls).toBe(beforeCalls)
})

it('relays nonstreaming and streaming chat through the local process with durable project attribution and unpriced usage', async () => {
  const response = await gatewayFetch('/v1/chat/completions', chat())
  const data = await response.json()
  expect(response.status, JSON.stringify(data) + gatewayLogs).toBe(200)
  expect(data.choices[0].message.content).toBe('Hello Ollama')
  const streaming = await gatewayFetch('/v1/chat/completions', chat(true, models[1]))
  expect(streaming.status).toBe(200)
  const text = await streaming.text()
  expect(text).toContain('Ollama')
  expect(text).toContain('[DONE]')
  await waitFor(async () => (await db.query(`SELECT id FROM request_records WHERE status='completed'`)).rowCount === 2)
  const records = (
    await db.query(
      `SELECT f.project_id,f.api_key_id,a.connection_id,a.price_version_id,a.execution_mode FROM request_project_facts f JOIN attempts a ON a.request_id=f.request_id`,
    )
  ).rows
  expect(records).toHaveLength(2)
  for (const r of records)
    expect(r).toMatchObject({
      project_id: 'connector-project',
      api_key_id: 'connector-key',
      connection_id: connectionId,
      price_version_id: null,
      execution_mode: 'byok',
    })
  const events = (await db.query(`SELECT * FROM outbox_events WHERE aggregate_type='usage'`)).rows
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const event of events) await processOutboxEvent(client, event)
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  expect((await db.query('SELECT id FROM usage_events')).rowCount).toBe(2)
  expect((await db.query("SELECT id FROM reconciliation_cases WHERE reason='missing_price_version'")).rowCount).toBe(2)
  expect((await db.query('SELECT id FROM usage_records')).rowCount).toBe(0)
  expect((await db.query(`SELECT id FROM ledger_transactions WHERE type='usage'`)).rowCount).toBe(0)
  expect(JSON.stringify(events)).not.toContain('private prompt marker')
})

it('keeps modern Chat and Responses output limits effective at the local Ollama process', async () => {
  const before = upstreamTokenLimits.length
  const requestIds: string[] = []
  let limit = 17
  for (const endpoint of ['/v1/chat/completions', '/v1/responses']) {
    for (const stream of [false, true]) {
      const body =
        endpoint === '/v1/responses'
          ? { model: models[0], input: 'limit fixture', stream, max_output_tokens: limit }
          : {
              model: models[0],
              messages: [{ role: 'user', content: 'limit fixture' }],
              stream,
              max_completion_tokens: limit,
            }
      const response = await gatewayFetch(endpoint, body)
      const result = await response.text()
      expect(response.status, result).toBe(200)
      expect(result).toContain('Ollama')
      if (stream) expect(result).toContain(endpoint === '/v1/responses' ? 'response.completed' : '[DONE]')
      expect(upstreamTokenLimits.at(-1)).toEqual({ max_tokens: limit, max_completion_tokens: undefined })
      expect(response.headers.get('x-request-id')).toBeTruthy()
      requestIds.push(response.headers.get('x-request-id')!)
      limit++
    }
  }
  expect(upstreamTokenLimits.length - before).toBe(4)
  await waitFor(
    async () =>
      (await db.query(`SELECT id FROM request_records WHERE id=ANY($1::text[]) AND status='completed'`, [requestIds]))
        .rowCount === 4,
  )
  const records = (
    await db.query(
      `SELECT f.project_id,f.api_key_id,a.connection_id,a.price_version_id,a.execution_mode FROM request_project_facts f JOIN attempts a ON a.request_id=f.request_id WHERE f.request_id=ANY($1::text[])`,
      [requestIds],
    )
  ).rows
  expect(records).toHaveLength(4)
  for (const record of records)
    expect(record).toMatchObject({
      project_id: 'connector-project',
      api_key_id: 'connector-key',
      connection_id: connectionId,
      price_version_id: null,
      execution_mode: 'byok',
    })
})

it('rejects cross-project, cross-tenant and unconfigured models without reaching Ollama', async () => {
  const before = calls
  for (const token of [otherKey, tenantKey])
    expect((await gatewayFetch('/v1/chat/completions', chat(), token)).status).toBeGreaterThanOrEqual(400)
  expect((await gatewayFetch('/v1/chat/completions', chat(false, 'unconfigured'))).status).toBe(400)
  expect((await gatewayFetch('/v1/chat/completions', chat(false, 'not-installed'))).status).toBe(503)
  expect(calls).toBe(before)
})

it('fails live authorization immediately after key, project, lease or channel revocation despite cached snapshots', async () => {
  const checks = [
    [
      `UPDATE downstream_api_keys SET enabled=false WHERE id='connector-key'`,
      `UPDATE downstream_api_keys SET enabled=true WHERE id='connector-key'`,
    ],
    [
      `UPDATE owned_connections SET project_id=NULL WHERE id='${connectionId}'`,
      `UPDATE owned_connections SET project_id='connector-project' WHERE id='${connectionId}'`,
    ],
    [
      `UPDATE connector_leases SET expires_at=now()-interval '1 second'`,
      `UPDATE connector_leases SET expires_at=now()+interval '90 seconds'`,
    ],
    [`UPDATE channels SET enabled=false`, `UPDATE channels SET enabled=true`],
  ]
  for (const [off, on] of checks) {
    const before = calls
    await db.query(off)
    try {
      const listed = await gatewayFetch('/v1/models')
      if (listed.status === 200) expect((await listed.json()).data).toEqual([])
      else expect(listed.status).toBeGreaterThanOrEqual(400)
      expect((await gatewayFetch('/v1/chat/completions', chat())).status).toBeGreaterThanOrEqual(400)
      expect(calls).toBe(before)
    } finally {
      await db.query(on)
    }
  }
  await waitFor(async () => (await (await gatewayFetch('/v1/models')).json()).data?.length === 2)
}, 20000)

it('records absent usage as unknown and never invents a price', async () => {
  mode = 'unknown'
  const response = await gatewayFetch('/v1/chat/completions', chat())
  expect(response.status).toBe(200)
  await response.text()
  mode = 'normal'
  await waitFor(
    async () =>
      (await db.query('SELECT id FROM outbox_events WHERE aggregate_id=$1', [response.headers.get('x-request-id')]))
        .rowCount! > 0,
  )
  const event = (
    await db.query('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [response.headers.get('x-request-id')])
  ).rows[0].payload
  expect(event.price_version_id).toBeNull()
  expect(event.usage.input_tokens).toBeNull()
  expect(event.usage.output_tokens).toBeNull()
})

it('propagates cancellation, timeout and midstream failure without replay or leaking upstream errors', async () => {
  mode = 'cancel'
  const abort = new AbortController()
  const before = cancelled
  const response = await gatewayFetch('/v1/chat/completions', chat(true), key, abort.signal)
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await reader.cancel().catch(() => {})
  await waitFor(async () => cancelled > before)
  mode = 'truncated'
  const started = calls
  const broken = await gatewayFetch('/v1/chat/completions', chat(true))
  const text = await broken.text()
  expect(text).toContain('error')
  expect(calls).toBe(started + 1)
  mode = 'timeout'
  const timeout = await gatewayFetch('/v1/chat/completions', chat())
  expect(timeout.status).toBe(504)
  const timeoutId = timeout.headers.get('x-request-id')
  await waitFor(
    async () => (await db.query('SELECT id FROM outbox_events WHERE aggregate_id=$1', [timeoutId])).rowCount! > 0,
  )
  const timedOut = (await db.query('SELECT payload FROM outbox_events WHERE aggregate_id=$1', [timeoutId])).rows[0]
    .payload
  expect(timedOut.status).toBe('unknown')
  expect(timedOut.usage.input_tokens).toBeNull()
  mode = 'error'
  const rejected = await gatewayFetch('/v1/chat/completions', chat())
  const errorBody = await rejected.text()
  expect(rejected.status).toBeGreaterThanOrEqual(400)
  expect(errorBody).not.toContain('SECRET-UPSTREAM-KEY')
  expect(errorBody).not.toContain('private prompt')
  mode = 'normal'
}, 30000)

it('rejects a second Gateway instance, disconnected connectors, identity rotation and connection revocation', async () => {
  const second = spawn(gatewayExe, [], {
    env: { ...gatewayEnv, GATEWAY_ADDR: '127.0.0.1:0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  second.stderr!.on('data', (b) => {
    output += b
  })
  expect((await once(second, 'exit'))[0]).toBe(1)
  expect(output).toContain('exactly one Gateway')
  await kill(connector)
  await new Promise((r) => setTimeout(r, 3200))
  expect((await (await gatewayFetch('/v1/models')).json()).data).toEqual([])
  expect((await gatewayFetch('/v1/chat/completions', chat())).status).toBeGreaterThanOrEqual(400)
  const old = (await db.query('SELECT * FROM connector_leases WHERE connection_id=$1', [connectionId])).rows[0]
  expect((await configure(admin('POST', { models }), params())).status).toBe(200)
  expect(
    (await db.query('SELECT revoked_at FROM connector_leases WHERE id=$1', [old.id])).rows[0].revoked_at,
  ).not.toBeNull()
  expect((await revoke(admin('DELETE'), params())).status).toBe(200)
  expect((await (await state(admin(), params())).json()).state).toBe('revoked')
  expect(JSON.stringify(await (await listConnections(admin())).json())).not.toContain(pairingToken)
  expect(gatewayLogs + cliLogs).not.toContain(pairingToken)
  expect(gatewayLogs + cliLogs).not.toContain('private prompt marker')
})
