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
  !['/workspace_access_key_mutation_authority_round77', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact Key mutation-authority loopback fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-mutation-authority-round77'
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
type Withdrawal = 'project-membership' | 'organization-role'
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
  const prefix = 'key-mutation-authority77-' + ++sequence
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
async function withdraw(db: Pick<PoolClient, 'query'>, f: Fixture, withdrawal: Withdrawal) {
  if (withdrawal === 'project-membership') {
    const result = await db.query(
      'DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 RETURNING user_id',
      [f.tenant, f.project, f.actor],
    )
    expect(result.rowCount).toBe(1)
  } else {
    const result = await db.query(
      "UPDATE organization_memberships SET role='viewer' WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3 RETURNING role",
      [f.tenant, f.org, f.actor],
    )
    expect(result.rows[0]?.role).toBe('viewer')
  }
}
async function projectOracle(f: Fixture, withdrawal: Withdrawal) {
  const response = await readProject(
    new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
    params(f.project),
  )
  expect(response.status).toBe(withdrawal === 'project-membership' ? 404 : 200)
  const body = await response.json()
  if (withdrawal === 'organization-role') expect(body.project?.id === f.project).toBe(true)
  const membership = await pool.query(
    'SELECT count(*)::int n FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3',
    [f.tenant, f.project, f.actor],
  )
  expect(membership.rows[0]?.n).toBe(withdrawal === 'project-membership' ? 0 : 1)
  const role = await pool.query(
    'SELECT role FROM organization_memberships WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3',
    [f.tenant, f.org, f.actor],
  )
  expect(role.rows[0]?.role).toBe(withdrawal === 'project-membership' ? 'developer' : 'viewer')
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
function denied(result: Awaited<ReturnType<typeof observe>>, withdrawal: Withdrawal) {
  const o = result.observation
  expect([
    o.status,
    o.returnedSuccess,
    o.returnedToken,
    o.completeBusinessFactsUnchanged,
    o.keyUnchanged,
    o.auditsUnchanged,
    o.outboxUnchanged,
    o.historyUnchanged,
    o.historicalKeyUnchanged,
    o.cacheEpochDelta,
  ]).toEqual([withdrawal === 'project-membership' ? 404 : 403, false, false, true, true, true, true, true, true, 0])
  expect(result.body.error?.code).toBe(withdrawal === 'project-membership' ? 'not_found' : 'forbidden')
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
async function gated(operation: Operation, withdrawal?: Withdrawal) {
  const f = await fixture()
  const gate = await pool.connect()
  let gateOpen = false
  let pending: Promise<Response> | undefined
  let authorityClient: PoolClient | undefined
  let authorityPending: Promise<void> | undefined
  let authorityCommitted = false
  try {
    await gate.query('BEGIN')
    gateOpen = true
    expect((await gate.query('SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE', [f.key])).rowCount).toBe(1)
    const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    pending = invoke(f, operation)
    const actionPid = await realBlockedAction(gatePid)
    let ordering = 'unchanged-authority'
    if (withdrawal) {
      authorityClient = await pool.connect()
      const writerPid = (await authorityClient.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      authorityPending = withdraw(authorityClient, f, withdrawal).then(() => {
        authorityCommitted = true
      })
      ordering = await until(async () => {
        if (authorityCommitted) return 'withdrawal-committed-before-key-release'
        const blocked = (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) held', [actionPid, writerPid])).rows[0]
          ?.held
        if (blocked) return 'authority-held-by-earlier-action'
        return undefined
      }, 'Authority withdrawal must commit or be visibly blocked by the earlier native action')
      if (ordering === 'withdrawal-committed-before-key-release') {
        await projectOracle(f, withdrawal)
      } else {
        expect(authorityCommitted, 'Pinned earlier authority keeps withdrawal uncommitted').toBe(false)
      }
    }
    const before = await facts()
    const epoch = getRevocationEpoch()
    await gate.query('COMMIT')
    gateOpen = false
    const response = await bounded(pending, 'Native gated Key mutation must finish')
    if (authorityPending) await bounded(authorityPending, 'Authority withdrawal must finish after Key release')
    const result = await observe(f, 'gated-' + (withdrawal ?? 'healthy'), operation, response, before, epoch, ordering)
    if (withdrawal) await projectOracle(f, withdrawal)
    if (withdrawal && ordering === 'withdrawal-committed-before-key-release') denied(result, withdrawal)
    else accepted(f, operation, result, before, epoch)
  } finally {
    try {
      if (gateOpen) await gate.query('ROLLBACK')
    } finally {
      gate.release()
      try {
        if (pending) await bounded(pending, 'Gated Key response cleanup must finish')
      } finally {
        try {
          if (authorityPending) await bounded(authorityPending, 'Authority withdrawal cleanup must finish')
        } finally {
          authorityClient?.release()
        }
      }
    }
  }
}
const operations = ['disable', 'revoke'] as const
const withdrawals = ['project-membership', 'organization-role'] as const
it.each(withdrawals.flatMap((withdrawal) => operations.map((operation) => ({ withdrawal, operation }))))(
  'orders $operation against $withdrawal withdrawal while native Key mutation is row-blocked',
  async ({ withdrawal, operation }) => {
    await gated(operation, withdrawal)
  },
)
it.each(operations)('control: current developer retains healthy gated %s', async (operation) => {
  await gated(operation)
})
it.each(withdrawals.flatMap((withdrawal) => operations.map((operation) => ({ withdrawal, operation }))))(
  'control: fresh $operation after $withdrawal withdrawal preserves all business facts',
  async ({ withdrawal, operation }) => {
    const f = await fixture()
    await withdraw(pool, f, withdrawal)
    await projectOracle(f, withdrawal)
    const before = await facts(),
      epoch = getRevocationEpoch()
    denied(
      await observe(f, 'fresh-control-' + withdrawal, operation, await invoke(f, operation), before, epoch),
      withdrawal,
    )
  },
)

it.each(['archived', 'inactive'] as const)(
  'compatibility: preserves both Key mutations for a member of an %s project',
  async (status) => {
    for (const operation of operations) {
      const f = await fixture()
      await pool.query(
        "UPDATE projects SET status=$1,archived_at=CASE WHEN $1='archived' THEN now() ELSE NULL END WHERE id=$2",
        [status, f.project],
      )
      const before = await facts(),
        epoch = getRevocationEpoch()
      accepted(
        f,
        operation,
        await observe(f, 'compatibility-' + status, operation, await invoke(f, operation), before, epoch),
        before,
        epoch,
      )
    }
  },
)
it.each(['own-unbound', 'admin-other-unbound'] as const)(
  'compatibility: preserves both Key mutations for %s authority',
  async (shape) => {
    for (const operation of operations) {
      const f = await fixture()
      if (shape === 'admin-other-unbound') {
        const other = f.actor + '-other'
        await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
          other,
          other + '@example.invalid',
          'synthetic-unused-password',
        ])
        await pool.query("UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [
          f.org,
          f.actor,
        ])
        await pool.query('UPDATE downstream_api_keys SET created_by=$1 WHERE id=$2', [other, f.key])
      }
      await pool.query('UPDATE downstream_api_keys SET project_id=NULL WHERE id=$1', [f.key])
      const before = await facts(),
        epoch = getRevocationEpoch()
      accepted(
        f,
        operation,
        await observe(f, 'compatibility-' + shape, operation, await invoke(f, operation), before, epoch),
        before,
        epoch,
      )
    }
  },
)
it('compatibility: PATCH of a revoked Key remains a side-effect-free404', async () => {
  const f = await fixture()
  await pool.query("UPDATE downstream_api_keys SET enabled=false,revoked_at='2000-01-01' WHERE id=$1", [f.key])
  const before = await facts(),
    epoch = getRevocationEpoch()
  denied(
    await observe(f, 'compatibility-revoked-PATCH', 'disable', await invoke(f, 'disable'), before, epoch),
    'project-membership',
  )
})
it('compatibility: repeat DELETE retains success, new audit and existing idempotent outbox', async () => {
  const f = await fixture()
  const firstBefore = await facts(),
    firstEpoch = getRevocationEpoch()
  accepted(
    f,
    'revoke',
    await observe(f, 'compatibility-first-DELETE', 'revoke', await invoke(f, 'revoke'), firstBefore, firstEpoch),
    firstBefore,
    firstEpoch,
  )
  const before = await facts(),
    epoch = getRevocationEpoch()
  const result = await observe(f, 'compatibility-repeat-DELETE', 'revoke', await invoke(f, 'revoke'), before, epoch)
  expect(result.observation.status).toBe(200)
  expect(result.body).toEqual({ id: f.key, revoked: true })
  expect(getRevocationEpoch()).toBe(epoch + 1)
  expect(result.rowAfter.enabled).toBe(false)
  expect(
    result.rowAfter.revoked_at instanceof Date &&
      (result.rowAfter.revoked_at as Date).getTime() >= (result.rowBefore.revoked_at as Date).getTime(),
  ).toBe(true)
  const immutable = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'revoked_at'))
  same(
    immutable(result.rowAfter),
    immutable(result.rowBefore),
    'Repeat DELETE preserves every other existing Key field',
  )
  same(
    result.after.downstream_api_keys.filter((row) => row.id !== f.key),
    before.downstream_api_keys.filter((row) => row.id !== f.key),
    'Repeat DELETE preserves all other Keys',
  )
  same(result.after.outbox_events, before.outbox_events, 'Repeat DELETE retains the existing idempotent outbox')
  const added = result.after.audit_events.filter((row) => !before.audit_events.some((old) => old.id === row.id))
  expect(added.length).toBe(1)
  expect(
    added[0].action === 'apikey.revoked' && added[0].actor_user_id === f.actor && added[0].target_id === f.key,
  ).toBe(true)
  same(added[0].metadata, { revocationEpoch: epoch + 1 }, 'Repeat DELETE records its existing new epoch in one audit')
  same(
    result.after.audit_events.filter((row) => row.id !== added[0].id),
    before.audit_events,
    'Repeat DELETE preserves previous audits',
  )
  for (const table of tables.filter((name) => !['downstream_api_keys', 'audit_events', 'outbox_events'].includes(name)))
    same(result.after[table], before[table], table + ' unchanged after repeat DELETE')
})
it.each(operations)(
  'compatibility: current promotion to admin remains valid for gated %s after project membership removal',
  async (operation) => {
    const f = await fixture()
    const gate = await pool.connect()
    let gateOpen = false,
      pending: Promise<Response> | undefined
    try {
      await gate.query('BEGIN')
      gateOpen = true
      await gate.query('SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE', [f.key])
      const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      pending = invoke(f, operation)
      await realBlockedAction(gatePid)
      expect(
        (
          await pool.query(
            "UPDATE organization_memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2 RETURNING role",
            [f.org, f.actor],
          )
        ).rows[0]?.role,
      ).toBe('admin')
      expect(
        (
          await pool.query(
            'DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 RETURNING id',
            [f.tenant, f.project, f.actor],
          )
        ).rowCount,
      ).toBe(1)
      const project = await readProject(
        new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
        params(f.project),
      )
      expect(project.status).toBe(200)
      const before = await facts(),
        epoch = getRevocationEpoch()
      await gate.query('COMMIT')
      gateOpen = false
      accepted(
        f,
        operation,
        await observe(
          f,
          'compatibility-current-admin-after-key-wait',
          operation,
          await bounded(pending, 'Promoted administrator mutation must complete'),
          before,
          epoch,
          'promotion-committed-before-key-release',
        ),
        before,
        epoch,
      )
    } finally {
      try {
        if (gateOpen) await gate.query('ROLLBACK')
      } finally {
        gate.release()
        if (pending) await bounded(pending, 'Promoted administrator request cleanup must complete')
      }
    }
  },
)

const commitGate = 777077
async function installCommitGate(f: Fixture, rejectCommit: boolean) {
  await pool.query(`CREATE FUNCTION key_mutation77_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id=TG_ARGV[0] THEN
      PERFORM pg_advisory_xact_lock(${commitGate});
      IF TG_ARGV[1]='reject' THEN RAISE EXCEPTION 'synthetic Key commit unavailable'; END IF;
    END IF; RETURN NEW; END $$`)
  // Constraint triggers execute at the actual COMMIT after the mutation and its authority locks.
  expect(/^[0-9a-f-]{36}$/.test(f.key)).toBe(true)
  await pool.query(`CREATE CONSTRAINT TRIGGER key_mutation77_commit_guard AFTER UPDATE ON downstream_api_keys
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION key_mutation77_commit_guard('${f.key}','${rejectCommit ? 'reject' : 'accept'}')`)
}
async function dropCommitGate() {
  await pool.query(
    'DROP TRIGGER IF EXISTS key_mutation77_commit_guard ON downstream_api_keys; DROP FUNCTION IF EXISTS key_mutation77_commit_guard()',
  )
}
async function commitBlockedAction(gatePid: number) {
  return until(async () => {
    const rows = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND upper(trim(query))='COMMIT' AND $1=ANY(pg_blocking_pids(pid))",
      [gatePid],
    )
    return rows.rows.length === 1 ? (rows.rows[0].pid as number) : undefined
  }, 'Actual native Key COMMIT must wait on the deferred fixture trigger')
}
async function commitBoundary(operation: Operation, withdrawal?: Withdrawal) {
  const f = await fixture()
  const before = await facts(),
    epoch = getRevocationEpoch()
  let gate: PoolClient | undefined,
    gateLocked = false,
    pending: Promise<Response> | undefined
  let authorityClient: PoolClient | undefined,
    authorityPending: Promise<void> | undefined,
    authorityCommitted = false
  try {
    await installCommitGate(f, !withdrawal)
    gate = await pool.connect()
    await gate.query('SELECT pg_advisory_lock($1::bigint)', [commitGate])
    gateLocked = true
    const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    pending = invoke(f, operation)
    const actionPid = await commitBlockedAction(gatePid)
    same(
      await facts(),
      before,
      'Uncommitted Key mutation, audit, outbox and history remain invisible while actual COMMIT waits',
    )
    expect(getRevocationEpoch(), 'Cache epoch cannot advance before actual COMMIT').toBe(epoch)
    if (withdrawal) {
      authorityClient = await pool.connect()
      const writerPid = (await authorityClient.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      authorityPending = withdraw(authorityClient, f, withdrawal).then(() => {
        authorityCommitted = true
      })
      await until(
        async () =>
          (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) held', [actionPid, writerPid])).rows[0]?.held
            ? true
            : undefined,
        'Authority withdrawal must be blocked by the legal in-flight mutation through its actual COMMIT',
      )
      expect(authorityCommitted).toBe(false)
      same(await facts(), before, 'Pending authority withdrawal changes no visible business facts')
      expect(getRevocationEpoch()).toBe(epoch)
    }
    await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
    gateLocked = false
    const response = await bounded(pending, 'Commit-gated native Key mutation must complete')
    if (authorityPending)
      await bounded(authorityPending, 'Withdrawal must finish after the authorized mutation commits')
    const result = await observe(
      f,
      withdrawal ? 'commit-held-authority-' + withdrawal : 'commit-failure',
      operation,
      response,
      before,
      epoch,
      withdrawal ? 'authority-held-through-actual-commit' : 'deferred-commit-rejected',
    )
    if (withdrawal) {
      accepted(f, operation, result, before, epoch)
      expect(authorityCommitted).toBe(true)
      await projectOracle(f, withdrawal)
    } else {
      expect([
        result.observation.status,
        result.observation.returnedSuccess,
        result.observation.returnedToken,
        result.observation.completeBusinessFactsUnchanged,
        result.observation.cacheEpochDelta,
      ]).toEqual([500, false, false, true, 0])
      expect(result.body.error?.code).toBe('internal_error')
    }
  } finally {
    try {
      if (gate && gateLocked) await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
    } finally {
      gate?.release()
      try {
        if (pending) await bounded(pending, 'Commit-gated native request cleanup must complete')
      } finally {
        try {
          if (authorityPending) await bounded(authorityPending, 'Commit-gated authority writer cleanup must complete')
        } finally {
          authorityClient?.release()
          await dropCommitGate()
        }
      }
    }
  }
}
it.each(withdrawals.flatMap((withdrawal) => operations.map((operation) => ({ withdrawal, operation }))))(
  'holds $withdrawal authority until an earlier lawful $operation actually commits',
  async ({ withdrawal, operation }) => {
    await commitBoundary(operation, withdrawal)
  },
)
it.each(operations)('rolls back %s, audit, outbox and cache when actual deferred COMMIT fails', async (operation) => {
  await commitBoundary(operation)
})
