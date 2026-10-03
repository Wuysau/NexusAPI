import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { hashPassword } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { PATCH as bindConnection } from '@/app/api/connections/[id]/project/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent connection-authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid connection-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_connection_authority_round68', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback connection-authority fixture required')

const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const passwordHash = hashPassword('Independent authority fixture password 68')
const observations: Record<string, string | number | boolean>[] = []
let fixtureOwner: PoolClient | undefined
let sequence = 0

beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Connection-authority fixture database mismatch')
  const locked = await fixtureOwner.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
    ['nexus-connection-authority-fixture:' + target.pathname],
  )
  if (!locked.rows[0]?.locked) throw new Error('Connection-authority fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Connection-authority fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_CONNECTION_AUTHORITY_REPORT === '1')
    console.info('Connection-authority safe observations:', JSON.stringify(observations))
  if (fixtureOwner) {
    await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
      'nexus-connection-authority-fixture:' + target.pathname,
    ])
    fixtureOwner.release()
  }
  await pool.end()
})

interface Fixture {
  tenant: string
  organization: string
  actor: string
  owner: string
  project: string
  destination: string
  connection: string
  cookie: string
  csrf: string
}
async function fixture(): Promise<Fixture> {
  const prefix = 'connection-authority-' + ++sequence
  const f = {
    tenant: prefix + '-tenant',
    organization: prefix + '-org',
    actor: prefix + '-admin',
    owner: prefix + '-owner',
    project: prefix + '-private',
    destination: prefix + '-destination',
    connection: prefix + '-connection',
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.organization, f.tenant])
  for (const user of [f.actor, f.owner])
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      user,
      user + '@example.invalid',
      passwordHash,
    ])
  for (const [user, role] of [
    [f.actor, 'admin'],
    [f.owner, 'owner'],
  ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [f.organization, f.tenant, user, role],
    )
  for (const project of [f.project, f.destination])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
      project,
      f.tenant,
      f.organization,
    ])
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities,account_observation)
     VALUES($1,$2,$3,$4,'fixture-provider','subscription_interactive','active',$5::jsonb,$6::jsonb)`,
    [
      f.connection,
      f.tenant,
      f.owner,
      f.project,
      JSON.stringify({
        fixture: 'authority-68',
        routing: false,
        execution_mode: 'interactive',
        connection_type: 'subscription',
      }),
      JSON.stringify({ observed: true }),
    ],
  )
  await pool.query(
    `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,occurred_at,connection_id,project_id,project_name,matched_root,attributed_at,parser_version)
     VALUES($1,$2,'codex_local','client_observed',$3,$3,now(),$4,$5,'Frozen private project','/fixture/authority-68',now(),'codex-rollout-v1')`,
    [f.tenant, f.organization, f.connection + '-history', f.connection, f.project],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
const params = (f: Fixture) => ({ params: Promise.resolve({ id: f.connection }) })
function request(f: Fixture, body: BodyInit, validCsrf = true): Request {
  return new Request('http://localhost/api/connections/' + f.connection + '/project', {
    method: 'PATCH',
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      [CSRF_HEADER]: validCsrf ? f.csrf : 'invalid-synthetic-csrf',
      'content-type': 'application/json',
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
}
const tables = [
  'projects',
  'project_memberships',
  'owned_connections',
  'external_observed_usage',
  'downstream_api_keys',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'sessions',
] as const
async function facts() {
  const result = {} as Record<(typeof tables)[number], Record<string, unknown>[]>
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'connector_pairings' ? 'connection_id' : 'id'}`)
    ).rows
  return result
}
async function successAudits(f: Fixture): Promise<number> {
  return Number(
    (
      await pool.query(
        "SELECT count(*)::text count FROM audit_events WHERE action='connection.project_updated' AND target_id=$1",
        [f.connection],
      )
    ).rows[0]?.count,
  )
}
async function changeMembership(f: Fixture, role: 'viewer' | null) {
  if (role)
    await pool.query('UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3', [
      role,
      f.organization,
      f.actor,
    ])
  else
    await pool.query('DELETE FROM organization_memberships WHERE organization_id=$1 AND user_id=$2', [
      f.organization,
      f.actor,
    ])
  const current = await pool.query(
    'SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
    [f.organization, f.actor],
  )
  expect(role ? current.rows[0]?.role === role : current.rows.length === 0).toBe(true)
}
const pendingBodies: { pending: Promise<Response>; abort: () => void }[] = []
afterEach(async () => {
  const bodies = pendingBodies.splice(0)
  for (const body of bodies) body.abort()
  await Promise.all(bodies.map((body) => body.pending))
})
function delayedRequest(f: Fixture) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let consumed!: () => void
  const entered = new Promise<void>((resolve) => {
    consumed = resolve
  })
  // A zero queue capacity prevents eager stream pull before the route consumes its body.
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        consumed()
      },
    },
    { highWaterMark: 0 },
  )
  const req = request(f, stream)
  let finished = false
  let settled = false
  const pending = bindConnection(req, params(f)).finally(() => {
    settled = true
  })
  pendingBodies.push({
    pending,
    abort() {
      if (!finished) {
        finished = true
        controller.error(new Error('Fixture request body closed during cleanup'))
      }
    },
  })
  return {
    req,
    pending,
    settled: () => settled,
    async waitForBody() {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Actual route did not consume its delayed request body')), 5000)
          }),
        ])
        expect(req.bodyUsed).toBe(true)
        expect(settled).toBe(false)
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    },
    finish(projectId: string | null) {
      if (finished) throw new Error('Fixture request body already finished')
      finished = true
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ projectId })))
      controller.close()
    },
  }
}
async function observe(
  f: Fixture,
  kind: string,
  response: Response,
  before: Awaited<ReturnType<typeof facts>>,
  auditBefore: number,
) {
  const after = await facts()
  const binding = (await pool.query('SELECT project_id FROM owned_connections WHERE id=$1', [f.connection])).rows[0]
    ?.project_id
  const observation = {
    kind,
    status: response.status,
    bindingUnchanged: binding === f.project,
    domainUnchanged: isDeepStrictEqual(after, before),
    historicalEvidenceUnchanged: isDeepStrictEqual(after.external_observed_usage, before.external_observed_usage),
    sessionUnchanged: isDeepStrictEqual(after.sessions, before.sessions),
    successAuditDelta: (await successAudits(f)) - auditBefore,
  }
  observations.push(observation)
  return { after, binding, observation }
}

it.each(['viewer', null] as const)(
  'rejects an in-flight unbind after administrator membership becomes %s',
  async (role) => {
    const f = await fixture()
    const delayed = delayedRequest(f)
    await delayed.waitForBody()
    await changeMembership(f, role)
    const before = await facts()
    const auditBefore = await successAudits(f)
    delayed.finish(null)
    const response = await delayed.pending
    const { observation } = await observe(f, 'delayed-unbind-' + (role ?? 'removed'), response, before, auditBefore)
    expect([403, 404].includes(response.status)).toBe(true)
    expect(observation.bindingUnchanged).toBe(true)
    expect(observation.domainUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(0)
  },
)

it.each(['viewer', null] as const)('control: a non-null destination rechecks changed membership %s', async (role) => {
  const f = await fixture()
  const delayed = delayedRequest(f)
  await delayed.waitForBody()
  await changeMembership(f, role)
  const before = await facts()
  const auditBefore = await successAudits(f)
  delayed.finish(f.destination)
  const response = await delayed.pending
  const { observation } = await observe(f, 'delayed-nonnull-' + (role ?? 'removed'), response, before, auditBefore)
  expect(response.status).toBe(404)
  expect(observation.bindingUnchanged).toBe(true)
  expect(observation.domainUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(0)
})

it.each([null, 'destination'] as const)(
  'control: an unchanged administrator can set the binding to %s',
  async (destination) => {
    const f = await fixture()
    const delayed = delayedRequest(f)
    await delayed.waitForBody()
    const before = await facts()
    const auditBefore = await successAudits(f)
    const projectId = destination ? f.destination : null
    delayed.finish(projectId)
    const response = await delayed.pending
    const { after, binding, observation } = await observe(
      f,
      'active-admin-' + (destination ?? 'unbind'),
      response,
      before,
      auditBefore,
    )
    expect(response.status).toBe(200)
    expect(binding === projectId).toBe(true)
    expect(observation.successAuditDelta).toBe(1)
    for (const table of tables.filter((name) => name !== 'owned_connections'))
      expect(isDeepStrictEqual(after[table], before[table]), table + ' unchanged').toBe(true)
    expect(
      isDeepStrictEqual(
        after.owned_connections.filter((row) => row.id !== f.connection),
        before.owned_connections.filter((row) => row.id !== f.connection),
      ),
    ).toBe(true)
  },
)

it.each(['viewer', null] as const)(
  'control: fresh requests reject changed membership %s before reading the body',
  async (role) => {
    const f = await fixture()
    await changeMembership(f, role)
    const before = await facts()
    const auditBefore = await successAudits(f)
    const req = request(f, JSON.stringify({ projectId: null }))
    const response = await bindConnection(req, params(f))
    const { observation } = await observe(f, 'fresh-' + (role ?? 'removed'), response, before, auditBefore)
    expect(response.status).toBe(role ? 403 : 401)
    expect(req.bodyUsed).toBe(false)
    expect(observation.domainUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(0)
  },
)

it('control: mismatched real CSRF rejects an active administrator without changing the binding', async () => {
  const f = await fixture()
  const before = await facts()
  const auditBefore = await successAudits(f)
  const req = request(f, JSON.stringify({ projectId: null }), false)
  const response = await bindConnection(req, params(f))
  const { observation } = await observe(f, 'csrf-denied', response, before, auditBefore)
  expect(response.status).toBe(403)
  expect(req.bodyUsed).toBe(false)
  expect(observation.domainUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(0)
})

it('uses current developer ownership even when the former administrator still has project visibility', async () => {
  const f = await fixture()
  await pool.query('INSERT INTO project_memberships(project_id,tenant_id,user_id) VALUES($1,$2,$3)', [
    f.project,
    f.tenant,
    f.actor,
  ])
  const delayed = delayedRequest(f)
  await delayed.waitForBody()
  await pool.query('UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3', [
    'developer',
    f.organization,
    f.actor,
  ])
  const before = await facts()
  const auditBefore = await successAudits(f)
  delayed.finish(null)
  const response = await delayed.pending
  const { observation } = await observe(f, 'developer-other-owner', response, before, auditBefore)
  expect(response.status).toBe(404)
  expect(observation.domainUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(0)
})

it('preserves administrator recovery by unbinding a connection from an archived source project', async () => {
  const f = await fixture()
  await pool.query('UPDATE projects SET archived_at=now() WHERE id=$1', [f.project])
  const before = await facts()
  const auditBefore = await successAudits(f)
  const response = await bindConnection(request(f, JSON.stringify({ projectId: null })), params(f))
  const { binding, observation } = await observe(f, 'archived-source-recovery', response, before, auditBefore)
  expect(response.status).toBe(200)
  expect(binding).toBeNull()
  expect(observation.historicalEvidenceUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(1)
})

it('keeps destination project visibility separate from archived source recovery', async () => {
  const f = await fixture()
  await pool.query('UPDATE projects SET archived_at=now() WHERE id=$1', [f.destination])
  const before = await facts()
  const auditBefore = await successAudits(f)
  const response = await bindConnection(request(f, JSON.stringify({ projectId: f.destination })), params(f))
  const { observation } = await observe(f, 'archived-destination-denied', response, before, auditBefore)
  expect(response.status).toBe(404)
  expect(observation.domainUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(0)
})
