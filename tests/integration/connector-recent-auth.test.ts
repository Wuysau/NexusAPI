import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { hashPassword } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { authorizeConnector } from '@/lib/connectors/control'
import { POST as createConnection } from '@/app/api/connections/route'
import { PATCH as revokePatch, DELETE as revokeDelete } from '@/app/api/connections/[id]/route'
import { POST as configure, GET as connectorStateRoute } from '@/app/api/connections/[id]/connector/route'
import { POST as pair } from '@/app/api/connector/pair/route'
import { POST as lease } from '@/app/api/connector/lease/route'
import { GET as sessionRoute } from '@/app/api/auth/session/route'
import { POST as reauthRoute } from '@/app/api/auth/reauth/route'

// This suite destructively resets only its dedicated local fixture or the existing serial CI fixture.
if (!process.env.DATABASE_URL) throw new Error('Explicit independent DATABASE_URL required')
const target = new URL(process.env.DATABASE_URL)
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/connector_test_reauth_round54', '/convergence_ci15'].includes(target.pathname) ||
  process.env.DATABASE_URL.includes('?') ||
  process.env.DATABASE_URL.includes('#')
)
  throw new Error('Dedicated loopback connector recent-auth database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'reauth-tenant'
const organization = 'reauth-org'
const user = 'reauth-admin'
const project = 'reauth-project'
const password = 'test-password'
const models = ['reauth-model']
const originalConnectorFlag = process.env.NEXUS_CONNECTORS_ENABLED
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
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
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
type Caller = { cookie: string; csrf: string; sessionId: string }
let caller: Caller
const observations: Record<string, unknown>[] = []
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const request = (path: string, method = 'GET', body?: unknown, as = caller, csrf = true) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `${as.cookie}; nexus_csrf=${as.csrf}`,
      ...(csrf ? { 'x-csrf-token': as.csrf } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const configureRequest = (id: string, as = caller, csrf = true) =>
  configure(request(`/api/connections/${id}/connector`, 'POST', { models }, as, csrf), params(id))
const runtime = (path: string, token: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(async () => {
  // Prove the connected database before either schema can be reset.
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name === target.pathname.slice(1)).toBe(true)
  process.env.NEXUS_CONNECTORS_ENABLED = 'true'
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,'Reauth fixture','reauth-org')`, [
    organization,
    tenant,
  ])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    user,
    'reauth-admin@example.invalid',
    hashPassword(password),
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
    'Reauth project',
  ])
  const created = await createSession({ userId: user })
  caller = { cookie: `${SESSION_COOKIE}=${created.token}`, csrf: 'reauth-csrf', sessionId: created.session.id }
}, 30000)

afterAll(async () => {
  // Opt-in diagnostic contains only fixed outcome codes, counts and booleans.
  if (process.env.NEXUS_REAUTH_AUDIT_REPORT === '1')
    console.info('Connector recent-auth safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture pool close timeout')), 5000)
      }),
    ])
  } catch {
    throw new Error('Connector recent-auth fixture pool did not close')
  } finally {
    if (timer) clearTimeout(timer)
    if (originalConnectorFlag === undefined) delete process.env.NEXUS_CONNECTORS_ENABLED
    else process.env.NEXUS_CONNECTORS_ENABLED = originalConnectorFlag
  }
})

async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'connector_pairings' ? 'connection_id' : 'id'}`)
    ).rows
  return result
}
const counts = (value: Facts) => Object.fromEntries(tables.map((table) => [table, value[table].length]))
const pairingAudits = (value: Facts) =>
  value.audit_events.filter((row) => row.action === 'connector.pairing_issued').length
const withoutAudit = (value: Facts) =>
  Object.fromEntries(tables.filter((table) => table !== 'audit_events').map((table) => [table, value[table]]))
const unchanged = (after: unknown, before: unknown, label: string) =>
  expect(isDeepStrictEqual(after, before), label).toBe(true)
async function create() {
  const response = await createConnection(
    request('/api/connections', 'POST', { provider: 'ollama', mode: 'local_sidecar', projectId: project }),
  )
  expect(response.status).toBe(201)
  return (await response.json()).connection.id as string
}
async function initial(id: string) {
  const response = await configureRequest(id)
  expect(response.status).toBe(200)
  return (await response.json()) as { channelId: string; pairingToken: string }
}
async function healthy(id: string) {
  const configured = await initial(id)
  const paired = await pair(runtime('/api/connector/pair', configured.pairingToken))
  expect(paired.status).toBe(200)
  const identity = await paired.json()
  const leased = await lease(runtime('/api/connector/lease', identity.credential, { readyModels: models }))
  expect(leased.status).toBe(200)
  const result = await leased.json()
  await authorizeConnector({ leaseToken: result.leaseToken, transport: true })
  return { ...configured, identityCredential: identity.credential as string, leaseToken: result.leaseToken as string }
}
async function stale() {
  await pool.query(`UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE id=$1`, [caller.sessionId])
  const response = await sessionRoute(request('/api/auth/session'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.authenticated).toBe(true)
  expect(body.freshAuth).toBe(false)
  expect(new Date(body.sessionExpiresAt).getTime() > Date.now()).toBe(true)
  return {
    authenticated: body.authenticated,
    freshAuth: body.freshAuth,
    expiresInFuture: new Date(body.sessionExpiresAt).getTime() > Date.now(),
  }
}
async function observe(name: string, before: Facts, response: Response, extra: Record<string, unknown> = {}) {
  const after = await facts()
  const body = await response.json()
  const observation = {
    name,
    status: response.status,
    code: ['forbidden', 'csrf_failed', 'unauthenticated', 'tenant_isolation'].includes(body?.error?.code)
      ? body.error.code
      : null,
    before: counts(before),
    after: counts(after),
    unchanged: isDeepStrictEqual(after, before),
    domainUnchanged: isDeepStrictEqual(withoutAudit(after), withoutAudit(before)),
    successfulPairingAuditDelta: pairingAudits(after) - pairingAudits(before),
    returnedPairingToken: typeof body?.pairingToken === 'string',
    ...extra,
  }
  observations.push(observation)
  return { after, observation }
}

it('rejects initial issuance from a still-valid sixteen-minute administrator session before mutations', async () => {
  const id = await create()
  const session = await stale()
  const before = await facts()
  const response = await configureRequest(id)
  const { after, observation } = await observe('stale_initial', before, response, { session })
  expect(response.status).toBe(401)
  expect(observation.code).toBe('forbidden')
  expect(observation.successfulPairingAuditDelta).toBe(0)
  unchanged(after, before, 'A stale initial request must not change any domain fact')
})

it('rejects rotation from a still-valid sixteen-minute administrator without revoking identity or lease', async () => {
  const id = await create()
  await healthy(id)
  const session = await stale()
  const before = await facts()
  expect(before.connector_identities.some((row) => row.revoked_at === null)).toBe(true)
  expect(before.connector_leases.some((row) => row.revoked_at === null && row.transport_seen_at !== null)).toBe(true)
  const response = await configureRequest(id)
  const after = await facts()
  const { observation } = await observe('stale_rotation', before, response, {
    session,
    identitiesRevoked: after.connector_identities.every((row) => row.revoked_at !== null),
    leasesRevoked: after.connector_leases.every((row) => row.revoked_at !== null),
    pairingHashChanged: before.connector_pairings[0].token_hash !== after.connector_pairings[0].token_hash,
    connectionPending: after.owned_connections[0].status === 'pending',
  })
  expect(response.status).toBe(401)
  expect(observation.code).toBe('forbidden')
  expect(observation.successfulPairingAuditDelta).toBe(0)
  unchanged(after, before, 'A stale rotation must preserve complete connector facts')
})

it('allows fresh initial issuance and one administrative rotation with existing lifecycle semantics', async () => {
  const id = await create()
  const beforeInitial = await facts()
  const issued = await configureRequest(id)
  expect(issued.status).toBe(200)
  const initialBody = await issued.json()
  const paired = await pair(runtime('/api/connector/pair', initialBody.pairingToken))
  expect(paired.status).toBe(200)
  const identity = await paired.json()
  const leased = await lease(runtime('/api/connector/lease', identity.credential, { readyModels: models }))
  expect(leased.status).toBe(200)
  const leasedBody = await leased.json()
  await authorizeConnector({ leaseToken: leasedBody.leaseToken, transport: true })
  const before = await facts()
  expect(pairingAudits(before) - pairingAudits(beforeInitial)).toBe(1)
  const response = await configureRequest(id)
  const { after, observation } = await observe('fresh_rotation', before, response)
  expect(response.status).toBe(200)
  expect(observation.successfulPairingAuditDelta).toBe(1)
  expect(after.connector_identities.every((row) => row.revoked_at !== null)).toBe(true)
  expect(after.connector_leases.every((row) => row.revoked_at !== null && row.transport_seen_at === null)).toBe(true)
  expect(after.connector_pairings.length).toBe(1)
  expect(after.connector_pairings[0].token_hash !== before.connector_pairings[0].token_hash).toBe(true)
  unchanged(after.provider_credentials, before.provider_credentials, 'Rotation preserves accounting credential')
  const rejectedIdentity = await lease(
    runtime('/api/connector/lease', identity.credential, { leaseToken: leasedBody.leaseToken, readyModels: models }),
  )
  expect(rejectedIdentity.status).toBe(401)
  expect((await rejectedIdentity.json()).error?.code).toBe('connector_unauthorized')
  let rejectedLease = false
  try {
    await authorizeConnector({ leaseToken: leasedBody.leaseToken, transport: true })
  } catch (error) {
    rejectedLease = typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  }
  expect(rejectedLease, 'Rotated lease must not authorize transport').toBe(true)
  unchanged(
    withoutAudit(await facts()),
    withoutAudit(after),
    'Rejected old runtime credentials preserve business facts',
  )
})

it('keeps capability and CSRF denials before configuration mutation', async () => {
  const id = await create()
  const before = await facts()
  const csrf = await configureRequest(id, caller, false)
  const csrfResult = await observe('csrf_denial', before, csrf)
  expect(csrf.status).toBe(403)
  expect(csrfResult.observation.code).toBe('csrf_failed')
  // Existing rejected-CSRF telemetry appends an audit. The successful pairing audit and business facts stay unchanged.
  expect(csrfResult.observation.successfulPairingAuditDelta).toBe(0)
  expect(csrfResult.after.audit_events.filter((row) => row.action === 'csrf.rejected').length).toBe(1)
  unchanged(withoutAudit(csrfResult.after), withoutAudit(before), 'CSRF denial preserves business facts')
  await pool.query(`UPDATE organization_memberships SET role='viewer' WHERE user_id=$1`, [user])
  const viewerBefore = await facts()
  const viewer = await configureRequest(id)
  const viewerResult = await observe('capability_denial', viewerBefore, viewer)
  expect(viewer.status).toBe(403)
  expect(viewerResult.observation.code).toBe('forbidden')
  expect(viewerResult.observation.successfulPairingAuditDelta).toBe(0)
  unchanged(withoutAudit(viewerResult.after), withoutAudit(viewerBefore), 'Capability denial preserves business facts')
})

it('actual reauthentication replaces the stale session and permits one new pairing issuance', async () => {
  const id = await create()
  await stale()
  const previous = caller
  const reauthenticated = await reauthRoute(request('/api/auth/reauth', 'POST', { password }))
  expect(reauthenticated.status).toBe(200)
  const body = await reauthenticated.json()
  expect(body.authenticated).toBe(true)
  expect(body.freshAuth).toBe(true)
  const issuedCookie = reauthenticated.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))
  expect(typeof issuedCookie === 'string').toBe(true)
  caller = { cookie: issuedCookie!.split(';')[0], csrf: body.csrfToken, sessionId: '' }
  const oldSession = await sessionRoute(request('/api/auth/session', 'GET', undefined, previous))
  expect((await oldSession.json()).authenticated).toBe(false)
  const refreshed = await sessionRoute(request('/api/auth/session'))
  expect((await refreshed.json()).freshAuth).toBe(true)
  const before = await facts()
  const response = await configureRequest(id)
  const { after, observation } = await observe('reauth_initial', before, response, {
    oldSessionRejected: true,
    newSessionFresh: true,
  })
  expect(response.status).toBe(200)
  expect(observation.successfulPairingAuditDelta).toBe(1)
  expect(after.connector_pairings.length).toBe(1)
})

const revocationMethods = ['PATCH', 'DELETE'] as const
type RevocationMethod = (typeof revocationMethods)[number]
const revocationAudits = (value: Facts) =>
  value.audit_events.filter((row) => row.action === 'connection.revoked').length
const revokeRequest = (method: RevocationMethod, id: string, as = caller, csrf = true) =>
  (method === 'PATCH' ? revokePatch : revokeDelete)(
    request(`/api/connections/${id}`, method, undefined, as, csrf),
    params(id),
  )

async function waitForCsrfAudit(expected: number) {
  const deadline = Date.now() + 2000
  while (true) {
    const count = Number(
      (await pool.query(`SELECT count(*) AS count FROM audit_events WHERE action='csrf.rejected'`)).rows[0].count,
    )
    if (count === expected) return
    expect(Date.now() < deadline, 'Rejected CSRF must append its existing security audit').toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function revokedLifecycle(id: string, active: Awaited<ReturnType<typeof healthy>>, before: Facts, after: Facts) {
  const connection = after.owned_connections.find((row) => row.id === id)
  expect(connection?.status).toBe('revoked')
  expect(connection?.revoked_at !== null).toBe(true)
  expect(after.channels.find((row) => row.id === active.channelId)?.enabled).toBe(false)
  const identities = after.connector_identities.filter((row) => row.connection_id === id)
  const leases = after.connector_leases.filter((row) => row.connection_id === id)
  expect(identities.length).toBe(1)
  expect(leases.length).toBe(1)
  expect(identities.every((row) => row.revoked_at !== null)).toBe(true)
  expect(leases.every((row) => row.revoked_at !== null)).toBe(true)
  expect(after.connector_pairings.some((row) => row.connection_id === id)).toBe(false)
  expect(after.connector_identities.length).toBe(before.connector_identities.length)
  expect(after.connector_leases.length).toBe(before.connector_leases.length)
  expect(after.connector_pairings.length).toBe(before.connector_pairings.length - 1)
  unchanged(
    after.provider_credentials,
    before.provider_credentials,
    'Revocation preserves historical accounting credentials',
  )
  const mutable = [
    'owned_connections',
    'channels',
    'connector_identities',
    'connector_leases',
    'connector_pairings',
    'audit_events',
  ]
  for (const table of tables.filter((table) => !mutable.includes(table)))
    unchanged(after[table], before[table], 'Revocation preserves unrelated complete facts')
  const state = await connectorStateRoute(request(`/api/connections/${id}/connector`), params(id))
  expect(state.status).toBe(200)
  const projection = await state.json()
  expect(projection.state).toBe('revoked')
  expect(projection.readyModels).toEqual([])
  const deniedIdentity = await lease(
    runtime('/api/connector/lease', active.identityCredential, { leaseToken: active.leaseToken, readyModels: models }),
  )
  expect(deniedIdentity.status).toBe(401)
  expect((await deniedIdentity.json()).error?.code).toBe('connector_unauthorized')
  let deniedLease = false
  try {
    await authorizeConnector({ leaseToken: active.leaseToken, transport: true })
  } catch (error) {
    deniedLease = typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  }
  expect(deniedLease, 'Revoked lease must not authorize transport').toBe(true)
}

it.each(revocationMethods)(
  'rejects stale-session %s revocation before connector facts and successful audits change',
  async (method) => {
    const id = await create()
    await healthy(id)
    const session = await stale()
    const before = await facts()
    expect(before.connector_identities.some((row) => row.connection_id === id && row.revoked_at === null)).toBe(true)
    expect(
      before.connector_leases.some(
        (row) => row.connection_id === id && row.revoked_at === null && row.transport_seen_at !== null,
      ),
    ).toBe(true)
    const response = await revokeRequest(method, id)
    const after = await facts()
    const { observation } = await observe(`stale_revoke_${method}`, before, response, {
      session,
      successfulRevocationAuditDelta: revocationAudits(after) - revocationAudits(before),
      connectionRevoked: after.owned_connections.find((row) => row.id === id)?.status === 'revoked',
      identitiesRevoked: after.connector_identities
        .filter((row) => row.connection_id === id)
        .every((row) => row.revoked_at !== null),
      leasesRevoked: after.connector_leases
        .filter((row) => row.connection_id === id)
        .every((row) => row.revoked_at !== null),
      pairingsRemoved: !after.connector_pairings.some((row) => row.connection_id === id),
      channelsDisabled: after.channels.every((row) => row.enabled === false),
    })
    expect(response.status).toBe(401)
    expect(observation.code).toBe('forbidden')
    expect(revocationAudits(after) - revocationAudits(before)).toBe(0)
    unchanged(after, before, 'Stale revocation preserves complete facts and successful audit')
  },
)

it.each(revocationMethods)(
  'allows fresh %s revocation once and invalidates the actual paired identity and lease',
  async (method) => {
    const id = await create()
    const active = await healthy(id)
    const before = await facts()
    const response = await revokeRequest(method, id)
    const { after } = await observe(`fresh_revoke_${method}`, before, response)
    expect(response.status).toBe(200)
    expect(revocationAudits(after) - revocationAudits(before)).toBe(1)
    await revokedLifecycle(id, active, before, after)
    const repeatedBefore = await facts()
    const repeated = await revokeRequest(method, id)
    expect(repeated.status).toBe(404)
    expect((await repeated.json()).error?.code).toBe('tenant_isolation')
    const repeatedAfter = await facts()
    expect(revocationAudits(repeatedAfter) - revocationAudits(repeatedBefore)).toBe(0)
    unchanged(repeatedAfter, repeatedBefore, 'Repeated revocation preserves terminal history')
  },
)

it('actual reauthentication permits both revocation methods with a new fresh session', async () => {
  for (const method of revocationMethods) {
    const session = await createSession({ userId: user })
    caller = { cookie: `${SESSION_COOKIE}=${session.token}`, csrf: 'reauth-csrf', sessionId: session.session.id }
    const id = await create()
    const active = await healthy(id)
    await stale()
    const previous = caller
    const reauthenticated = await reauthRoute(request('/api/auth/reauth', 'POST', { password }))
    expect(reauthenticated.status).toBe(200)
    const body = await reauthenticated.json()
    expect(body.freshAuth).toBe(true)
    const issuedCookie = reauthenticated.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    expect(typeof issuedCookie === 'string').toBe(true)
    caller = { cookie: issuedCookie!.split(';')[0], csrf: body.csrfToken, sessionId: '' }
    expect(
      (await (await sessionRoute(request('/api/auth/session', 'GET', undefined, previous))).json()).authenticated,
    ).toBe(false)
    const before = await facts()
    const response = await revokeRequest(method, id)
    const { after } = await observe(`reauth_revoke_${method}`, before, response, {
      oldSessionRejected: true,
      newSessionFresh: true,
    })
    expect(response.status).toBe(200)
    expect(revocationAudits(after) - revocationAudits(before)).toBe(1)
    await revokedLifecycle(id, active, before, after)
  }
})

it('preserves revocation capability, CSRF and unrelated tenant or organization visibility guards', async () => {
  const id = await create()
  await healthy(id)
  // Canonical organizations have one tenant each; the foreign org is a valid distinct tenant.
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES
    ('revocation-other-tenant-org','revocation-other-tenant','Other synthetic tenant','revocation-other-tenant-org')`)
  await pool.query(
    `INSERT INTO users(id,email,password_hash) VALUES('revocation-other-user','revocation-other@example.invalid',$1)`,
    [hashPassword(password)],
  )
  await pool.query(`INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES
    ('revocation-other-tenant-org','revocation-other-tenant','revocation-other-user','admin')`)
  await pool.query(`INSERT INTO projects(id,tenant_id,organization_id,name) VALUES
    ('revocation-other-tenant-project','revocation-other-tenant','revocation-other-tenant-org','Other tenant project')`)
  await pool.query(`INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode) VALUES
    ('revocation-other-tenant-connection','revocation-other-tenant','revocation-other-user','revocation-other-tenant-project','ollama','local_sidecar')`)
  for (const method of revocationMethods) {
    const before = await facts()
    const csrfCount = before.audit_events.filter((row) => row.action === 'csrf.rejected').length
    const csrf = await revokeRequest(method, id, caller, false)
    expect(csrf.status).toBe(403)
    await waitForCsrfAudit(csrfCount + 1)
    const csrfResult = await observe(`revoke_csrf_${method}`, before, csrf)
    expect(csrfResult.observation.code).toBe('csrf_failed')
    expect(revocationAudits(csrfResult.after) - revocationAudits(before)).toBe(0)
    unchanged(withoutAudit(csrfResult.after), withoutAudit(before), 'CSRF denial preserves revocation business facts')
    await pool.query(`UPDATE organization_memberships SET role='viewer' WHERE user_id=$1`, [user])
    const viewerBefore = await facts()
    const viewer = await revokeRequest(method, id)
    const viewerResult = await observe(`revoke_capability_${method}`, viewerBefore, viewer)
    expect(viewer.status).toBe(403)
    expect(viewerResult.observation.code).toBe('forbidden')
    unchanged(viewerResult.after, viewerBefore, 'Capability denial preserves revocation facts and audit')
    // This role has credential:disable, but owns no project membership. Administrators retain their legitimate org access.
    await pool.query(`UPDATE organization_memberships SET role='developer' WHERE user_id=$1`, [user])
    const projectBefore = await facts()
    const projectDenied = await revokeRequest(method, id)
    const projectResult = await observe(`revoke_project_visibility_${method}`, projectBefore, projectDenied)
    expect(projectDenied.status).toBe(404)
    expect(projectResult.observation.code).toBe('tenant_isolation')
    unchanged(projectResult.after, projectBefore, 'An unauthorized ordinary project actor preserves all facts')
    await pool.query(`UPDATE organization_memberships SET role='admin' WHERE user_id=$1`, [user])
    const foreignBefore = await facts()
    const rejected = await revokeRequest(method, 'revocation-other-tenant-connection')
    const foreignResult = await observe(`revoke_visibility_${method}`, foreignBefore, rejected)
    expect(rejected.status).toBe(404)
    expect(foreignResult.observation.code).toBe('tenant_isolation')
    unchanged(foreignResult.after, foreignBefore, 'Unrelated tenant or org denial preserves all facts and audit')
  }
})
