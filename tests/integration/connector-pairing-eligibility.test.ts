import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { tokenHash } from '@/lib/connectors/control'
import { POST as createConnection } from '@/app/api/connections/route'
import { POST as configure } from '@/app/api/connections/[id]/connector/route'
import { PATCH as bindProject } from '@/app/api/connections/[id]/project/route'
import { DELETE as revoke } from '@/app/api/connections/[id]/route'
import { PATCH as updateProject } from '@/app/api/projects/[id]/route'
import { GET as session } from '@/app/api/auth/session/route'
import { POST as pair } from '@/app/api/connector/pair/route'
import { POST as lease } from '@/app/api/connector/lease/route'

// Destructive fixture setup accepts only the dedicated target or verified serial CI.
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
  !['/connector_test_pair_eligibility_round61', '/convergence_ci15'].includes(target.pathname) ||
  databaseUrl.includes('?') ||
  databaseUrl.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback pairing eligibility database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'pair-eligibility-tenant'
const organization = 'pair-eligibility-org'
const project = 'pair-eligibility-project'
const user = 'pair-eligibility-admin'
const models = ['pair-eligibility-model']
const csrf = 'pair-eligibility-csrf'
let cookie = ''
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
interface Issuance {
  connectionId: string
  channelId: string
  pairingToken: string
  models: string[]
}
interface Identity {
  connectorId: string
  connectionId: string
  tenantId: string
  credential: string
}
interface Lease {
  leaseId: string
  connectorId: string
  connectionId: string
  tenantId: string
  leaseToken: string
  models: string[]
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const admin = (pathname: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${pathname}`, {
    method,
    headers: { cookie: `${cookie}; nexus_csrf=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const runtime = (pathname: string, token: string, body?: unknown) =>
  new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name === target.pathname.slice(1)).toBe(true)
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$3,$4)', [
    organization,
    tenant,
    'Pairing fixture',
    'pair-eligibility-org',
  ])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    user,
    'pair-admin@example.invalid',
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
    'Pairing project',
  ])
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: user })).token}`
  const response = await session(admin('/api/auth/session'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.authenticated).toBe(true)
  expect(body.freshAuth).toBe(true)
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_PAIR_ELIGIBILITY_AUDIT_REPORT === '1')
    console.info('Pairing eligibility safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pairing fixture pool close timeout')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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
async function create(): Promise<string> {
  const response = await createConnection(
    admin('/api/connections', 'POST', { provider: 'ollama', mode: 'local_sidecar', projectId: project }),
  )
  expect(response.status).toBe(201)
  return (await response.json()).connection.id
}
async function issue(id: string): Promise<Issuance> {
  const response = await configure(admin(`/api/connections/${id}/connector`, 'POST', { models }), params(id))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = (await response.json()) as Issuance
  expect(/^nxpair_[A-Za-z0-9_-]{43}$/.test(body.pairingToken)).toBe(true)
  expect(body.connectionId === id).toBe(true)
  same(body.models, models, 'Recent-auth issuance preserves configured models')
  return body
}
async function successfulPair(token: string, id: string): Promise<Identity> {
  const response = await pair(runtime('/api/connector/pair', token))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = (await response.json()) as Identity
  expect(body.connectionId === id && body.tenantId === tenant).toBe(true)
  expect(/^nxidentity_[A-Za-z0-9_-]{43}$/.test(body.credential)).toBe(true)
  return body
}
async function successfulLease(identity: Identity): Promise<Lease> {
  const response = await lease(runtime('/api/connector/lease', identity.credential, { readyModels: models }))
  expect(response.status).toBe(200)
  const body = (await response.json()) as Lease
  expect(
    body.connectionId === identity.connectionId &&
      body.connectorId === identity.connectorId &&
      body.tenantId === tenant,
  ).toBe(true)
  expect(/^nxlease_[A-Za-z0-9_-]{43}$/.test(body.leaseToken)).toBe(true)
  same(body.models, models, 'Valid identity receives its approved local-model lease')
  return body
}
function deniedResponse(response: Response, body: Record<string, unknown>) {
  expect(response.status).toBe(401)
  same(
    body,
    { error: { code: 'connector_unauthorized', message: '连接器凭据、租约或授权无效' } },
    'Pairing rejection is the same fixed error without credentials',
  )
}
async function denied(token: string, name: string) {
  const before = await facts()
  const response = await pair(runtime('/api/connector/pair', token))
  const body = await response.json()
  const after = await facts()
  observations.push({
    name,
    status: response.status,
    fixedError: isDeepStrictEqual(body, {
      error: { code: 'connector_unauthorized', message: '连接器凭据、租约或授权无效' },
    }),
    factsUnchanged: isDeepStrictEqual(after, before),
  })
  deniedResponse(response, body)
  same(after, before, 'Rejected token does not consume a pairing or change any domain, audit or accounting fact')
}

const invalidContexts = [
  'archived-project',
  'unbound-project',
  'inactive-project',
  'inactive-organization',
  'deleted-organization',
] as const
type InvalidContext = (typeof invalidContexts)[number]
async function changeContext(name: InvalidContext, id: string, restore = false) {
  if (name === 'archived-project') {
    const response = await updateProject(
      admin(`/api/projects/${project}`, 'PATCH', { archived: !restore }),
      params(project),
    )
    expect(response.status).toBe(200)
  } else if (name === 'unbound-project') {
    const response = await bindProject(
      admin(`/api/connections/${id}/project`, 'PATCH', { projectId: restore ? project : null }),
      params(id),
    )
    expect(response.status).toBe(200)
  } else if (name === 'inactive-project') {
    // These inactive/deleted metadata cases use explicit fixture SQL, not an invented management endpoint.
    await pool.query('UPDATE projects SET status=$2 WHERE id=$1', [project, restore ? 'active' : 'inactive'])
  } else if (name === 'inactive-organization') {
    await pool.query('UPDATE organizations SET status=$2 WHERE id=$1', [organization, restore ? 'active' : 'inactive'])
  } else {
    await pool.query('UPDATE organizations SET deleted_at=CASE WHEN $2::boolean THEN NULL ELSE now() END WHERE id=$1', [
      organization,
      restore,
    ])
  }
}

it.each(invalidContexts)(
  'keeps a rotated pairing token unconsumed while context is %s, then permits recovery once',
  async (name) => {
    const id = await create()
    const initial = await issue(id)
    const oldIdentity = await successfulPair(initial.pairingToken, id)
    await successfulLease(oldIdentity)
    const issued = await issue(id)
    const rotated = await facts()
    expect(rotated.connector_identities.length).toBe(1)
    expect(rotated.connector_identities[0].revoked_at !== null).toBe(true)
    expect(rotated.connector_leases.length).toBe(1)
    expect(rotated.connector_leases[0].revoked_at !== null).toBe(true)
    expect(rotated.connector_pairings[0].consumed_at === null).toBe(true)
    await changeContext(name, id)
    const before = await facts()
    const failed = await pair(runtime('/api/connector/pair', issued.pairingToken))
    const failedBody = await failed.json()
    const after = await facts()
    // Capture actual OLD's unusable identity before desired assertions stop the test.
    let subsequentLeaseStatus: number | null = null
    if (failed.status === 200 && typeof failedBody.credential === 'string') {
      const response = await lease(runtime('/api/connector/lease', failedBody.credential, { readyModels: models }))
      subsequentLeaseStatus = response.status
      deniedResponse(response, await response.json())
      same(await facts(), after, 'Ineligible lease changes no fact after an OLD pairing acceptance')
    }
    await changeContext(name, id, true)
    const restored = await facts()
    const recovered = await pair(runtime('/api/connector/pair', issued.pairingToken))
    const recoveredBody = await recovered.json()
    let recoveryLeaseStatus: number | null = null
    if (recovered.status === 200 && typeof recoveredBody.credential === 'string') {
      const response = await lease(runtime('/api/connector/lease', recoveredBody.credential, { readyModels: models }))
      recoveryLeaseStatus = response.status
      expect(response.status).toBe(200)
      const body = (await response.json()) as Lease
      expect(body.connectionId === id && body.connectorId === oldIdentity.connectorId).toBe(true)
      same(body.models, models, 'Restored context leases the same approved model')
    }
    observations.push({
      name,
      pairingStatus: failed.status,
      returnedCredential: typeof failedBody.credential === 'string',
      factsUnchangedOnDenial: isDeepStrictEqual(after, before),
      tokenConsumed: after.connector_pairings[0].consumed_at !== null,
      identityHashChanged:
        after.connector_identities[0].credential_hash !== before.connector_identities[0].credential_hash,
      identityRevocationCleared: after.connector_identities[0].revoked_at === null,
      leaseUnchangedOnDenial: isDeepStrictEqual(after.connector_leases, before.connector_leases),
      auditUnchangedOnDenial: isDeepStrictEqual(after.audit_events, before.audit_events),
      subsequentLeaseStatus,
      recoveryPairingStatus: recovered.status,
      recoveryLeaseStatus,
    })
    await denied(issued.pairingToken, `${name}_once_after_recovery`)
    deniedResponse(failed, failedBody)
    same(after, before, 'Ineligible context preserves the pairing, revoked identity, lease and all historical facts')
    expect(recovered.status).toBe(200)
    expect(recoveryLeaseStatus).toBe(200)
    expect(recoveredBody.connectorId === oldIdentity.connectorId).toBe(true)
    const final = await facts()
    expect(final.connector_pairings.length).toBe(1)
    expect(final.connector_pairings[0].consumed_at !== null).toBe(true)
    expect(final.connector_identities.length).toBe(1)
    expect(final.connector_identities[0].credential_hash === tokenHash(recoveredBody.credential)).toBe(true)
    expect(final.connector_identities[0].revoked_at === null).toBe(true)
    expect(final.connector_leases.length).toBe(1)
    same(
      final.provider_credentials,
      rotated.provider_credentials,
      'Failed onboarding and recovery preserve opaque accounting credentials',
    )
    same(final.audit_events, restored.audit_events, 'Recovery does not issue a new pairing token or success audit')
  },
  15000,
)

it('permits normal recent-auth issuance, one pairing and a usable lease without storing plaintext', async () => {
  const id = await create()
  const issued = await issue(id)
  const before = await facts()
  expect(before.connector_pairings[0].token_hash === tokenHash(issued.pairingToken)).toBe(true)
  const identity = await successfulPair(issued.pairingToken, id)
  const paired = await facts()
  expect(paired.connector_pairings[0].consumed_at !== null).toBe(true)
  expect(paired.connector_identities.length).toBe(1)
  expect(paired.connector_identities[0].credential_hash === tokenHash(identity.credential)).toBe(true)
  for (const table of tables.filter((table) => table !== 'connector_pairings' && table !== 'connector_identities'))
    same(paired[table], before[table], 'Normal pairing mutates only token consumption and identity')
  await denied(issued.pairingToken, 'normal_consumed_token')
  const granted = await successfulLease(identity)
  const after = await facts()
  expect(after.connector_leases.length).toBe(1)
  expect(after.connector_leases[0].lease_token_hash === tokenHash(granted.leaseToken)).toBe(true)
  const serializedFacts = JSON.stringify(after)
  expect(
    [issued.pairingToken, identity.credential, granted.leaseToken].some((token) => serializedFacts.includes(token)),
  ).toBe(false)
  same(after.provider_credentials, before.provider_credentials, 'Normal onboarding preserves the accounting identity')
  same(after.audit_events, before.audit_events, 'Runtime onboarding appends no administrative issuance audit')
  observations.push({
    name: 'normal_onboarding',
    pairingStatus: 200,
    leaseStatus: 200,
    consumedPairings: 1,
    identities: 1,
    leases: 1,
  })
})
it('lets exactly one actual concurrent caller claim the finite pairing token', async () => {
  const id = await create()
  const issued = await issue(id)
  const before = await facts()
  const responses = await Promise.all([
    pair(runtime('/api/connector/pair', issued.pairingToken)),
    pair(runtime('/api/connector/pair', issued.pairingToken)),
  ])
  const statuses = responses.map((response) => response.status).sort()
  same(statuses, [200, 401], 'Concurrent token claim has one winner and one fixed denial')
  for (const response of responses) {
    const body = await response.json()
    if (response.status === 401) deniedResponse(response, body)
    else
      expect(
        body.connectionId === id && body.tenantId === tenant && /^nxidentity_[A-Za-z0-9_-]{43}$/.test(body.credential),
      ).toBe(true)
  }
  const after = await facts()
  expect(after.connector_pairings.length).toBe(1)
  expect(after.connector_pairings[0].consumed_at !== null).toBe(true)
  expect(after.connector_identities.length).toBe(1)
  expect(after.connector_leases.length).toBe(0)
  for (const table of tables.filter((table) => table !== 'connector_pairings' && table !== 'connector_identities'))
    same(after[table], before[table], 'Concurrent claim preserves every other fact and audit')
  observations.push({ name: 'concurrent_claim', statuses, consumedPairings: 1, identities: 1, leases: 0 })
})
it('retains wrong, expired and actually revoked token rejection without changing facts', async () => {
  const wrongId = await create()
  await issue(wrongId)
  await denied(`nxpair_${'x'.repeat(43)}`, 'wrong_token')
  const expiredId = await create()
  const expired = await issue(expiredId)
  await pool.query("UPDATE connector_pairings SET expires_at=now()-interval '1 second' WHERE connection_id=$1", [
    expiredId,
  ])
  await denied(expired.pairingToken, 'expired_token')
  const revokedId = await create()
  const revoked = await issue(revokedId)
  const response = await revoke(admin(`/api/connections/${revokedId}`, 'DELETE'), params(revokedId))
  expect(response.status).toBe(200)
  await denied(revoked.pairingToken, 'revoked_connection_token')
}, 15000)
