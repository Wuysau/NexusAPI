import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { pool } from '../../src/db'
import { createSession, SESSION_COOKIE } from '../../src/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '../../src/lib/auth/csrf'
import { GET as sessionRoute } from '../../src/app/api/auth/session/route'
import { GET as projectRoute } from '../../src/app/api/projects/[id]/route'
import { POST as configure } from '../../src/app/api/connections/[id]/connector/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent connector-authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid connector-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/connector_test_authority_round73', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback connector-authority fixture required')

pool.options.statement_timeout = 8000
pool.options.lock_timeout = 6000
pool.options.idle_in_transaction_session_timeout = 10000
pool.options.connectionTimeoutMillis = 4000
const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const tenant = 'connector-authority73-tenant'
const organization = 'connector-authority73-org'
const project = 'connector-authority73-project'
const user = 'connector-authority73-admin'
const csrf = issueCsrfToken()
const initialModels = ['authority-old-model73']
const nextModels = ['authority-new-model73']
const stages = ['initial', 'rotation'] as const
type Stage = (typeof stages)[number]
let cookie = ''
let fixtureOwner: PoolClient | undefined
let fixtureLocked = false
const fixtureLock = 'nexus-connector-authority-fixture:' + target.pathname
const observations: Record<string, string | number | boolean>[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function bounded<T>(pending: Promise<T>, message: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
function request(path: string, body?: unknown, withCsrf = true) {
  return new Request('http://localhost' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`,
      ...(withCsrf ? { [CSRF_HEADER]: csrf } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const configureRequest = (id: string, models = nextModels, withCsrf = true) =>
  configure(request(`/api/connections/${id}/connector`, { models }, withCsrf), params(id))

beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Connector-authority fixture database mismatch')
  fixtureLocked = (
    await fixtureOwner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
      fixtureLock,
    ])
  ).rows[0]?.locked
  if (!fixtureLocked) throw new Error('Connector-authority fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Connector-authority fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrated = await runMigrations(pool)
  expect([migrated.total, migrated.applied]).toEqual([28, 28])
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [organization, tenant])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    user,
    'connector-authority73@example.invalid',
    'unused-synthetic-password-hash',
  ])
  await pool.query(
    `INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,'admin')`,
    [organization, tenant, user],
  )
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    project,
    tenant,
    organization,
  ])
  await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
    tenant,
    project,
    user,
  ])
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: user })).token}`
}, 30000)

beforeEach(async () => {
  await pool.query(
    `UPDATE organization_memberships SET role='admin' WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3`,
    [tenant, organization, user],
  )
  const response = await sessionRoute(request('/api/auth/session'))
  const session = await response.json()
  expect(response.status).toBe(200)
  expect(session.authenticated === true && session.freshAuth === true).toBe(true)
})

afterAll(async () => {
  if (process.env.NEXUS_CONNECTOR_AUTHORITY_REPORT === '1')
    console.info('Connector-authority safe observations:', JSON.stringify(observations))
  try {
    if (fixtureOwner && fixtureLocked)
      await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [fixtureLock])
  } finally {
    fixtureOwner?.release()
    await bounded(pool.end(), 'Connector-authority fixture pool did not close', 12000)
  }
}, 16000)

const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'project_memberships',
  'projects',
  'owned_connections',
  'providers',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'downstream_api_keys',
  'quota_snapshots',
  'external_observed_usage',
  'resource_routing_policies',
  'nexus_tasks',
  'task_sessions',
  'task_handoff_snapshots',
  'task_resource_transitions',
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
async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables) {
    const order =
      table === 'resource_routing_policies'
        ? 'tenant_id,organization_id,project_id'
        : table === 'connector_pairings'
          ? 'connection_id'
          : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}
const pairingAudits = (value: Facts) => value.audit_events.filter((row) => row.action === 'connector.pairing_issued')
const same = (after: unknown, before: unknown, label: string) =>
  expect(isDeepStrictEqual(after, before), label).toBe(true)

async function seed(stage: Stage) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode)
     VALUES($1,$2,$3,$4,'ollama','local_sidecar')`,
    [id, tenant, user, project],
  )
  if (stage === 'rotation') {
    const initial = await configureRequest(id, initialModels)
    expect(initial.status).toBe(200)
    const issued = await initial.json()
    expect(typeof issued.pairingToken === 'string').toBe(true)
    const identity = randomUUID()
    // Synthetic hashes and lease observations characterize persistence only, without running any connector.
    await pool.query(
      'INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash) VALUES($1,$2,$3,$4)',
      [identity, id, tenant, hash('synthetic-identity73:' + id)],
    )
    await pool.query(
      `INSERT INTO connector_leases(tenant_id,connection_id,connector_id,lease_token_hash,expires_at,last_heartbeat_at,ready_models,transport_seen_at)
       VALUES($1,$2,$3,$4,now()+interval '10 minutes',now(),$5::jsonb,now())`,
      [tenant, id, identity, hash('synthetic-lease73:' + id), JSON.stringify(initialModels)],
    )
    await pool.query(
      `UPDATE owned_connections SET status='active',last_heartbeat_at=now(),updated_at=now() WHERE id=$1`,
      [id],
    )
  }
  return id
}

async function assertProjectStillVisible() {
  const membership = await pool.query(
    'SELECT user_id FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3',
    [tenant, project, user],
  )
  expect(membership.rowCount).toBe(1)
  const response = await projectRoute(request(`/api/projects/${project}`), params(project))
  expect(response.status).toBe(200)
}
async function observe(name: string, id: string, before: Facts, response: Response) {
  const body = await response.json()
  const after = await facts()
  const code = ['forbidden', 'csrf_failed', 'unauthenticated', 'tenant_isolation'].includes(body.error?.code)
    ? body.error.code
    : 'none'
  const beforePairing = before.connector_pairings.find((row) => row.connection_id === id)
  const afterPairing = after.connector_pairings.find((row) => row.connection_id === id)
  const currentIdentities = after.connector_identities.filter((row) => row.connection_id === id)
  const currentLeases = after.connector_leases.filter((row) => row.connection_id === id)
  const observation = {
    name,
    status: response.status,
    code,
    returnedPairingToken: typeof body.pairingToken === 'string',
    allFactsUnchanged: isDeepStrictEqual(after, before),
    connectionsUnchanged: isDeepStrictEqual(after.owned_connections, before.owned_connections),
    channelsUnchanged: isDeepStrictEqual(after.channels, before.channels),
    credentialsUnchanged: isDeepStrictEqual(after.provider_credentials, before.provider_credentials),
    pairingsUnchanged: isDeepStrictEqual(after.connector_pairings, before.connector_pairings),
    identitiesUnchanged: isDeepStrictEqual(after.connector_identities, before.connector_identities),
    leasesUnchanged: isDeepStrictEqual(after.connector_leases, before.connector_leases),
    projectMembershipUnchanged: isDeepStrictEqual(after.project_memberships, before.project_memberships),
    sessionsUnchanged: isDeepStrictEqual(after.sessions, before.sessions),
    successAuditDelta: pairingAudits(after).length - pairingAudits(before).length,
    channelCountDelta: after.channels.length - before.channels.length,
    credentialCountDelta: after.provider_credentials.length - before.provider_credentials.length,
    pairingCountDelta: after.connector_pairings.length - before.connector_pairings.length,
    pairingHashChanged: !!beforePairing && !!afterPairing && beforePairing.token_hash !== afterPairing.token_hash,
    identitiesRevoked: currentIdentities.length > 0 && currentIdentities.every((row) => row.revoked_at !== null),
    leasesRevoked: currentLeases.length > 0 && currentLeases.every((row) => row.revoked_at !== null),
    connectionPending: after.owned_connections.find((row) => row.id === id)?.status === 'pending',
    plaintextAbsent: typeof body.pairingToken !== 'string' || !JSON.stringify(after).includes(body.pairingToken),
  }
  observations.push(observation)
  return { after, body, observation }
}
function assertDenied(after: Facts, before: Facts, body: Record<string, unknown>, response: Response) {
  expect(response.status).toBe(403)
  expect((body.error as Record<string, unknown>)?.code).toBe('forbidden')
  expect(typeof body.pairingToken === 'string').toBe(false)
  same(after, before, 'Denied pairing or rotation preserves complete facts and successful audits')
}
function assertAccepted(after: Facts, before: Facts, body: Record<string, unknown>, stage: Stage, id: string) {
  expect(typeof body.pairingToken === 'string').toBe(true)
  expect(JSON.stringify(after).includes(String(body.pairingToken))).toBe(false)
  expect(
    after.connector_pairings.find((row) => row.connection_id === id)?.token_hash === hash(String(body.pairingToken)),
  ).toBe(true)
  const audit = pairingAudits(after)
  expect(audit.length - pairingAudits(before).length).toBe(1)
  const priorAuditIds = new Set(pairingAudits(before).map((row) => row.id))
  const addedAudits = audit.filter((row) => !priorAuditIds.has(row.id))
  expect(addedAudits.length).toBe(1)
  expect(
    addedAudits[0].actor_user_id === user && addedAudits[0].tenant_id === tenant && addedAudits[0].target_id === id,
  ).toBe(true)
  same(addedAudits[0].metadata, { modelCount: nextModels.length }, 'Issuance retains its exact redacted audit metadata')
  const current = after.owned_connections.find((row) => row.id === id)
  expect(current?.status === 'pending' && current?.last_heartbeat_at === null).toBe(true)
  same((current?.capabilities as Record<string, unknown>).models, nextModels, 'Issuance applies only submitted models')
  const mutable: string[] = ['owned_connections', 'channels', 'connector_pairings', 'audit_events']
  if (stage === 'initial') {
    expect(after.channels.length - before.channels.length).toBe(1)
    expect(after.provider_credentials.length - before.provider_credentials.length).toBe(1)
    expect(after.connector_pairings.length - before.connector_pairings.length).toBe(1)
    mutable.push('providers', 'provider_credentials')
  } else {
    expect(after.channels.length).toBe(before.channels.length)
    expect(after.connector_pairings.length).toBe(before.connector_pairings.length)
    const identities = after.connector_identities.filter((row) => row.connection_id === id)
    const leases = after.connector_leases.filter((row) => row.connection_id === id)
    expect(identities.length === 1 && identities.every((row) => row.revoked_at !== null)).toBe(true)
    expect(
      leases.length === 1 && leases.every((row) => row.revoked_at !== null && row.transport_seen_at === null),
    ).toBe(true)
    expect(
      after.connector_pairings.find((row) => row.connection_id === id)?.token_hash !==
        before.connector_pairings.find((row) => row.connection_id === id)?.token_hash,
    ).toBe(true)
    mutable.push('connector_identities', 'connector_leases')
  }
  for (const table of tables.filter((table) => !mutable.includes(table)))
    same(after[table], before[table], 'Authorized issuance preserves unrelated complete facts')
}

async function delayed(stage: Stage, demote: boolean) {
  const id = await seed(stage)
  let release!: () => void, entered!: () => void
  const bodyGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bodyEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        entered()
        await bodyGate
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ models: nextModels })))
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const req = new Request(request(`/api/connections/${id}/connector`, { models: nextModels }), {
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const pending = configure(req, params(id))
  void pending.catch(() => {})
  try {
    await bounded(bodyEntered, 'Native request body must follow recent administrator authorization')
    if (demote) {
      const changed = await pool.query(
        `UPDATE organization_memberships SET role='developer' WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3 AND role='admin'`,
        [tenant, organization, user],
      )
      expect(changed.rowCount).toBe(1)
    }
    await assertProjectStillVisible()
    const before = await facts()
    release()
    const response = await bounded(pending, 'Pairing completes after native body release')
    const { after, body } = await observe(`body_${stage}_${demote ? 'demoted' : 'unchanged'}`, id, before, response)
    if (demote) assertDenied(after, before, body, response)
    else {
      expect(response.status).toBe(200)
      assertAccepted(after, before, body, stage, id)
    }
  } finally {
    release()
    await bounded(pending, 'Delayed pairing cleanup must complete')
  }
}

it.each(stages)('refuses %s after administrator becomes a project-member developer during the body', async (stage) => {
  await delayed(stage, true)
})
it.each(stages)('retains healthy delayed-body %s for a current administrator', async (stage) => {
  await delayed(stage, false)
})
it.each(stages)('rejects fresh project-member developer %s before mutation', async (stage) => {
  const id = await seed(stage)
  await pool.query(
    `UPDATE organization_memberships SET role='developer' WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3`,
    [tenant, organization, user],
  )
  await assertProjectStillVisible()
  const before = await facts()
  const response = await configureRequest(id)
  const { after, body } = await observe(`fresh_${stage}_developer`, id, before, response)
  assertDenied(after, before, body, response)
})
it.each(stages)('preserves %s facts and successful audit on actual CSRF denial', async (stage) => {
  const id = await seed(stage)
  const before = await facts()
  const response = await configureRequest(id, nextModels, false)
  const deadline = Date.now() + 3000
  while (
    (await pool.query(`SELECT count(*)::int count FROM audit_events WHERE action='csrf.rejected'`)).rows[0].count !==
    before.audit_events.filter((row) => row.action === 'csrf.rejected').length + 1
  ) {
    expect(Date.now() < deadline, 'Rejected CSRF must append its existing security audit').toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const { after, body } = await observe(`csrf_${stage}`, id, before, response)
  expect(response.status).toBe(403)
  expect(body.error?.code).toBe('csrf_failed')
  expect(typeof body.pairingToken === 'string').toBe(false)
  expect(pairingAudits(after).length - pairingAudits(before).length).toBe(0)
  expect(after.audit_events.length - before.audit_events.length).toBe(1)
  for (const table of tables.filter((table) => table !== 'audit_events'))
    same(after[table], before[table], 'CSRF denial preserves complete business facts')
})
