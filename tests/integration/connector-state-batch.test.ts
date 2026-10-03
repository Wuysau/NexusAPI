import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { GET as connections } from '@/app/api/connections/route'
import { GET as resources } from '@/app/api/resources/route'
import { GET as state } from '@/app/api/connections/[id]/connector/route'
import type { ExecutionResourceView } from '@/lib/resources/catalog'

// Setup resets only the named disposable database or the verified serial CI fixture.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Explicit independent DATABASE_URL required')
let target: URL
try {
  target = new URL(databaseUrl)
} catch {
  throw new Error('Invalid independent DATABASE_URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/connector_test_projection_batch_round60', '/convergence_ci15'].includes(target.pathname) ||
  databaseUrl.includes('?') ||
  databaseUrl.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback connector projection database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'projection-tenant'
const organization = 'projection-org'
const project = 'projection-project'
const provider = 'projection-provider'
const roles = ['admin', 'viewer'] as const
type Role = (typeof roles)[number]
let cookies: Record<Role, string>
const observations: Record<string, unknown>[] = []
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'projects',
  'project_memberships',
  'owned_connections',
  'providers',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'quota_snapshots',
  'external_observed_usage',
  'audit_events',
  'request_records',
  'attempts',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
] as const
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
interface ConnectorState {
  connectionId: string
  models: string[]
  readyModels: string[]
  state: string
  leaseExpiresAt: string | null
  lastHeartbeatAt: string | null
  transportSeenAt: string | null
}
interface ConnectionView {
  id: string
  mode: string
  connector?: ConnectorState
}
interface FixtureConnector {
  connectionId: string
  channelId: string
  credentialId: string
  identityId: string
  leaseId: string
  model: string
  projectId: string
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const request = (role: Role, pathname: string) =>
  new Request(`http://localhost${pathname}`, { headers: { cookie: cookies[role] } })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(target.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  // One organization per tenant, as required by the canonical unique index.
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES
      ($1,$2,'Projection fixture','projection-org'),
      ('projection-foreign-org','projection-foreign-tenant','Other tenant','projection-foreign-org')`,
    [organization, tenant],
  )
  cookies = {} as Record<Role, string>
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      `projection-${role}`,
      `${role}@projection.example.invalid`,
      'synthetic-unused-password-hash',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [organization, tenant, `projection-${role}`, role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: `projection-${role}` })).token}`
  }
  await pool.query(
    `INSERT INTO projects(id,tenant_id,organization_id,name) VALUES
      ($1,$2,$3,'Visible project'),
      ('projection-private-project',$2,$3,'Private project'),
      ('projection-archived-project',$2,$3,'Archived project'),
      ('projection-foreign-project','projection-foreign-tenant','projection-foreign-org','Other tenant project')`,
    [project, tenant, organization],
  )
  await pool.query(
    `INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES
      ($1,$2,'projection-viewer'),($1,'projection-archived-project','projection-viewer')`,
    [tenant, project],
  )
  await pool.query("UPDATE projects SET status='archived',archived_at=now() WHERE id='projection-archived-project'")
  await pool.query(
    `INSERT INTO providers(id,code,name,official_base_url)
     VALUES($1,'ollama','Ollama projection fixture','https://connector.invalid/v1')`,
    [provider],
  )
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_CONNECTOR_STATE_BATCH_AUDIT_REPORT === '1')
    console.info('Connector projection safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Projection fixture pool close timeout')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
})

async function seed(
  name: string,
  options: { projectId?: string; foreign?: boolean; registered?: boolean; ordinal?: number } = {},
): Promise<FixtureConnector> {
  const scope = options.foreign ? 'projection-foreign-tenant' : tenant
  const org = options.foreign ? 'projection-foreign-org' : organization
  const item = {
    connectionId: `projection-connection-${name}`,
    channelId: `projection-channel-${name}`,
    credentialId: `projection-credential-${name}`,
    identityId: `projection-identity-${name}`,
    leaseId: `projection-lease-${name}`,
    model: `model-${name}`,
    projectId: options.projectId ?? (options.foreign ? 'projection-foreign-project' : project),
  }
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,status,capabilities,created_at)
     VALUES($1,$2,$3,'ollama','local_sidecar','active',$4::jsonb,timestamptz '2026-01-01T00:00:00Z'-$5::integer*interval '1 second')`,
    [item.connectionId, scope, item.projectId, JSON.stringify({ models: [item.model] }), options.ordinal ?? 0],
  )
  await pool.query(
    `INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret)
     VALUES($1,$2,$3,$4,'Projection accounting identity','{"format":"connector-local-only-v1"}')`,
    [item.credentialId, provider, org, scope],
  )
  await pool.query(
    `INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name,capabilities,metadata)
     VALUES($1,$2,$3,$4,$5,'["chat"]'::jsonb,$6::jsonb)`,
    [
      item.channelId,
      scope,
      provider,
      item.credentialId,
      `Projection ${name}`,
      JSON.stringify({
        connection_id: item.connectionId,
        transport: 'local_sidecar',
        models: [item.model],
      }),
    ],
  )
  if (!options.registered) {
    await pool.query(
      'INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash) VALUES($1,$2,$3,$4)',
      [item.identityId, item.connectionId, scope, `synthetic-identity-hash-${name}`],
    )
    await pool.query(
      `INSERT INTO connector_leases(id,tenant_id,connection_id,lease_token_hash,connector_id,ready_models,expires_at,last_heartbeat_at,transport_seen_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,now()+interval '1 hour',now(),now())`,
      [
        item.leaseId,
        scope,
        item.connectionId,
        `synthetic-lease-hash-${name}`,
        item.identityId,
        JSON.stringify(['ready-only', item.model]),
      ],
    )
  }
  return item
}
async function seedMany(count: number) {
  const result: FixtureConnector[] = []
  for (let i = 0; i < count; i++) result.push(await seed(String(i).padStart(3, '0'), { ordinal: i }))
  return result
}
async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'connector_pairings' ? 'connection_id' : 'id'}`)
    ).rows
  return result
}
async function measured<T>(handler: () => Promise<Response>) {
  // Count only, while preserving every real query overload and receiver.
  // No query result, auth or state is stubbed; no SQL/parameter history is retained.
  const originalQuery = pool.query
  let queryCount = 0
  pool.query = function (this: typeof pool, ...args: unknown[]) {
    queryCount++
    return Reflect.apply(originalQuery, this, args)
  } as typeof pool.query
  try {
    const response = await handler()
    expect(response.status).toBe(200)
    return { body: (await response.json()) as T, queryCount }
  } finally {
    pool.query = originalQuery
  }
}
async function single(item: FixtureConnector, role: Role = 'viewer'): Promise<ConnectorState> {
  const response = await state(
    request(role, `/api/connections/${item.connectionId}/connector`),
    params(item.connectionId),
  )
  expect(response.status).toBe(200)
  return response.json()
}
async function assertConnections(rows: ConnectionView[], items: FixtureConnector[], role: Role = 'viewer') {
  same(
    rows.map((row) => row.id),
    items.map((item) => item.connectionId),
    'Connection response preserves canonical identities and input order',
  )
  for (const item of items) {
    const row = rows.find((entry) => entry.id === item.connectionId)!
    expect(row.mode).toBe('local_sidecar')
    same(row.connector, await single(item, role), 'List state exactly matches actual single-connector GET')
  }
}
function assertResourceIdentity(resource: ExecutionResourceView, item: FixtureConnector, channelId = item.channelId) {
  same(
    [resource.id, resource.connectionId, resource.channelId, resource.projectId, resource.accountId, resource.provider],
    [`channel:${channelId}`, item.connectionId, channelId, item.projectId, item.credentialId, 'ollama'],
    'Resource preserves canonical channel, connection, project and accounting identities',
  )
}
async function assertResources(rows: ExecutionResourceView[], items: FixtureConnector[], role: Role = 'viewer') {
  same(
    rows.map((row) => row.id),
    items.map((item) => `channel:${item.channelId}`),
    'Resource identities and catalog order remain unchanged',
  )
  for (const item of items) {
    const resource = rows.find((row) => row.channelId === item.channelId)!
    const scalar = await single(item, role)
    assertResourceIdentity(resource, item)
    same(scalar.readyModels, [item.model], 'Only approved installed models are ready')
    same(resource.supportedModels, [item.model], 'Catalog retains the configured model declaration')
    same(resource.capabilities, ['chat'], 'Catalog retains saved capability facts')
    expect(resource.status).toBe('active')
    expect(resource.health).toBe('healthy')
  }
}
async function unchanged(before: Facts, name: string, extra: Record<string, unknown>) {
  const unchanged = isDeepStrictEqual(await facts(), before)
  observations.push({ name, ...extra, factsUnchanged: unchanged })
  expect(unchanged, 'Read-only projection preserves all domain, session, audit and accounting facts').toBe(true)
}

it('projects 32 actual connection states with one batch instead of 32 state queries', async () => {
  const items = await seedMany(32)
  const before = await facts()
  const result = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  await assertConnections(result.body.connections, items)
  for (const row of result.body.connections) {
    expect(row.connector?.state).toBe('online')
    same(
      row.connector?.readyModels,
      [items.find((item) => item.connectionId === row.id)!.model],
      'Union readiness preserves each connector’s own model',
    )
  }
  await unchanged(before, 'connections_32', {
    queryCount: result.queryCount,
    expectedQueryCount: 4,
    rows: result.body.connections.length,
    scalarGETs: 32,
  })
  expect(result.queryCount).toBe(4)
}, 15000)
it('projects 32 actual channel resources with one batch and unchanged canonical facts', async () => {
  const items = await seedMany(32)
  const before = await facts()
  const result = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  await assertResources(result.body.resources, items)
  await unchanged(before, 'resources_32', {
    queryCount: result.queryCount,
    expectedQueryCount: 6,
    rows: result.body.resources.length,
    scalarGETs: 32,
  })
  expect(result.queryCount).toBe(6)
}, 15000)
it('keeps 65 ordered projections complete across three bounded batches', async () => {
  const items = await seedMany(65)
  const before = await facts()
  const listed = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  const catalog = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  await assertConnections(listed.body.connections, items)
  await assertResources(catalog.body.resources, items)
  await unchanged(before, 'chunks_65', {
    connectionQueries: listed.queryCount,
    resourceQueries: catalog.queryCount,
    expectedConnectionQueries: 6,
    expectedResourceQueries: 8,
    connectionRows: listed.body.connections.length,
    resourceRows: catalog.body.resources.length,
    scalarGETs: 130,
  })
  expect(listed.queryCount).toBe(6)
  expect(catalog.queryCount).toBe(8)
}, 20000)
it('keeps union readiness separate from each channel approval for the same connection', async () => {
  const item = await seed('shared')
  const otherChannel = 'projection-channel-other'
  const otherModel = 'model-other'
  await pool.query('UPDATE owned_connections SET capabilities=$2::jsonb WHERE id=$1', [
    item.connectionId,
    JSON.stringify({ models: [item.model, otherModel] }),
  ])
  await pool.query(
    `INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name,capabilities,metadata)
     VALUES($1,$2,$3,$4,'Projection second approval','["text"]'::jsonb,$5::jsonb)`,
    [
      otherChannel,
      tenant,
      provider,
      item.credentialId,
      JSON.stringify({ connection_id: item.connectionId, transport: 'local_sidecar', models: [otherModel] }),
    ],
  )
  const before = await facts()
  const listed = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  await assertConnections(listed.body.connections, [item])
  same(
    listed.body.connections[0].connector?.models,
    [item.model, otherModel],
    'Union projection retains configured models',
  )
  same(
    listed.body.connections[0].connector?.readyModels,
    [item.model],
    'Uninstalled approved models do not become ready',
  )
  const catalog = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  expect(catalog.body.resources.length).toBe(2)
  const installed = catalog.body.resources.find((row) => row.channelId === item.channelId)!
  const uninstalled = catalog.body.resources.find((row) => row.channelId === otherChannel)!
  assertResourceIdentity(installed, item)
  assertResourceIdentity(uninstalled, item, otherChannel)
  expect(installed.status).toBe('active')
  expect(installed.health).toBe('healthy')
  expect(uninstalled.status).toBe('pending')
  expect(uninstalled.health).toBe('unknown')
  same(uninstalled.supportedModels, [otherModel], 'A pending channel retains its saved approval declaration')
  same(uninstalled.capabilities, ['text'], 'Legacy text capability remains visible unchanged')
  await unchanged(before, 'channel_scopes', {
    connections: 1,
    resources: 2,
    installedActive: true,
    uninstalledPending: true,
  })
})
it('skips state queries for an empty catalog and for non-local connections', async () => {
  const emptyBefore = await facts()
  const emptyConnections = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  const emptyResources = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  expect(emptyConnections.queryCount).toBe(3)
  expect(emptyResources.queryCount).toBe(4)
  expect(emptyConnections.body.connections.length).toBe(0)
  expect(emptyResources.body.resources.length).toBe(0)
  await unchanged(emptyBefore, 'empty_catalog', {
    connectionQueries: emptyConnections.queryCount,
    resourceQueries: emptyResources.queryCount,
  })
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,status)
     VALUES('projection-nonlocal',$1,$2,'fixture','external_endpoint','active')`,
    [tenant, project],
  )
  const before = await facts()
  const listed = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  const catalog = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  expect(listed.queryCount).toBe(3)
  expect(catalog.queryCount).toBe(5)
  expect(listed.body.connections[0].id).toBe('projection-nonlocal')
  expect(listed.body.connections[0].connector).toBeUndefined()
  same(
    [catalog.body.resources[0].id, catalog.body.resources[0].connectionId],
    ['connection:projection-nonlocal', 'projection-nonlocal'],
    'Non-local canonical resource identity is preserved',
  )
  await unchanged(before, 'nonlocal_catalog', {
    connectionQueries: listed.queryCount,
    resourceQueries: catalog.queryCount,
  })
})
it('preserves real visibility and registered, expired, offline, revoked, disabled and empty readiness states', async () => {
  const items = [] as FixtureConnector[]
  for (const name of [
    'online',
    'registered',
    'expired',
    'offline',
    'revoked',
    'disabled',
    'empty',
    'identity-revoked',
    'archived',
    'malformed',
  ])
    items.push(
      await seed(name, {
        registered: name === 'registered',
        projectId: name === 'archived' ? 'projection-archived-project' : project,
        ordinal: items.length,
      }),
    )
  const item = (name: string) => items.find((value) => value.connectionId === `projection-connection-${name}`)!
  await pool.query("UPDATE connector_leases SET expires_at=now()-interval '1 hour' WHERE id=$1", [
    item('expired').leaseId,
  ])
  await pool.query("UPDATE connector_leases SET transport_seen_at=now()-interval '1 hour' WHERE id=$1", [
    item('offline').leaseId,
  ])
  await pool.query("UPDATE owned_connections SET status='revoked',revoked_at=now() WHERE id=$1", [
    item('revoked').connectionId,
  ])
  await pool.query('UPDATE provider_credentials SET enabled=false WHERE id=$1', [item('disabled').credentialId])
  await pool.query("UPDATE connector_leases SET ready_models='[]'::jsonb WHERE id=$1", [item('empty').leaseId])
  await pool.query('UPDATE connector_identities SET revoked_at=now() WHERE id=$1', [
    item('identity-revoked').identityId,
  ])
  await pool.query('UPDATE connector_leases SET ready_models=$2::jsonb WHERE id=$1', [
    item('malformed').leaseId,
    JSON.stringify({ model: true }),
  ])
  const privateItem = await seed('private', { projectId: 'projection-private-project', ordinal: 30 })
  const foreignItem = await seed('foreign', { foreign: true, ordinal: 31 })
  const before = await facts()
  const listed = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('viewer', '/api/connections')),
  )
  const catalog = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('viewer', '/api/resources')),
  )
  await assertConnections(listed.body.connections, items)
  expect(catalog.body.resources.length).toBe(items.length)
  for (const hidden of [privateItem, foreignItem]) {
    expect(listed.body.connections.some((row) => row.id === hidden.connectionId)).toBe(false)
    expect(catalog.body.resources.some((row) => row.connectionId === hidden.connectionId)).toBe(false)
    const response = await state(
      request('viewer', `/api/connections/${hidden.connectionId}/connector`),
      params(hidden.connectionId),
    )
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('not_found')
  }
  const adminConnections = await measured<{ connections: ConnectionView[] }>(() =>
    connections(request('admin', '/api/connections')),
  )
  const adminResources = await measured<{ resources: ExecutionResourceView[] }>(() =>
    resources(request('admin', '/api/resources')),
  )
  const adminPrivate = adminConnections.body.connections.find((row) => row.id === privateItem.connectionId)
  expect(adminPrivate !== undefined).toBe(true)
  same(
    adminPrivate!.connector,
    await single(privateItem, 'admin'),
    'Privileged access preserves the same actual private-connection state',
  )
  expect(adminResources.body.resources.some((row) => row.connectionId === privateItem.connectionId)).toBe(true)
  expect(adminConnections.body.connections.some((row) => row.id === foreignItem.connectionId)).toBe(false)
  expect(adminResources.body.resources.some((row) => row.connectionId === foreignItem.connectionId)).toBe(false)
  const expectedStates = [
    'online',
    'registered',
    'expired',
    'offline',
    'revoked',
    'online',
    'online',
    'expired',
    'online',
    'online',
  ]
  for (const [index, fixture] of items.entries()) {
    const projected = listed.body.connections.find((row) => row.id === fixture.connectionId)!.connector!
    const resource = catalog.body.resources.find((row) => row.channelId === fixture.channelId)!
    assertResourceIdentity(resource, fixture)
    expect(projected.state).toBe(expectedStates[index])
    same(
      projected.readyModels,
      index === 0 ? [fixture.model] : [],
      'Unavailable or invalid readiness grants no callable model',
    )
    expect(resource.status).toBe(index === 0 ? 'active' : [4, 5].includes(index) ? 'disabled' : 'pending')
    expect(resource.health).toBe(index === 0 ? 'healthy' : 'unknown')
    same(resource.supportedModels, [fixture.model], 'State projection does not rewrite saved model facts')
  }
  await unchanged(before, 'visibility_and_states', {
    visibleConnections: items.length,
    visibleResources: catalog.body.resources.length,
    hiddenConnections: 2,
    scalarGETs: items.length + 3,
  })
}, 15000)
