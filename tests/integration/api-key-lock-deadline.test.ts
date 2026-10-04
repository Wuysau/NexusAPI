import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, revokeSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { issueCsrfToken, CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf'
import { getRevocationEpoch } from '@/lib/auth/api-keys'
import { PATCH as patchKey, DELETE as revokeKey } from '@/app/api/keys/[id]/route'
import { requireContext } from '@/app/api/_lib/control-plane'
import { lockManagedApiKey } from '@/lib/workspace/api-key-access'
import { POST as createKey } from '@/app/api/keys/route'
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
  !['/workspace_access_key_lock_deadline_round82', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact Key mutation-authority loopback fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-lock-deadline-aligned-round82'
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
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const end = Date.now() + 5000
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
  const prefix = 'key-lock-deadline82-' + ++sequence
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

type KeyOperation = Operation | 'create'
function invokeAny(f: Fixture, operation: KeyOperation) {
  if (operation !== 'create') return invoke(f, operation)
  return createKey(
    new Request('http://localhost/api/keys', {
      method: 'POST',
      headers: {
        cookie: f.cookie + '; ' + CSRF_COOKIE + '=' + f.csrf,
        [CSRF_HEADER]: f.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: f.actor + '-issued', projectId: f.project }),
    }),
  )
}
async function deadline(operation: KeyOperation, blocked: boolean) {
  const f = await fixture(),
    gate = await pool.connect()
  let open = false,
    pending: Promise<Response> | undefined,
    revoking: Promise<boolean> | undefined
  try {
    await gate.query('BEGIN')
    open = true
    if (blocked)
      await gate.query(
        operation === 'create'
          ? 'SELECT id FROM projects WHERE id=$1 FOR UPDATE'
          : 'SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE',
        [operation === 'create' ? f.project : f.key],
      )
    const before = await facts(),
      epoch = getRevocationEpoch(),
      gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    pending = invokeAny(f, operation)
    if (blocked) {
      const actionPid = await until(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND $1=ANY(pg_blocking_pids(pid)) AND (query ILIKE '%downstream_api_keys%' OR query ILIKE '%FROM projects%')`,
            [gatePid],
          )
        ).rows
        return rows.length === 1 ? (rows[0].pid as number) : undefined
      }, 'Actual Key request must wait on the resource lock after actor and session acquisition')
      revoking = revokeSession(f.cookie.slice(SESSION_COOKIE.length + 1))
      void revoking.catch(() => {})
      await until(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND query ~* 'UPDATE[[:space:]]+sessions' AND $1=ANY(pg_blocking_pids(pid))`,
            [actionPid],
          )
        ).rows
        return rows.length === 1 ? true : undefined
      }, 'Actual user-session revocation must be blocked by the resource-waiting Key request')
      const response = await bounded(
        pending,
        'Key resource lock deadline must release the request and session revocation before12 seconds',
        12000,
      )
      const body = await response.json()
      expect([response.status, body.error?.code]).toEqual([503, 'key_resource_busy'])
      expect(!body.token && !body.id).toBe(true)
      expect(await bounded(revoking, 'Session revocation must finish after lock deadline', 1500)).toBe(true)
      const after = await facts()
      same(
        after.downstream_api_keys,
        before.downstream_api_keys,
        'Bounded waiting request cannot mutate or create Keys',
      )
      same(after.outbox_events, before.outbox_events, 'Bounded waiting cannot publish revocation outbox')
      const keyAudits = after.audit_events.filter((row) => String(row.action).startsWith('apikey.'))
      same(
        keyAudits,
        before.audit_events.filter((row) => String(row.action).startsWith('apikey.')),
        'No successful Key audit on lock deadline',
      )
      expect(getRevocationEpoch()).toBe(epoch)
      for (const table of tables.filter((name) => !['sessions', 'audit_events'].includes(name)))
        same(after[table], before[table], table + ' unchanged on deadline')
      observations.push({
        kind: 'resource-lock-deadline',
        operation,
        status: response.status,
        sessionRevocationCompleted: true,
        keyUnchanged: true,
        cacheEpochDelta: 0,
      })
    } else {
      const response = await bounded(pending, 'Uncontended Key operation must retain normal behavior')
      if (operation === 'create') {
        const body = await response.json()
        expect(response.status).toBe(201)
        expect(typeof body.token === 'string' && body.key?.projectId === f.project).toBe(true)
      } else
        accepted(
          f,
          operation,
          await observe(f, 'uncontended-lock-control', operation, response, before, epoch),
          before,
          epoch,
        )
    }
  } finally {
    try {
      if (open) await gate.query('ROLLBACK')
    } finally {
      gate.release()
      if (pending) await bounded(pending, 'Deadline request cleanup must settle')
      if (revoking) await bounded(revoking, 'Actual revokeSession cleanup must settle')
    }
  }
}
it.each(['disable', 'revoke', 'create'] as const)(
  'withdrawal resource-lock deadline: %s must release current session revocation',
  async (operation) => {
    await deadline(operation, true)
  },
  20000,
)
it.each(['disable', 'revoke', 'create'] as const)(
  'control: uncontended %s retains existing lifecycle',
  async (operation) => {
    await deadline(operation, false)
  },
)

it.each([
  { setting: '0', expected: '10s', ending: 'ROLLBACK' },
  { setting: '100ms', expected: '100ms', ending: 'ROLLBACK' },
  { setting: '1min', expected: '10s', ending: 'ROLLBACK' },
  { setting: '1min', expected: '10s', ending: 'COMMIT' },
])(
  'caps existing $setting lock timeout without leaking settings after $ending',
  async ({ setting, expected, ending }) => {
    const f = await fixture(),
      ctx = await requireContext(request(f, 'disable'), 'apikey:revoke'),
      client = await pool.connect()
    const previous = (await client.query("SELECT current_setting('lock_timeout') setting")).rows[0].setting as string
    let open = false
    try {
      await client.query("SELECT set_config('lock_timeout',$1,false)", [setting])
      const original = (await client.query("SELECT current_setting('lock_timeout') setting")).rows[0].setting
      await client.query('BEGIN')
      open = true
      await lockManagedApiKey(client, ctx, f.key)
      expect((await client.query("SELECT current_setting('lock_timeout') setting")).rows[0].setting).toBe(expected)
      await client.query(ending)
      open = false
      expect((await client.query("SELECT current_setting('lock_timeout') setting")).rows[0].setting).toBe(original)
    } finally {
      try {
        if (open) await client.query('ROLLBACK')
      } finally {
        try {
          await client.query("SELECT set_config('lock_timeout',$1,false)", [previous])
        } finally {
          client.release()
        }
      }
    }
  },
)

it.each(['disable', 'revoke'] as const)(
  'hidden project %s retains404 even while the Key row is held',
  async (operation) => {
    const f = await fixture()
    expect(
      (
        await pool.query('DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2 RETURNING id', [
          f.project,
          f.actor,
        ])
      ).rowCount,
    ).toBe(1)
    const hidden = await readProject(
      new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
      params(f.project),
    )
    expect(hidden.status).toBe(404)
    const before = await facts(),
      epoch = getRevocationEpoch(),
      gate = await pool.connect()
    let open = false,
      pending: Promise<Response> | undefined
    try {
      await gate.query('BEGIN')
      open = true
      await gate.query('SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE', [f.key])
      pending = invoke(f, operation)
      const response = await bounded(pending, 'Hidden Key must retain scope refusal while its row remains held', 12000)
      expect(response.status).toBe(404)
      expect((await response.json()).error?.code).toBe('not_found')
      same(await facts(), before, 'Hidden resource refusal preserves every persisted fact')
      expect(getRevocationEpoch()).toBe(epoch)
    } finally {
      try {
        if (open) await gate.query('ROLLBACK')
      } finally {
        gate.release()
        if (pending) await bounded(pending, 'Hidden scope request cleanup must settle')
      }
    }
  },
  20000,
)
