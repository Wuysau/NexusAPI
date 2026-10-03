import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { POST as heartbeat } from '@/app/api/connections/[id]/heartbeat/route'
import { GET as listConnections } from '@/app/api/connections/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent heartbeat-authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid heartbeat-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_access_heartbeat_round74', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact loopback heartbeat-authority fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
let owner: PoolClient | undefined
let locked = false
let sequence = 0
const observations: Record<string, unknown>[] = []
beforeAll(async () => {
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Heartbeat-authority actual database mismatch')
  locked = (
    await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [
      'nexus-heartbeat-authority-round74',
    ])
  ).rows[0]?.locked
  if (!locked) throw new Error('Heartbeat-authority fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Heartbeat-authority fixture has other clients')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
}, 30000)
afterAll(async () => {
  console.info('Heartbeat-authority safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked)
      await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['nexus-heartbeat-authority-round74'])
  } finally {
    owner?.release()
    await pool.end()
  }
})
type Role = 'admin' | 'developer' | 'viewer'
type Shape = 'hidden' | 'visible' | 'own' | 'local'
interface Fixture {
  tenant: string
  org: string
  actor: string
  other: string
  project: string
  connection: string
  shape: Shape
  cookie: string
  csrf: string
}
const capabilities = { operations: ['chat'], synthetic: { reported: true } }
const report = { status: 'reported', capabilities }
async function fixture(role: Role, shape: Shape): Promise<Fixture> {
  const prefix = 'heartbeat-authority-74-' + ++sequence
  const f: Fixture = {
    tenant: prefix + '-tenant',
    org: prefix + '-org',
    actor: prefix + '-actor',
    other: prefix + '-other',
    project: prefix + '-project',
    connection: prefix + '-connection',
    shape,
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.org, f.tenant])
  for (const user of [f.actor, f.other])
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      user,
      user + '@example.invalid',
      'synthetic-unused-password-hash',
    ])
  await pool.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
    f.org,
    f.tenant,
    f.actor,
    role,
  ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    f.project,
    f.tenant,
    f.org,
  ])
  await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
    f.tenant,
    f.project,
    f.actor,
  ])
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities,last_heartbeat_at)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7::jsonb,'2000-01-01')`,
    [
      f.connection,
      f.tenant,
      shape === 'own' ? f.actor : f.other,
      ['visible', 'local'].includes(shape) ? f.project : null,
      shape === 'local' ? 'ollama' : 'synthetic-heartbeat-provider',
      shape === 'local' ? 'local_sidecar' : 'external_endpoint',
      JSON.stringify({ operations: ['embeddings'], retained: true }),
    ],
  )
  await pool.query(
    `INSERT INTO request_records(id,organization_id,tenant_id,request_model,channel_kind,status,project_id,project_name,connection_id)
    VALUES($1,$2,$3,'synthetic-history-model','platform','completed',$4,'Synthetic retained history',$5)`,
    [prefix + '-historical-request', f.org, f.tenant, f.project, f.connection],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
function request(f: Fixture, value: BodyInit = JSON.stringify(report), validCSRF = true) {
  return new Request('http://localhost/api/connections/' + f.connection + '/heartbeat', {
    method: 'POST',
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      [CSRF_HEADER]: validCSRF ? f.csrf : 'mismatched-synthetic-csrf',
      'content-type': 'application/json',
    },
    body: value,
    ...(value instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
}
const params = (f: Fixture) => ({ params: Promise.resolve({ id: f.connection }) })
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'projects',
  'project_memberships',
  'owned_connections',
  'provider_credentials',
  'channels',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'request_records',
  'attempts',
  'external_observed_usage',
  'quota_snapshots',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
] as const
async function facts() {
  const value = {} as Record<(typeof tables)[number], Record<string, unknown>[]>
  for (const table of tables)
    value[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'connector_pairings' ? 'connection_id' : 'id'}`)
    ).rows
  return value
}
async function successAudits(f: Fixture) {
  return (
    await pool.query("SELECT * FROM audit_events WHERE tenant_id=$1 AND action='connection.heartbeat' ORDER BY id", [
      f.tenant,
    ])
  ).rows
}
const bodies: { pending: Promise<Response>; abort: () => void }[] = []
afterEach(async () => {
  const pending = bodies.splice(0)
  for (const item of pending) item.abort()
  expect(
    (await Promise.allSettled(pending.map((item) => item.pending))).every((item) => item.status === 'fulfilled'),
  ).toBe(true)
})
function delayed(f: Fixture) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        enter()
      },
    },
    { highWaterMark: 0 },
  )
  const req = request(f, stream)
  let complete = false
  let settled = false
  const pending = heartbeat(req, params(f)).finally(() => {
    settled = true
  })
  bodies.push({
    pending,
    abort() {
      if (!complete) {
        complete = true
        controller.error(new Error('Heartbeat fixture body closed during cleanup'))
      }
    },
  })
  return {
    pending,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Native heartbeat did not consume body after initial lookup')),
              5000,
            )
          }),
        ])
        expect([req.bodyUsed, settled]).toEqual([true, false])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    finish() {
      if (complete) throw new Error('Heartbeat body already finished')
      complete = true
      controller.enqueue(new TextEncoder().encode(JSON.stringify(report)))
      controller.close()
    },
  }
}
async function observe(
  f: Fixture,
  kind: string,
  response: Response,
  before: Awaited<ReturnType<typeof facts>>,
  auditBefore: Awaited<ReturnType<typeof successAudits>>,
) {
  const body = await response.json()
  const after = await facts()
  const auditAfter = await successAudits(f)
  const beforeConnection = before.owned_connections.find((row) => row.id === f.connection)!
  const afterConnection = after.owned_connections.find((row) => row.id === f.connection)!
  const observation = {
    kind,
    status: response.status,
    returnedConnection: body.connection !== undefined,
    connectionUnchanged: isDeepStrictEqual(afterConnection, beforeConnection),
    statusUnchanged: afterConnection.status === beforeConnection.status,
    capabilitiesUnchanged: isDeepStrictEqual(afterConnection.capabilities, beforeConnection.capabilities),
    heartbeatUnchanged: isDeepStrictEqual(afterConnection.last_heartbeat_at, beforeConnection.last_heartbeat_at),
    updatedAtUnchanged: isDeepStrictEqual(afterConnection.updated_at, beforeConnection.updated_at),
    historicalFactsUnchanged: isDeepStrictEqual(after.request_records, before.request_records),
    domainUnchanged: isDeepStrictEqual(after, before),
    successAuditsUnchanged: isDeepStrictEqual(auditAfter, auditBefore),
    successAuditDelta: auditAfter.length - auditBefore.length,
  }
  observations.push(observation)
  return { body, after, auditAfter, beforeConnection, afterConnection, observation }
}
function denied(result: Awaited<ReturnType<typeof observe>>, status: number, code: string) {
  const o = result.observation
  expect([
    o.status,
    o.returnedConnection,
    o.connectionUnchanged,
    o.statusUnchanged,
    o.capabilitiesUnchanged,
    o.heartbeatUnchanged,
    o.updatedAtUnchanged,
    o.historicalFactsUnchanged,
    o.domainUnchanged,
    o.successAuditsUnchanged,
    o.successAuditDelta,
  ]).toEqual([status, false, true, true, true, true, true, true, true, true, 0])
  expect(result.body.error.code).toBe(code)
}
function accepted(
  f: Fixture,
  result: Awaited<ReturnType<typeof observe>>,
  before: Awaited<ReturnType<typeof facts>>,
  auditsBefore: Awaited<ReturnType<typeof successAudits>>,
) {
  expect([result.observation.status, result.afterConnection.status, result.observation.successAuditDelta]).toEqual([
    200,
    'reported',
    1,
  ])
  expect(isDeepStrictEqual(result.afterConnection.capabilities, capabilities)).toBe(true)
  expect(result.afterConnection.last_heartbeat_at instanceof Date).toBe(true)
  expect(result.body.connection.id).toBe(f.connection)
  expect(result.body.connection.status).toBe('reported')
  for (const table of tables.filter((name) => name !== 'owned_connections'))
    expect(isDeepStrictEqual(result.after[table], before[table]), table + ' unchanged').toBe(true)
  expect(
    isDeepStrictEqual(
      result.after.owned_connections.filter((row) => row.id !== f.connection),
      before.owned_connections.filter((row) => row.id !== f.connection),
    ),
  ).toBe(true)
  const retained = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !['status', 'capabilities', 'last_heartbeat_at', 'updated_at'].includes(key),
      ),
    )
  expect(isDeepStrictEqual(retained(result.beforeConnection), retained(result.afterConnection))).toBe(true)
  const added = result.auditAfter.filter((row) => !auditsBefore.some((old) => old.id === row.id))
  expect(added.length).toBe(1)
  expect([
    added[0].tenant_id,
    added[0].actor_user_id,
    added[0].target_type,
    added[0].target_id,
    added[0].metadata,
  ]).toEqual([f.tenant, f.actor, 'connection', f.connection, { status: 'reported' }])
}
it.each([
  {
    from: 'admin' as const,
    to: 'developer' as const,
    shape: 'hidden' as const,
    status: 404,
    code: 'not_found',
    visible: false,
  },
  {
    from: 'developer' as const,
    to: 'viewer' as const,
    shape: 'visible' as const,
    status: 403,
    code: 'forbidden',
    visible: true,
  },
])('refuses $from->$to heartbeat during body wait for $shape', async ({ from, to, shape, status, code, visible }) => {
  const f = await fixture(from, shape)
  const pending = delayed(f)
  await pending.wait()
  expect(
    (
      await pool.query(
        'UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3 RETURNING role',
        [to, f.org, f.actor],
      )
    ).rows[0]?.role,
  ).toBe(to)
  const listed = await listConnections(
    new Request('http://localhost/api/connections', { headers: { cookie: f.cookie } }),
  )
  expect(listed.status).toBe(200)
  expect((await listed.json()).connections.some((row: { id: string }) => row.id === f.connection)).toBe(visible)
  const beforeFresh = await facts()
  const auditBeforeFresh = await successAudits(f)
  const freshRequest = request(f)
  denied(
    await observe(
      f,
      'fresh-' + to + '-' + shape,
      await heartbeat(freshRequest, params(f)),
      beforeFresh,
      auditBeforeFresh,
    ),
    status,
    code,
  )
  expect(freshRequest.bodyUsed).toBe(false)
  const before = await facts()
  const auditBefore = await successAudits(f)
  pending.finish()
  denied(
    await observe(f, 'delayed-' + from + '-' + to + '-' + shape, await pending.pending, before, auditBefore),
    status,
    code,
  )
})
it.each([
  { from: 'admin' as const, to: 'admin' as const, shape: 'hidden' as const },
  { from: 'developer' as const, to: 'developer' as const, shape: 'visible' as const },
  { from: 'admin' as const, to: 'developer' as const, shape: 'visible' as const },
  { from: 'admin' as const, to: 'developer' as const, shape: 'own' as const },
])('control: authorized $from->$to retains $shape heartbeat', async ({ from, to, shape }) => {
  const f = await fixture(from, shape)
  const pending = delayed(f)
  await pending.wait()
  if (from !== to)
    expect(
      (
        await pool.query(
          'UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3 RETURNING role',
          [to, f.org, f.actor],
        )
      ).rows[0]?.role,
    ).toBe(to)
  const before = await facts()
  const auditBefore = await successAudits(f)
  pending.finish()
  accepted(
    f,
    await observe(f, 'allowed-' + from + '-' + to + '-' + shape, await pending.pending, before, auditBefore),
    before,
    auditBefore,
  )
})
it.each([
  { role: 'viewer' as const, shape: 'visible' as const, status: 403, code: 'forbidden' },
  { role: 'developer' as const, shape: 'hidden' as const, status: 404, code: 'not_found' },
  { role: 'admin' as const, shape: 'local' as const, status: 403, code: 'connector_identity_required' },
])('control: fresh $role/$shape denial remains', async ({ role, shape, status, code }) => {
  const f = await fixture(role, shape)
  const before = await facts()
  const auditBefore = await successAudits(f)
  denied(
    await observe(
      f,
      'fresh-control-' + role + '-' + shape,
      await heartbeat(request(f), params(f)),
      before,
      auditBefore,
    ),
    status,
    code,
  )
})
it('control: CSRF rejects before body or metadata change', async () => {
  const f = await fixture('developer', 'visible')
  const before = await facts()
  const auditBefore = await successAudits(f)
  const req = request(f, JSON.stringify(report), false)
  denied(await observe(f, 'csrf-control', await heartbeat(req, params(f)), before, auditBefore), 403, 'csrf_failed')
  expect(req.bodyUsed).toBe(false)
})
