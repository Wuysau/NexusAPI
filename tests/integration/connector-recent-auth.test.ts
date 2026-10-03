import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { hashPassword } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { authorizeConnector } from '@/lib/connectors/control'
import { POST as createConnection } from '@/app/api/connections/route'
import { POST as configure } from '@/app/api/connections/[id]/connector/route'
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
  return configured
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
    code: ['forbidden', 'csrf_failed', 'unauthenticated'].includes(body?.error?.code) ? body.error.code : null,
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
