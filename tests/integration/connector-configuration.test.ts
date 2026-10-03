import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { POST as createConnection } from '@/app/api/connections/route'
import { POST as configure, GET as state } from '@/app/api/connections/[id]/connector/route'
import { DELETE as removeChannel, PATCH as patchChannel } from '@/app/api/channels/[id]/route'
import { POST as pair } from '@/app/api/connector/pair/route'
import { POST as lease } from '@/app/api/connector/lease/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { authorizeConnector } from '@/lib/connectors/control'
import { connectorChannels } from '@/lib/connectors/snapshot'

// This suite resets its entire disposable schema. Neither an arbitrary app DB
// nor another connector fixture is an acceptable target.
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
  !['/connector_test_configure_round47', '/convergence_ci15'].includes(database.pathname)
)
  throw new Error('Dedicated loopback connector configuration database required')

const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'configuration-tenant'
const organization = 'configuration-org'
const user = 'configuration-admin'
const project = 'configuration-project'
const foreignOrganization = 'configuration-other-org'
const foreignTenant = 'configuration-other-tenant'
const models = ['configuration-model']
const originalConnectorFlag = process.env.NEXUS_CONNECTORS_ENABLED
let cookie = ''
let otherProviderId = ''

const domainTables = [
  'organizations',
  'projects',
  'providers',
  'owned_connections',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
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
type Facts = Record<(typeof domainTables)[number], Record<string, unknown>[]>
interface ConnectorFixture {
  connectionId: string
  channelId: string
  credentialId: string
  identityCredential: string
  leaseToken: string
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const admin = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `${cookie}; nexus_csrf=configuration-csrf`,
      'x-csrf-token': 'configuration-csrf',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const runtime = (path: string, token: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const configureRequest = (connectionId: string, approvedModels = models) =>
  configure(
    admin(`/api/connections/${connectionId}/connector`, 'POST', { models: approvedModels }),
    params(connectionId),
  )

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(database.pathname.slice(1))
  process.env.NEXUS_CONNECTORS_ENABLED = 'true'
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,'Configuration fixture','configuration-org'),
      ($3,$4,'Other synthetic organization','configuration-other-org');
    `,
    [organization, tenant, foreignOrganization, foreignTenant],
  )
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    user,
    'configuration-admin@example.invalid',
    'synthetic-unused-password-hash',
  ])
  await pool.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
    organization,
    tenant,
    user,
    'admin',
  ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$4)', [
    project,
    tenant,
    organization,
    'Configuration project',
  ])
  otherProviderId = (
    await pool.query(`INSERT INTO providers(code,name,official_base_url)
      VALUES('configuration-other','Other synthetic provider','https://configuration.invalid/v1') RETURNING id`)
  ).rows[0].id
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: user })).token}`
}, 30000)

afterAll(async () => {
  if (originalConnectorFlag === undefined) delete process.env.NEXUS_CONNECTORS_ENABLED
  else process.env.NEXUS_CONNECTORS_ENABLED = originalConnectorFlag
  await pool.end()
})

async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of domainTables) {
    const order = table === 'connector_pairings' ? 'connection_id' : 'id'
    result[table] = (await pool.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}

function unchanged(actual: unknown, expected: unknown, label: string) {
  // Full rows include private hashes. Compare in memory without assertion diffs.
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
}

async function projection(fixture: ConnectorFixture) {
  const response = await state(
    admin(`/api/connections/${fixture.connectionId}/connector`),
    params(fixture.connectionId),
  )
  expect(response.status).toBe(200)
  const management = await response.json()
  const snapshot = (await connectorChannels(tenant)).filter((channel) => channel.id === fixture.channelId)
  return {
    state: management.state,
    models: management.models,
    readyModels: management.readyModels,
    snapshotModels: snapshot.flatMap((channel) => channel.models),
  }
}

async function attach(pairingToken: string, readyModels = models) {
  const paired = await pair(runtime('/api/connector/pair', pairingToken))
  expect(paired.status).toBe(200)
  const identity = await paired.json()
  const renewed = await lease(runtime('/api/connector/lease', identity.credential, { readyModels }))
  expect(renewed.status).toBe(200)
  const leased = await renewed.json()
  await authorizeConnector({ leaseToken: leased.leaseToken, transport: true })
  return { identityCredential: identity.credential as string, leaseToken: leased.leaseToken as string }
}

async function healthy(): Promise<ConnectorFixture> {
  const created = await createConnection(
    admin('/api/connections', 'POST', {
      provider: 'ollama',
      mode: 'local_sidecar',
      projectId: project,
    }),
  )
  expect(created.status).toBe(201)
  const connectionId = (await created.json()).connection.id as string
  const configured = await configureRequest(connectionId)
  expect(configured.status).toBe(200)
  const body = await configured.json()
  const credentialId = (await pool.query('SELECT provider_credential_id FROM channels WHERE id=$1', [body.channelId]))
    .rows[0].provider_credential_id as string
  const fixture = {
    connectionId,
    channelId: body.channelId as string,
    credentialId,
    ...(await attach(body.pairingToken)),
  }
  expect(await projection(fixture)).toEqual({ state: 'online', models, readyModels: models, snapshotModels: models })
  return fixture
}

async function rejectWithoutMutation(fixture: ConnectorFixture, code: string, before?: Facts) {
  const previous = before ?? (await facts())
  const response = await configureRequest(fixture.connectionId, ['configuration-next-model'])
  const after = await facts()
  // The old response contains a fresh pairing token. Never print the whole body.
  expect(response.status).toBe(409)
  const body = await response.json()
  expect(Object.keys(body)).toEqual(['error'])
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message'])
  expect(body.error.code).toBe(code)
  expect(typeof body.error.message).toBe('string')
  const serialized = JSON.stringify(body)
  expect(
    [fixture.connectionId, fixture.channelId, fixture.credentialId, tenant, foreignOrganization, otherProviderId].some(
      (value) => serialized.includes(value),
    ),
  ).toBe(false)
  expect(/nxpair_|nxidentity_|nxlease_/.test(serialized)).toBe(false)
  unchanged(after, previous, 'Rejected configuration must preserve complete domain, audit and accounting facts')
  expect(after.audit_events.filter((row) => row.action === 'connector.pairing_issued').length).toBe(
    previous.audit_events.filter((row) => row.action === 'connector.pairing_issued').length,
  )
}

it('creates and rotates a healthy connector without changing its enabled shared credential', async () => {
  const fixture = await healthy()
  const sibling = await healthy()
  await pool.query('UPDATE channels SET provider_credential_id=$1 WHERE id=$2', [
    fixture.credentialId,
    sibling.channelId,
  ])
  const before = await facts()
  const response = await configureRequest(fixture.connectionId, ['configuration-next-model'])
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.channelId === fixture.channelId).toBe(true)
  const rotated = await facts()
  unchanged(
    rotated.provider_credentials,
    before.provider_credentials,
    'Rotation must not enable, replace or rebind credentials',
  )
  expect(rotated.channels.length).toBe(before.channels.length)
  unchanged(
    rotated.channels.find((row) => row.id === sibling.channelId),
    before.channels.find((row) => row.id === sibling.channelId),
    'Shared sibling Channel must stay unchanged',
  )
  for (const table of ['owned_connections', 'connector_identities', 'connector_leases', 'connector_pairings'] as const)
    unchanged(
      rotated[table].filter((row) => row.id === sibling.connectionId || row.connection_id === sibling.connectionId),
      before[table].filter((row) => row.id === sibling.connectionId || row.connection_id === sibling.connectionId),
      'Shared sibling connector facts must stay unchanged',
    )
  expect(
    Boolean(rotated.connector_identities.find((row) => row.connection_id === fixture.connectionId)?.revoked_at),
  ).toBe(true)
  expect(Boolean(rotated.connector_leases.find((row) => row.connection_id === fixture.connectionId)?.revoked_at)).toBe(
    true,
  )
  expect(
    rotated.connector_leases.find((row) => row.connection_id === fixture.connectionId)?.transport_seen_at,
  ).toBeNull()
  expect(
    rotated.connector_pairings.find((row) => row.connection_id === fixture.connectionId)?.token_hash !==
      before.connector_pairings.find((row) => row.connection_id === fixture.connectionId)?.token_hash,
  ).toBe(true)
  expect(rotated.connector_pairings.find((row) => row.connection_id === fixture.connectionId)?.consumed_at).toBeNull()
  expect(
    (await lease(runtime('/api/connector/lease', fixture.identityCredential, { readyModels: models }))).status,
  ).toBe(401)
  await expect(authorizeConnector({ leaseToken: fixture.leaseToken, transport: true })).rejects.toMatchObject({
    status: 401,
  })
  Object.assign(fixture, await attach(body.pairingToken, ['configuration-next-model']))
  expect(await projection(fixture)).toEqual({
    state: 'online',
    models: ['configuration-next-model'],
    readyModels: ['configuration-next-model'],
    snapshotModels: ['configuration-next-model'],
  })
  expect(await projection(sibling)).toEqual({ state: 'online', models, readyModels: models, snapshotModels: models })
})

it('restores a temporary Channel pause with its credential still enabled', async () => {
  const fixture = await healthy()
  const paused = await patchChannel(
    admin(`/api/channels/${fixture.channelId}`, 'PATCH', { enabled: false }),
    params(fixture.channelId),
  )
  expect(paused.status).toBe(200)
  const before = await facts()
  expect(before.channels.find((row) => row.id === fixture.channelId)?.enabled).toBe(false)
  expect(before.provider_credentials.find((row) => row.id === fixture.credentialId)?.enabled).toBe(true)
  const response = await configureRequest(fixture.connectionId)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.channelId === fixture.channelId).toBe(true)
  unchanged(
    (await facts()).provider_credentials,
    before.provider_credentials,
    'Pause recovery must leave credentials unchanged',
  )
  Object.assign(fixture, await attach(body.pairingToken))
  expect(await projection(fixture)).toEqual({ state: 'online', models, readyModels: models, snapshotModels: models })
})

it('rejects configuration after real Channel DELETE without revoking or replacing connector state', async () => {
  const fixture = await healthy()
  const removed = await removeChannel(admin(`/api/channels/${fixture.channelId}`, 'DELETE'), params(fixture.channelId))
  expect(removed.status).toBe(200)
  const before = await facts()
  expect(before.channels.find((row) => row.id === fixture.channelId)?.enabled).toBe(false)
  expect(before.provider_credentials.find((row) => row.id === fixture.credentialId)?.enabled).toBe(false)
  expect(before.connector_identities.find((row) => row.connection_id === fixture.connectionId)?.revoked_at).toBeNull()
  expect(before.connector_leases.find((row) => row.connection_id === fixture.connectionId)?.revoked_at).toBeNull()
  expect(await projection(fixture)).toEqual({ state: 'online', models, readyModels: [], snapshotModels: [] })
  await rejectWithoutMutation(fixture, 'credential_disabled', before)
  expect(await projection(fixture)).toEqual({ state: 'online', models, readyModels: [], snapshotModels: [] })
})

it('rejects a disabled shared credential without reviving either Channel or rotating either connector', async () => {
  const fixture = await healthy()
  const sibling = await healthy()
  await pool.query('UPDATE channels SET provider_credential_id=$1 WHERE id=$2', [
    fixture.credentialId,
    sibling.channelId,
  ])
  expect(
    (await removeChannel(admin(`/api/channels/${sibling.channelId}`, 'DELETE'), params(sibling.channelId))).status,
  ).toBe(200)
  const before = await facts()
  expect(before.channels.find((row) => row.id === fixture.channelId)?.enabled).toBe(true)
  expect(before.channels.find((row) => row.id === sibling.channelId)?.enabled).toBe(false)
  expect(before.provider_credentials.find((row) => row.id === fixture.credentialId)?.enabled).toBe(false)
  await rejectWithoutMutation(fixture, 'credential_disabled', before)
  expect((await projection(sibling)).readyModels).toEqual([])
})

it.each([
  'null reference',
  'credential tenant',
  'credential provider',
  'credential organization',
  'Channel provider',
] as const)('rejects a conflicting %s binding without changing complete persisted facts', async (kind) => {
  const fixture = await healthy()
  switch (kind) {
    case 'null reference':
      // The real FK permits NULL; no dangling reference or constraint bypass.
      await pool.query('UPDATE channels SET provider_credential_id=NULL WHERE id=$1', [fixture.channelId])
      break
    case 'credential tenant':
      await pool.query('UPDATE provider_credentials SET tenant_id=$1 WHERE id=$2', [
        foreignTenant,
        fixture.credentialId,
      ])
      break
    case 'credential provider':
      await pool.query('UPDATE provider_credentials SET provider_id=$1 WHERE id=$2', [
        otherProviderId,
        fixture.credentialId,
      ])
      break
    case 'credential organization':
      await pool.query('UPDATE provider_credentials SET organization_id=$1 WHERE id=$2', [
        foreignOrganization,
        fixture.credentialId,
      ])
      break
    case 'Channel provider':
      await pool.query('UPDATE channels SET provider_id=$1 WHERE id=$2', [otherProviderId, fixture.channelId])
      break
  }
  await rejectWithoutMutation(fixture, 'credential_reference_conflict')
})

it('waits for a concurrent credential disable and then rejects without rotating any domain facts', async () => {
  const fixture = await healthy()
  const expected = await facts()
  const writer = await pool.connect()
  let configuring: Promise<Response> | undefined
  let committed = false
  try {
    await writer.query('BEGIN')
    const writerPID = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const disabled = (
      await writer.query<Record<string, unknown>>(
        'UPDATE provider_credentials SET enabled=false,updated_at=now() WHERE id=$1 RETURNING *',
        [fixture.credentialId],
      )
    ).rows[0]
    expected.provider_credentials = expected.provider_credentials.map((row) =>
      row.id === fixture.credentialId ? disabled : row,
    )
    configuring = configureRequest(fixture.connectionId)
    let settled = false
    void configuring.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    let observedCredentialWait = false
    const deadline = Date.now() + 3000
    while (!settled && Date.now() < deadline) {
      observedCredentialWait = (
        await pool.query(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid))
        AND query ILIKE '%provider_credentials%') AS waiting`,
          [writerPID],
        )
      ).rows[0].waiting
      if (observedCredentialWait) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await writer.query('COMMIT')
    committed = true
    const response = await configuring
    const after = await facts()
    expect(
      observedCredentialWait,
      'Configuration must wait for the credential update instead of accepting stale enabled state',
    ).toBe(true)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('credential_disabled')
    unchanged(
      after,
      expected,
      'Only the concurrent writer may change facts; failed configuration must not rotate state or audit success',
    )
    expect((await projection(fixture)).readyModels).toEqual([])
  } finally {
    if (!committed) await writer.query('ROLLBACK')
    writer.release()
    await configuring?.catch(() => undefined)
  }
}, 15000)
