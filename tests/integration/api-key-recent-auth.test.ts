import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { issueCsrfToken, CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf'
import { getRevocationEpoch } from '@/lib/auth/api-keys'
import { PATCH as patchKey, DELETE as revokeKey } from '@/app/api/keys/[id]/route'
import { GET as readProject } from '@/app/api/projects/[id]/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable Key mutation-authority database required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid Key mutation-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_access_key_recent_auth_round81', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact Key mutation-authority loopback fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-recent-auth-round81'
let owner: PoolClient | undefined
let locked = false
let sequence = 0
const observations: Record<string, unknown>[] = []

async function bounded<T>(promise: Promise<T>, label: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
async function until<T>(read: () => Promise<T | undefined>, label: string, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(label)
}
beforeAll(async () => {
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Actual Key mutation-authority database mismatch')
  locked = (await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [fixtureLock])).rows[0]
    ?.locked
  if (!locked) throw new Error('Key mutation-authority fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Key mutation-authority fixture has other clients')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
}, 30000)
afterAll(async () => {
  if (process.env.NEXUS_KEY_MUTATION_AUTHORITY_REPORT === '1')
    console.info('Key mutation-authority safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [fixtureLock])
  } finally {
    owner?.release()
    await bounded(pool.end(), 'Key mutation-authority fixture pool close timeout')
  }
})

type Operation = 'disable' | 'revoke'
interface Fixture {
  tenant: string
  org: string
  actor: string
  project: string
  key: string
  historyKey: string
  cookie: string
  csrf: string
}
async function fixture(): Promise<Fixture> {
  const prefix = 'key-recent-auth81-' + ++sequence
  const f = {
    tenant: prefix + '-tenant',
    org: prefix + '-org',
    actor: prefix + '-actor',
    project: prefix + '-project',
    key: randomUUID(),
    historyKey: randomUUID(),
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.org, f.tenant])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    f.actor,
    f.actor + '@example.invalid',
    'synthetic-unused-password',
  ])
  await pool.query(
    "INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,'developer')",
    [f.org, f.tenant, f.actor],
  )
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
  for (const id of [f.key, f.historyKey])
    await pool.query(
      `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,project_id,created_by)
      VALUES($1,$2,$3,'Synthetic mutation fixture',$4,'fixture','["models:read"]',$5,$6)`,
      [
        id,
        f.org,
        f.tenant,
        createHash('sha256')
          .update('synthetic-key-authority77:' + id)
          .digest('hex'),
        f.project,
        f.actor,
      ],
    )
  await pool.query(
    `INSERT INTO request_records(id,organization_id,tenant_id,request_model,channel_kind,status,project_id,project_name)
    VALUES($1,$2,$3,'synthetic-history-model','platform','completed',$4,'Synthetic retained history')`,
    [prefix + '-history', f.org, f.tenant, f.project],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
function request(f: Fixture, operation: Operation) {
  return new Request('http://localhost/api/keys/' + f.key, {
    method: operation === 'revoke' ? 'DELETE' : 'PATCH',
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      [CSRF_HEADER]: f.csrf,
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    ...(operation === 'disable' ? { body: JSON.stringify({ enabled: false }) } : {}),
  })
}
function invoke(f: Fixture, operation: Operation) {
  const req = request(f, operation)
  return operation === 'disable' ? patchKey(req, params(f.key)) : revokeKey(req, params(f.key))
}
const tables = [
  'organizations',
  'users',
  'sessions',
  'projects',
  'project_workspace_roots',
  'downstream_api_keys',
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
  'audit_events',
] as const
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables) {
    const order =
      table === 'connector_pairings'
        ? 'connection_id'
        : table === 'project_workspace_roots'
          ? 'tenant_id,organization_id,root'
          : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
async function observe(
  f: Fixture,
  kind: string,
  operation: Operation,
  response: Response,
  before: Facts,
  epoch: number,
  ordering?: string,
) {
  const body = await response.json()
  const after = await facts()
  const rowBefore = before.downstream_api_keys.find((row) => row.id === f.key)!
  const rowAfter = after.downstream_api_keys.find((row) => row.id === f.key)!
  const observation = {
    kind,
    operation,
    ordering: ordering ?? null,
    status: response.status,
    returnedSuccess: body.id === f.key && (body.enabled === false || body.revoked === true),
    returnedToken: typeof body.token === 'string',
    completeBusinessFactsUnchanged: isDeepStrictEqual(after, before),
    keyUnchanged: isDeepStrictEqual(rowAfter, rowBefore),
    auditsUnchanged: isDeepStrictEqual(after.audit_events, before.audit_events),
    outboxUnchanged: isDeepStrictEqual(after.outbox_events, before.outbox_events),
    historyUnchanged: isDeepStrictEqual(after.request_records, before.request_records),
    historicalKeyUnchanged: isDeepStrictEqual(
      after.downstream_api_keys.find((row) => row.id === f.historyKey),
      before.downstream_api_keys.find((row) => row.id === f.historyKey),
    ),
    cacheEpochDelta: getRevocationEpoch() - epoch,
  }
  observations.push(observation)
  return { body, after, rowBefore, rowAfter, observation }
}
function accepted(
  f: Fixture,
  operation: Operation,
  result: Awaited<ReturnType<typeof observe>>,
  before: Facts,
  epoch: number,
) {
  expect([
    result.observation.status,
    result.observation.returnedSuccess,
    result.observation.returnedToken,
    result.observation.historyUnchanged,
    result.observation.historicalKeyUnchanged,
    result.observation.cacheEpochDelta,
  ]).toEqual([200, true, false, true, true, 1])
  expect(result.rowAfter.enabled).toBe(false)
  expect(
    operation === 'revoke' ? result.rowAfter.revoked_at instanceof Date : result.rowAfter.revoked_at === null,
  ).toBe(true)
  const immutable = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !['enabled', 'revoked_at'].includes(key)))
  same(immutable(result.rowAfter), immutable(result.rowBefore), 'Only the existing Key lifecycle fields change')
  same(
    result.after.downstream_api_keys.filter((row) => row.id !== f.key),
    before.downstream_api_keys.filter((row) => row.id !== f.key),
    'All other Keys remain unchanged',
  )
  const addedAudits = result.after.audit_events.filter((row) => !before.audit_events.some((old) => old.id === row.id))
  expect(addedAudits.length).toBe(1)
  const audit = addedAudits[0]
  expect([audit.action, audit.actor_user_id, audit.tenant_id, audit.target_type, audit.target_id]).toEqual([
    operation === 'revoke' ? 'apikey.revoked' : 'apikey.disabled',
    f.actor,
    f.tenant,
    'downstream_api_key',
    f.key,
  ])
  same(
    audit.metadata,
    operation === 'revoke' ? { revocationEpoch: epoch + 1 } : { ip: '127.0.0.1' },
    'Existing lifecycle audit metadata remains exact',
  )
  same(
    result.after.audit_events.filter((row) => row.id !== audit.id),
    before.audit_events,
    'All previous audits remain unchanged',
  )
  const addedOutbox = result.after.outbox_events.filter((row) => !before.outbox_events.some((old) => old.id === row.id))
  expect(addedOutbox.length).toBe(operation === 'revoke' ? 1 : 0)
  if (operation === 'revoke') {
    const event = addedOutbox[0]
    expect(event.aggregate_id === f.key && event.event_type === 'api_key.revoked' && event.tenant_id === f.tenant).toBe(
      true,
    )
    same(
      event.payload,
      { keyId: f.key, revocationEpoch: epoch + 1 },
      'Existing revocation outbox payload remains exact',
    )
  }
  same(
    result.after.outbox_events.filter((row) => !addedOutbox.some((added) => added.id === row.id)),
    before.outbox_events,
    'All previous outbox events remain unchanged',
  )
  for (const table of tables.filter((name) => !['downstream_api_keys', 'audit_events', 'outbox_events'].includes(name)))
    same(result.after[table], before[table], table + ' unchanged')
}
async function realBlockedAction(gatePid: number) {
  return until(async () => {
    const rows = await pool.query(
      `SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND state='active' AND pid<>$1
      AND query ILIKE '%downstream_api_keys%' AND $1=ANY(pg_blocking_pids(pid))`,
      [gatePid],
    )
    if (rows.rows.length === 1) return rows.rows[0].pid as number
    return undefined
  }, 'Actual Key lifecycle statement must wait on the fixture Key row lock')
}

async function recentGate(operation: Operation, aged: boolean, resource: 'key' | 'project' = 'key') {
  const f = await fixture()
  let createdAt: Date | undefined
  if (aged)
    createdAt = (
      await pool.query(
        "UPDATE sessions SET created_at=clock_timestamp()-interval '15 minutes'+interval '8 seconds' WHERE user_id=$1 RETURNING created_at",
        [f.actor],
      )
    ).rows[0].created_at as Date
  const gate = await pool.connect()
  let open = false,
    pending: Promise<Response> | undefined
  try {
    await gate.query('BEGIN')
    open = true
    expect(
      (
        await gate.query(
          resource === 'key'
            ? 'SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE'
            : 'SELECT id FROM projects WHERE id=$1 FOR UPDATE',
          [resource === 'key' ? f.key : f.project],
        )
      ).rowCount,
    ).toBe(1)
    const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    pending = invoke(f, operation)
    if (resource === 'key') await realBlockedAction(gatePid)
    else
      await until(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND query ~* 'FROM[[:space:]]+projects' AND query ~* 'FOR[[:space:]]+SHARE'
        AND $1=ANY(pg_blocking_pids(pid))`,
            [gatePid],
          )
        ).rows
        return rows.length === 1 ? true : undefined
      }, 'Actual recent-auth DELETE must wait at the transaction project scope guard')
    if (aged) {
      await until(
        async () => {
          const old = (
            await owner!.query(
              'SELECT extract(epoch FROM clock_timestamp()-created_at)>901 old FROM sessions WHERE user_id=$1',
              [f.actor],
            )
          ).rows[0]?.old
          return old && Math.floor((Date.now() - createdAt!.getTime()) / 1000) > 900 ? true : undefined
        },
        'Actual locked session must naturally cross existing15-minute recent-auth window',
        12000,
      )
      const project = await readProject(
        new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
        params(f.project),
      )
      expect(project.status).toBe(200)
      const beforeFresh = await facts(),
        freshEpoch = getRevocationEpoch()
      const fresh = await bounded(invoke(f, 'revoke'), 'Fresh aged DELETE must reject before fixture Key gate')
      const body = await fresh.json()
      expect([fresh.status, body.error?.code]).toEqual([401, 'forbidden'])
      same(await facts(), beforeFresh, 'Fresh recent-auth refusal leaves every fact unchanged')
      expect(getRevocationEpoch()).toBe(freshEpoch)
    }
    const before = await facts(),
      epoch = getRevocationEpoch()
    await gate.query('COMMIT')
    open = false
    const response = await bounded(pending, 'Actual Key operation must settle after recent-auth gate release')
    const result = await observe(
      f,
      aged ? 'crossed-recent-auth-window' : 'healthy-recent-auth',
      operation,
      response,
      before,
      epoch,
    )
    if (aged && operation === 'revoke') {
      expect([
        result.observation.status,
        result.body.error?.code,
        result.observation.returnedSuccess,
        result.observation.returnedToken,
        result.observation.completeBusinessFactsUnchanged,
        result.observation.cacheEpochDelta,
      ]).toEqual([401, 'forbidden', false, false, true, 0])
    } else accepted(f, operation, result, before, epoch)
  } finally {
    try {
      if (open) await gate.query('ROLLBACK')
    } finally {
      gate.release()
      if (pending) await bounded(pending, 'Recent-auth request cleanup must settle')
    }
  }
}
it('withdrawal aged-recent-auth: row-blocked DELETE must deny after actual window crossing', async () => {
  await recentGate('revoke', true)
}, 20000)
it('control: healthy recent session retains exact DELETE lifecycle effects', async () => {
  await recentGate('revoke', false)
})
it('control: aged current session retains ordinary PATCH without high-risk freshness requirement', async () => {
  await recentGate('disable', true)
}, 20000)

it('denies recent-auth window crossing during actual project guard wait', async () => {
  await recentGate('revoke', true, 'project')
}, 20000)
