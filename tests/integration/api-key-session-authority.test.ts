import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { issueCsrfToken, CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf'
import { getRevocationEpoch } from '@/lib/auth/api-keys'
import { PATCH as patchKey, DELETE as revokeKey } from '@/app/api/keys/[id]/route'
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
  !['/workspace_access_key_session_authority_round80', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact Key mutation-authority loopback fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-session-authority-round80'
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
  const prefix = 'key-session-authority80-' + ++sequence
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

type SessionWithdrawal = 'revoked' | 'expired'
const withdrawnAt = new Date('2026-10-04T00:00:00.000Z')
async function sessionGate(operation: Operation, kind?: SessionWithdrawal) {
  const f = await fixture(),
    gate = await pool.connect()
  let open = false,
    pending: Promise<Response> | undefined
  let writer: PoolClient | undefined,
    changing: Promise<void> | undefined,
    changed = false
  try {
    await gate.query('BEGIN')
    open = true
    expect((await gate.query('SELECT id FROM downstream_api_keys WHERE id=$1 FOR UPDATE', [f.key])).rowCount).toBe(1)
    const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    pending = invoke(f, operation)
    const actionPid = await realBlockedAction(gatePid)
    let ordering = 'healthy-session'
    if (kind) {
      writer = await pool.connect()
      const writerPid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      changing = writer
        .query(
          kind === 'revoked'
            ? 'UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 RETURNING id'
            : 'UPDATE sessions SET expires_at=$1 WHERE user_id=$2 RETURNING id',
          [withdrawnAt, f.actor],
        )
        .then((result) => {
          expect(result.rowCount).toBe(1)
          changed = true
        })
      void changing.catch(() => {})
      ordering = await until(async () => {
        if (changed) return 'withdrawal-committed-before-key-release'
        if ((await owner!.query('SELECT $1=ANY(pg_blocking_pids($2)) held', [actionPid, writerPid])).rows[0]?.held)
          return 'session-held-by-earlier-action'
        return undefined
      }, 'Session withdrawal must commit or be visibly pinned by the actual earlier operation')
      if (changed) {
        const project = await readProject(
          new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
          params(f.project),
        )
        expect(project.status).toBe(401)
        const beforeFresh = await facts(),
          freshEpoch = getRevocationEpoch()
        const response = await bounded(
          invoke(f, operation),
          'Fresh withdrawn session must deny before fixture Key gate',
        )
        const body = await response.json()
        expect([response.status, body.error?.code]).toEqual([401, 'unauthenticated'])
        same(await facts(), beforeFresh, 'Fresh denied session leaves every fact unchanged')
        expect(getRevocationEpoch()).toBe(freshEpoch)
      }
    }
    const before = await facts(),
      epoch = getRevocationEpoch(),
      expected = structuredClone(before)
    if (kind)
      expected.sessions.find((row) => row.user_id === f.actor)![kind === 'revoked' ? 'revoked_at' : 'expires_at'] =
        withdrawnAt
    await gate.query('COMMIT')
    open = false
    const response = await bounded(pending, 'Session-gated actual Key operation must settle')
    if (changing) await bounded(changing, 'Session withdrawal must settle after actual Key operation')
    const result = await observe(f, 'session-' + (kind ?? 'healthy'), operation, response, expected, epoch, ordering)
    if (ordering === 'withdrawal-committed-before-key-release') {
      expect([
        result.observation.status,
        result.observation.returnedSuccess,
        result.observation.returnedToken,
        result.observation.completeBusinessFactsUnchanged,
        result.observation.cacheEpochDelta,
      ]).toEqual([401, false, false, true, 0])
      expect(result.body.error?.code).toBe('unauthenticated')
    } else accepted(f, operation, result, expected, epoch)
    if (kind) {
      expect(changed).toBe(true)
      expect((await pool.query('SELECT status,deleted_at FROM users WHERE id=$1', [f.actor])).rows[0]).toEqual({
        status: 'active',
        deleted_at: null,
      })
      expect(
        (
          await pool.query('SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2', [
            f.org,
            f.actor,
          ])
        ).rows[0]?.role,
      ).toBe('developer')
      expect(
        (
          await pool.query('SELECT count(*)::int n FROM project_memberships WHERE project_id=$1 AND user_id=$2', [
            f.project,
            f.actor,
          ])
        ).rows[0]?.n,
      ).toBe(1)
    }
  } finally {
    try {
      if (open) await gate.query('ROLLBACK')
    } finally {
      gate.release()
      try {
        if (pending) await bounded(pending, 'Session request cleanup must settle')
        if (changing) await bounded(changing, 'Session writer cleanup must settle')
      } finally {
        writer?.release()
      }
    }
  }
}
it.each(
  (['revoked', 'expired'] as const).flatMap((kind) =>
    (['disable', 'revoke'] as const).map((operation) => ({ kind, operation })),
  ),
)(
  'withdrawal $kind session: row-blocked $operation orders against current session validity',
  async ({ kind, operation }) => {
    await sessionGate(operation, kind)
  },
)
it.each(['disable', 'revoke'] as const)(
  'control: healthy current session retains exact %s facts',
  async (operation) => {
    await sessionGate(operation)
  },
)

type KeyOperation = Operation | 'create'

const keyOperations = ['disable', 'revoke', 'create'] as const
const sessionWithdrawals = ['revoked', 'expired'] as const

function invokeAny(f: Fixture, operation: KeyOperation) {
  if (operation !== 'create') return invoke(f, operation)
  return createKey(
    new Request('http://localhost/api/keys', {
      method: 'POST',
      headers: {
        cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
        [CSRF_HEADER]: f.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: f.actor + '-issued', projectId: f.project, scopes: ['models:read'] }),
    }),
  )
}
async function withdrawSession(client: PoolClient, f: Fixture, kind: SessionWithdrawal) {
  const result = await client.query(
    kind === 'revoked'
      ? 'UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 RETURNING id'
      : 'UPDATE sessions SET expires_at=$1 WHERE user_id=$2 RETURNING id',
    [withdrawnAt, f.actor],
  )
  expect(result.rowCount).toBe(1)
}
function afterSessionWithdrawal(before: Facts, f: Fixture, kind: SessionWithdrawal): Facts {
  const expected = structuredClone(before)
  expected.sessions.find((row) => row.user_id === f.actor)![kind === 'revoked' ? 'revoked_at' : 'expires_at'] =
    withdrawnAt
  return expected
}
async function assertSessionDenied(
  f: Fixture,
  operation: KeyOperation,
  response: Response,
  before: Facts,
  epoch: number,
) {
  const body = await response.json()
  expect([response.status, body.error?.code, typeof body.token, body.id]).toEqual([
    401,
    'unauthenticated',
    'undefined',
    undefined,
  ])
  same(await facts(), before, 'Denied operation preserves every Key, audit, outbox, session and historical fact')
  expect(getRevocationEpoch()).toBe(epoch)
  observations.push({
    kind: 'withdrawal-first',
    operation,
    status: response.status,
    completeBusinessFactsUnchanged: true,
    cacheEpochDelta: 0,
  })
  expect(
    (
      await pool.query('SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2', [
        f.org,
        f.actor,
      ])
    ).rows[0]?.role,
  ).toBe('developer')
  expect(
    (
      await pool.query('SELECT count(*)::int n FROM project_memberships WHERE project_id=$1 AND user_id=$2', [
        f.project,
        f.actor,
      ])
    ).rows[0]?.n,
  ).toBe(1)
}
it.each(sessionWithdrawals.flatMap((kind) => keyOperations.map((operation) => ({ kind, operation }))))(
  'denies $operation when session $kind commits while its actual transaction guard waits',
  async ({ kind, operation }) => {
    const f = await fixture()
    const before = await facts(),
      epoch = getRevocationEpoch()
    const writer = await pool.connect()
    let open = false,
      pending: Promise<Response> | undefined
    try {
      await writer.query('BEGIN')
      open = true
      await withdrawSession(writer, f, kind)
      const writerPid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      pending = invokeAny(f, operation)
      await until(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND query ~* 'FROM[[:space:]]+sessions' AND query ~* 'FOR[[:space:]]+SHARE'
          AND $1=ANY(pg_blocking_pids(pid))`,
            [writerPid],
          )
        ).rows
        return rows.length === 1 ? true : undefined
      }, 'Actual authenticated Key operation must wait at the current session transaction guard')
      same(await facts(), before, 'Uncommitted actor withdrawal and waiting Key operation expose no changes')
      await writer.query('COMMIT')
      open = false
      const expected = afterSessionWithdrawal(before, f, kind)
      await assertSessionDenied(
        f,
        operation,
        await bounded(pending, 'Withdrawal-first Key operation must settle'),
        expected,
        epoch,
      )
      await assertSessionDenied(f, operation, await invokeAny(f, operation), expected, epoch)
    } finally {
      try {
        if (open) await writer.query('ROLLBACK')
      } finally {
        writer.release()
        if (pending) await bounded(pending, 'Session guard request cleanup must settle')
      }
    }
  },
)

const commitGate = 800180
async function installActorCommitGate(f: Fixture, operation: KeyOperation) {
  const value = operation === 'create' ? f.actor + '-issued' : f.key
  expect(/^[a-z0-9-]+$/.test(value)).toBe(true)
  await pool.query(`CREATE FUNCTION key_session80_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF (TG_ARGV[0]='create' AND NEW.name=TG_ARGV[1]) OR (TG_ARGV[0]<>'create' AND NEW.id=TG_ARGV[1]) THEN
      PERFORM pg_advisory_xact_lock(${commitGate});
    END IF; RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER key_session80_commit_guard AFTER ${operation === 'create' ? 'INSERT' : 'UPDATE'} ON downstream_api_keys
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION key_session80_commit_guard('${operation}','${value}')`)
}
async function acceptedCreation(f: Fixture, response: Response, before: Facts, epoch: number) {
  const body = await response.json(),
    after = await facts()
  expect(response.status).toBe(201)
  expect(typeof body.token === 'string' && /^sk-nx-[A-Za-z0-9_-]+$/.test(body.token)).toBe(true)
  const added = after.downstream_api_keys.filter((row) => !before.downstream_api_keys.some((old) => old.id === row.id))
  expect(added.length).toBe(1)
  const key = added[0],
    hash = createHash('sha256').update(body.token).digest('hex')
  expect([key.id, key.hash, key.created_by, key.project_id, key.tenant_id, key.organization_id]).toEqual([
    body.key?.id,
    hash,
    f.actor,
    f.project,
    f.tenant,
    f.org,
  ])
  expect(body.key?.projectId).toBe(f.project)
  expect('hash' in body.key || 'fingerprint' in body.key).toBe(false)
  same(key.scopes, ['models:read'], 'Issued scopes retained')
  same(
    after.downstream_api_keys.filter((row) => row.id !== key.id),
    before.downstream_api_keys,
    'All pre-existing Keys unchanged',
  )
  const audits = after.audit_events.filter((row) => !before.audit_events.some((old) => old.id === row.id))
  expect(audits.length).toBe(1)
  expect([audits[0].action, audits[0].actor_user_id, audits[0].tenant_id, audits[0].target_id]).toEqual([
    'apikey.created',
    f.actor,
    f.tenant,
    key.id,
  ])
  same(
    audits[0].metadata,
    {
      name: f.actor + '-issued',
      scopes: ['models:read'],
      prefix: 'sk-nx-',
      fingerprint: hash.slice(0, 16),
      expiresAt: null,
    },
    'One redacted issuance audit',
  )
  same(
    after.audit_events.filter((row) => row.id !== audits[0].id),
    before.audit_events,
    'Previous audits unchanged',
  )
  for (const table of tables.filter((name) => !['downstream_api_keys', 'audit_events'].includes(name)))
    same(after[table], before[table], table + ' unchanged')
  expect(getRevocationEpoch()).toBe(epoch)
  observations.push({
    kind: 'session-held-through-commit',
    operation: 'create',
    status: response.status,
    keyDelta: 1,
    auditDelta: 1,
    cacheEpochDelta: 0,
  })
}
it.each(keyOperations)(
  'retains valid session through actual %s COMMIT before revocation can commit',
  async (operation) => {
    const f = await fixture(),
      before = await facts(),
      epoch = getRevocationEpoch()
    let gate: PoolClient | undefined, writer: PoolClient | undefined
    let held = false,
      pending: Promise<Response> | undefined,
      changing: Promise<void> | undefined,
      revoked = false
    try {
      await installActorCommitGate(f, operation)
      gate = await pool.connect()
      await gate.query('SELECT pg_advisory_lock($1::bigint)', [commitGate])
      held = true
      const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      pending = invokeAny(f, operation)
      const actionPid = await until(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND upper(trim(query))='COMMIT' AND $1=ANY(pg_blocking_pids(pid))`,
            [gatePid],
          )
        ).rows
        return rows.length === 1 ? (rows[0].pid as number) : undefined
      }, 'Actual Key COMMIT must wait on deferred fixture trigger')
      same(await facts(), before, 'Uncommitted Key, audit, outbox and actor facts remain invisible')
      expect(getRevocationEpoch()).toBe(epoch)
      writer = await pool.connect()
      const writerPid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      changing = withdrawSession(writer, f, 'revoked').then(() => {
        revoked = true
      })
      void changing.catch(() => {})
      await until(
        async () =>
          (await owner!.query('SELECT $1=ANY(pg_blocking_pids($2)) held', [actionPid, writerPid])).rows[0]?.held
            ? true
            : undefined,
        'Actual Key transaction must block user revocation through COMMIT',
      )
      expect(revoked).toBe(false)
      same(await facts(), before, 'Blocked session withdrawal and Key COMMIT preserve all visible facts')
      await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
      held = false
      const response = await bounded(pending, 'Commit-gated Key operation must settle')
      await bounded(changing, 'Session revocation must finish after Key commit')
      expect(revoked).toBe(true)
      const expected = afterSessionWithdrawal(before, f, 'revoked')
      if (operation === 'create') await acceptedCreation(f, response, expected, epoch)
      else
        accepted(
          f,
          operation,
          await observe(f, 'session-held-through-commit', operation, response, expected, epoch),
          expected,
          epoch,
        )
      const after = await facts(),
        afterEpoch = getRevocationEpoch()
      await assertSessionDenied(f, operation, await invokeAny(f, operation), after, afterEpoch)
    } finally {
      try {
        if (gate && held) await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
      } finally {
        try {
          if (pending) await bounded(pending, 'Commit-gated Key cleanup must settle')
          if (changing) await bounded(changing, 'Session writer cleanup must settle')
        } finally {
          gate?.release()
          writer?.release()
          await pool.query(
            'DROP TRIGGER IF EXISTS key_session80_commit_guard ON downstream_api_keys; DROP FUNCTION IF EXISTS key_session80_commit_guard()',
          )
        }
      }
    }
  },
)

it.each(keyOperations)(
  'denies %s when the locked session naturally expires during the actual project guard wait',
  async (operation) => {
    const f = await fixture()
    const expiry = (
      await pool.query(
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '8 seconds' WHERE user_id=$1 RETURNING expires_at",
        [f.actor],
      )
    ).rows[0].expires_at as Date
    const before = await facts(),
      epoch = getRevocationEpoch()
    const gate = await pool.connect()
    let open = false,
      pending: Promise<Response> | undefined
    try {
      await gate.query('BEGIN')
      open = true
      expect((await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [f.project])).rowCount).toBe(1)
      const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      pending = invokeAny(f, operation)
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
      }, 'Actual Key transaction must wait at project guard with a currently valid locked session')
      await until(
        async () => {
          const expired = (
            await owner!.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE user_id=$1', [f.actor])
          ).rows[0]?.expired
          return expired && Date.now() >= expiry.getTime() ? true : undefined
        },
        'Actual session must naturally cross expiry while resource lock remains held',
        12000,
      )
      await assertSessionDenied(f, operation, await invokeAny(f, operation), before, epoch)
      await gate.query('COMMIT')
      open = false
      await assertSessionDenied(
        f,
        operation,
        await bounded(pending, 'Naturally expired waiting operation must settle'),
        before,
        epoch,
      )
      observations.push({
        kind: 'natural-expiry-after-session-lock',
        operation,
        status: 401,
        actualProjectGuardBlocked: true,
        completeBusinessFactsUnchanged: true,
      })
    } finally {
      try {
        if (open) await gate.query('ROLLBACK')
      } finally {
        gate.release()
        if (pending) await bounded(pending, 'Natural expiry request cleanup must settle')
      }
    }
  },
  20000,
)
