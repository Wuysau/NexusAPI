import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { buildKeyring, sha256hex } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { POST as createKey } from '@/app/api/keys/route'
import { GET as getProject } from '@/app/api/projects/[id]/route'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent Key-create-commit authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid Key-create-commit authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_access_key_create_commit_authority_round78', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact loopback Key-create-commit authority fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-create-commit-authority-round78'
const internalToken = 'key-create-authority-78-synthetic-internal-token'
const signing = 'key-create-authority-78-synthetic-signing-key'
const signingKey = buildKeyring({ upstreamEncryptionKey: signing, currentVersion: 1 }).current.key
const scopes = ['models:read', 'chat:write']
const expiresAt = '2099-01-01T00:00:00.000Z'
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

beforeAll(async () => {
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  if (
    journal.dialect !== 'postgresql' ||
    journal.entries?.length !== 28 ||
    !journal.entries.every(
      (entry: { idx: number; tag: string }, index: number) =>
        entry.idx === index && /^\d{4}_[a-z0-9_]+$/.test(entry.tag),
    ) ||
    new Set(journal.entries.map((entry: { tag: string }) => entry.tag)).size !== 28
  )
    throw new Error('Exact canonical 28 migrations required before fixture reset')
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Key-create-commit authority actual database mismatch')
  locked = (await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [fixtureLock])).rows[0]
    ?.locked
  if (!locked) throw new Error('Key-create-commit authority fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Key-create-commit authority fixture has other clients')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
  process.env.GATEWAY_INTERNAL_TOKEN = internalToken
  process.env.SNAPSHOT_SIGNING_KEY = signing
  process.env.SNAPSHOT_SIGNING_KEY_VERSION = '1'
  await pool.query(
    "INSERT INTO gateway_snapshots(id,sequence_number,signature,signing_key_id,payload) VALUES('key-create-authority-78-snapshot',1,'synthetic','hmac-sha256:v1','{}')",
  )
  await pool.query(`
    CREATE FUNCTION round78_key_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$
    BEGIN
      IF NEW.name LIKE 'key-create-authority-78-%-new-key' THEN
        PERFORM pg_advisory_xact_lock(1789018878,78001);
      END IF;
      RETURN NEW;
    END
    $gate$;
    CREATE TRIGGER round78_key_insert_gate BEFORE INSERT ON downstream_api_keys
      FOR EACH ROW EXECUTE FUNCTION round78_key_insert_gate();
  `)
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_KEY_AUTHORITY_REPORT === '1')
    console.info('Key-create-commit authority safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [fixtureLock])
  } finally {
    owner?.release()
    await bounded(pool.end(), 'Key-create-commit authority fixture pool close timeout')
  }
})

type Role = 'developer' | 'viewer'
type Binding = 'bound' | 'omitted'
interface Fixture {
  tenant: string
  org: string
  actor: string
  project: string
  historicalKey: string
  historicalRequest: string
  name: string
  cookie: string
  csrf: string
}
async function fixture(role: Role): Promise<Fixture> {
  const prefix = 'key-create-authority-78-' + ++sequence
  const f: Fixture = {
    tenant: prefix + '-tenant',
    org: prefix + '-org',
    actor: prefix + '-actor',
    project: prefix + '-project',
    historicalKey: prefix + '-historical-key',
    historicalRequest: prefix + '-historical-request',
    name: prefix + '-new-key',
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.org, f.tenant])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    f.actor,
    f.actor + '@example.invalid',
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
    `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,project_id,created_by)
    VALUES($1,$2,$3,'Synthetic retained Key',$4,'fixture',$5::jsonb,$6,$7)`,
    [
      f.historicalKey,
      f.org,
      f.tenant,
      sha256hex(f.historicalKey + '-synthetic-history'),
      JSON.stringify(['models:read']),
      null,
      f.actor,
    ],
  )
  await pool.query(
    `INSERT INTO request_records(id,organization_id,tenant_id,request_model,channel_kind,status,project_id,project_name)
    VALUES($1,$2,$3,'synthetic-history-model','platform','completed',$4,'Synthetic retained history')`,
    [f.historicalRequest, f.org, f.tenant, f.project],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
function payload(f: Fixture, binding: Binding) {
  return { name: f.name, ...(binding === 'bound' ? { projectId: f.project } : {}), scopes, expiresAt }
}
function request(f: Fixture, binding: Binding, body?: BodyInit, validCSRF = true) {
  const value = body ?? JSON.stringify(payload(f, binding))
  return new Request('http://localhost/api/keys', {
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
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'projects',
  'project_memberships',
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
  'gateway_snapshots',
] as const
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
async function facts(): Promise<Facts> {
  const value = {} as Facts
  for (const table of tables) {
    const order =
      table === 'connector_pairings'
        ? 'connection_id'
        : table === 'project_workspace_roots'
          ? 'tenant_id,organization_id,root'
          : 'id'
    value[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return value
}
const successAudits = (value: Facts) => value.audit_events.filter((row) => row.action === 'apikey.created')
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
interface DirectoryKey {
  key_id: string
  project_id: string | null
  attribution_status: string
  enabled: boolean
  hash_sha256: string
  expires_at: string | null
}
async function directory(f: Fixture): Promise<DirectoryKey[]> {
  const response = await snapshot(
    new Request('http://localhost/api/internal/gateway/snapshot?tenant_id=' + encodeURIComponent(f.tenant), {
      headers: { authorization: `Bearer ${internalToken}` },
    }),
  )
  expect(response.status, 'Actual synthetic signed Key directory must be available').toBe(200)
  const body = await response.json()
  expect(
    body.signature === createHmac('sha256', signingKey).update(canonicalJson(body.bundle), 'utf8').digest('hex'),
    'Actual directory HMAC must verify with the synthetic fixture signing key',
  ).toBe(true)
  return (body.bundle.keys as DirectoryKey[]).sort((a, b) => a.key_id.localeCompare(b.key_id))
}
async function retainedProject(f: Fixture) {
  const response = await getProject(
    new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
    {
      params: Promise.resolve({ id: f.project }),
    },
  )
  expect(response.status, 'Retained project membership still authorizes fresh project read').toBe(200)
  const body = await response.json()
  expect(body.project?.id === f.project).toBe(true)
  expect(
    (
      await pool.query(
        'SELECT count(*)::int n FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3',
        [f.tenant, f.project, f.actor],
      )
    ).rows[0]?.n,
  ).toBe(1)
}
async function observe(f: Fixture, kind: string, before: Facts, beforeDirectory: DirectoryKey[], response: Response) {
  const body = await response.json()
  const after = await facts()
  const afterDirectory = await directory(f)
  const addedKeys = after.downstream_api_keys.filter(
    (row) => !before.downstream_api_keys.some((old) => old.id === row.id),
  )
  const addedAudits = successAudits(after).filter((row) => !before.audit_events.some((old) => old.id === row.id))
  const returnedToken = typeof body.token === 'string'
  const observation = {
    kind,
    status: response.status,
    returnedToken,
    returnedKey: body.key !== undefined,
    keyDelta: addedKeys.length,
    successAuditDelta: addedAudits.length,
    completeFactsUnchanged: isDeepStrictEqual(after, before),
    keysUnchanged: isDeepStrictEqual(after.downstream_api_keys, before.downstream_api_keys),
    auditsUnchanged: isDeepStrictEqual(after.audit_events, before.audit_events),
    historicalFactsUnchanged: isDeepStrictEqual(after.request_records, before.request_records),
    historicalKeyUnchanged: isDeepStrictEqual(
      after.downstream_api_keys.find((row) => row.id === f.historicalKey),
      before.downstream_api_keys.find((row) => row.id === f.historicalKey),
    ),
    signedDirectoryUnchanged: isDeepStrictEqual(afterDirectory, beforeDirectory),
    issuedKeyPublished: afterDirectory.some((key) => !beforeDirectory.some((old) => old.key_id === key.key_id)),
    plaintextPersisted: returnedToken && JSON.stringify(after).includes(body.token),
  }
  observations.push(observation)
  return { body, after, afterDirectory, addedKeys, addedAudits, observation }
}
function denied(result: Awaited<ReturnType<typeof observe>>, status: number, code: string) {
  const o = result.observation
  expect([
    o.status,
    o.returnedToken,
    o.returnedKey,
    o.keyDelta,
    o.successAuditDelta,
    o.keysUnchanged,
    o.historicalFactsUnchanged,
    o.historicalKeyUnchanged,
    o.signedDirectoryUnchanged,
    o.issuedKeyPublished,
    o.plaintextPersisted,
  ]).toEqual([status, false, false, 0, 0, true, true, true, true, false, false])
  expect(result.body.error?.code).toBe(code)
  expect([o.completeFactsUnchanged, o.auditsUnchanged]).toEqual([true, true])
}
function accepted(
  f: Fixture,
  binding: Binding,
  result: Awaited<ReturnType<typeof observe>>,
  before: Facts,
  archived = false,
  responseProjectId: string | null = binding === 'bound' ? f.project : null,
) {
  const o = result.observation
  expect([
    o.status,
    o.returnedToken,
    o.returnedKey,
    o.keyDelta,
    o.successAuditDelta,
    o.historicalFactsUnchanged,
    o.historicalKeyUnchanged,
    o.issuedKeyPublished,
    o.plaintextPersisted,
  ]).toEqual([201, true, true, 1, 1, true, true, true, false])
  expect(/^sk-nx-[A-Za-z0-9_-]+$/.test(result.body.token)).toBe(true)
  const key = result.addedKeys[0]
  expect(key.tenant_id === f.tenant && key.organization_id === f.org && key.created_by === f.actor).toBe(true)
  expect(key.project_id === (binding === 'bound' ? f.project : null)).toBe(true)
  expect(key.hash === sha256hex(result.body.token)).toBe(true)
  same(key.scopes, scopes, 'Issued scopes remain unchanged')
  expect(key.expires_at instanceof Date && key.expires_at.toISOString() === expiresAt).toBe(true)
  expect(
    result.body.key?.id === key.id &&
      result.body.key?.projectId === responseProjectId &&
      result.body.key?.expiresAt === expiresAt,
  ).toBe(true)
  expect(!('hash' in result.body.key) && !('fingerprint' in result.body.key)).toBe(true)
  const published = result.afterDirectory.find((row) => row.key_id === key.id)
  expect(
    published?.enabled === !archived &&
      published?.hash_sha256 === key.hash &&
      published?.project_id === (archived ? null : key.project_id) &&
      published?.expires_at === expiresAt &&
      published?.attribution_status === (archived ? 'unknown' : binding === 'bound' ? 'attributed' : 'unattributed'),
  ).toBe(true)
  const audit = result.addedAudits[0]
  expect(
    audit.tenant_id === f.tenant &&
      audit.actor_user_id === f.actor &&
      audit.target_type === 'downstream_api_key' &&
      audit.target_id === key.id,
  ).toBe(true)
  same(
    audit.metadata,
    { name: f.name, scopes, prefix: 'sk-nx-', fingerprint: sha256hex(result.body.token).slice(0, 16), expiresAt },
    'Existing issuance audit metadata remains exact and contains no plaintext',
  )
  same(
    result.after.downstream_api_keys.filter((row) => row.id !== key.id),
    before.downstream_api_keys,
    'All existing Keys remain unchanged',
  )
  same(
    result.after.audit_events.filter((row) => row.id !== audit.id),
    before.audit_events,
    'All existing audits remain unchanged',
  )
  for (const table of tables.filter((name) => !['downstream_api_keys', 'audit_events'].includes(name)))
    same(result.after[table], before[table], table + ' unchanged')
}

type Withdrawal = 'project-membership' | 'role-bound' | 'role-omitted' | 'project-archive'
const withdrawals = ['project-membership', 'role-bound', 'role-omitted', 'project-archive'] as const
const archiveAt = '2026-10-04T00:00:00.000Z'
const bindingFor = (kind: Withdrawal): Binding => (kind === 'role-omitted' ? 'omitted' : 'bound')
const denialFor = (kind: Withdrawal) =>
  kind.startsWith('role-')
    ? { status: 403, code: 'forbidden', bodyUsed: false }
    : { status: 404, code: kind === 'project-archive' ? 'project_not_found' : 'tenant_isolation', bodyUsed: true }
async function withdraw(client: PoolClient, f: Fixture, kind: Withdrawal) {
  const result =
    kind === 'project-membership'
      ? await client.query(
          'DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 RETURNING id',
          [f.tenant, f.project, f.actor],
        )
      : kind === 'project-archive'
        ? await client.query(
            'UPDATE projects SET archived_at=$1 WHERE id=$2 AND tenant_id=$3 AND organization_id=$4 RETURNING id',
            [archiveAt, f.project, f.tenant, f.org],
          )
        : await client.query(
            "UPDATE organization_memberships SET role='viewer' WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3 RETURNING id",
            [f.tenant, f.org, f.actor],
          )
  if (result.rowCount !== 1) throw new Error('Synthetic authority withdrawal must change exactly one fixture row')
}
function afterWithdrawal(before: Facts, f: Fixture, kind: Withdrawal): Facts {
  const expected = structuredClone(before)
  if (kind === 'project-membership')
    expected.project_memberships = expected.project_memberships.filter(
      (row) => !(row.tenant_id === f.tenant && row.project_id === f.project && row.user_id === f.actor),
    )
  else if (kind === 'project-archive') {
    const row = expected.projects.find((row) => row.id === f.project)!
    row.archived_at = new Date(archiveAt)
  } else {
    const row = expected.organization_memberships.find(
      (row) => row.organization_id === f.org && row.user_id === f.actor,
    )!
    row.role = 'viewer'
  }
  return expected
}
async function freshDenial(f: Fixture, kind: Withdrawal, label: string) {
  const visibility = await getProject(
    new Request('http://localhost/api/projects/' + f.project, { headers: { cookie: f.cookie } }),
    { params: Promise.resolve({ id: f.project }) },
  )
  expect(
    visibility.status,
    'Fresh project read uses actual remaining membership and management archive visibility',
  ).toBe(kind === 'project-membership' ? 404 : 200)
  const before = await facts()
  expect(before.request_records.some((row) => row.id === f.historicalRequest)).toBe(true)
  const beforeDirectory = await directory(f)
  const req = request(f, bindingFor(kind))
  const expected = denialFor(kind)
  denied(
    await observe(
      f,
      label,
      before,
      beforeDirectory,
      await bounded(createKey(req), 'Fresh denied Key POST must finish'),
    ),
    expected.status,
    expected.code,
  )
  expect(req.bodyUsed, 'Fresh role denial must precede body consumption').toBe(expected.bodyUsed)
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeout = 3000): Promise<T> {
  const until = Date.now() + timeout
  do {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 15))
  } while (Date.now() < until)
  throw new Error(label)
}
async function gated(f: Fixture, binding: Binding, kind?: Withdrawal) {
  const gate = await pool.connect()
  const writer = kind ? await pool.connect() : undefined
  let gateHeld = false
  let pending: Promise<Response> | undefined
  let changing: Promise<void> | undefined
  let routeSettled = false
  let changeSettled = false
  let changeError: unknown
  let withdrawalFirst = false
  let authorityHeld = false
  try {
    const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    await gate.query('SELECT pg_advisory_lock(1789018878,78001)')
    gateHeld = true
    const req = request(f, binding)
    pending = createKey(req).finally(() => {
      routeSettled = true
    })
    const routePid = await waitFor(async () => {
      const rows = (
        await owner!.query(
          `SELECT pid FROM pg_stat_activity
         WHERE datname=current_database() AND backend_type='client backend'
           AND $1=ANY(pg_blocking_pids(pid))
           AND query ~* 'INSERT[[:space:]]+INTO[[:space:]]+downstream_api_keys'`,
          [gatePid],
        )
      ).rows
      if (rows.length > 1) throw new Error('Exactly one actual Key INSERT may wait on the fixture gate')
      return rows[0]?.pid as number | undefined
    }, 'Actual Key INSERT was not blocked by the advisory fixture gate')
    expect([req.bodyUsed, routeSettled]).toEqual([true, false])
    if (kind && writer) {
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      changing = withdraw(writer, f, kind).then(
        () => {
          changeSettled = true
        },
        (error) => {
          changeError = error
          changeSettled = true
          throw error
        },
      )
      void changing.catch(() => {})
      const ordering = await waitFor(async () => {
        if (changeSettled) {
          if (changeError) throw changeError
          return 'withdrawal-first' as const
        }
        const row = (await owner!.query('SELECT pg_blocking_pids($1) AS blockers', [writerPid])).rows[0]
        return row?.blockers?.includes(routePid) ? ('authority-held' as const) : undefined
      }, 'Withdrawal must commit before gate release or wait on actual route authority')
      withdrawalFirst = ordering === 'withdrawal-first'
      authorityHeld = ordering === 'authority-held'
      if (withdrawalFirst) {
        await changing
        await freshDenial(f, kind, 'fresh-after-committed-' + kind)
      }
    }
    const before = await facts()
    const beforeDirectory = await directory(f)
    expect(before.request_records.some((row) => row.id === f.historicalRequest)).toBe(true)
    expect(before.downstream_api_keys.some((row) => row.id === f.historicalKey)).toBe(true)
    expect(routeSettled, 'Actual INSERT remains gated throughout oracle capture').toBe(false)
    await gate.query('SELECT pg_advisory_unlock(1789018878,78001)')
    gateHeld = false
    const response = await bounded(pending, 'Gated actual Key POST must settle after release', 7000)
    if (changing) await bounded(changing, 'Authority writer must settle after route transaction', 7000)
    const oracleBefore = kind && authorityHeld ? afterWithdrawal(before, f, kind) : before
    const result = await observe(
      f,
      kind ? 'gated-' + kind : 'healthy-gated-' + binding,
      oracleBefore,
      beforeDirectory,
      response,
    )
    Object.assign(result.observation, {
      actualInsertBlocked: true,
      bodyConsumedBeforeGate: true,
      withdrawalCommittedBeforeGateRelease: withdrawalFirst,
      withdrawalBlockedByRoute: authorityHeld,
      writerFinished: kind ? changeSettled && !changeError : null,
    })
    if (kind && withdrawalFirst) {
      const expected = denialFor(kind)
      denied(result, expected.status, expected.code)
    } else {
      if (kind) expect(authorityHeld, 'Issuance is legal only when actual route authority blocks withdrawal').toBe(true)
      accepted(f, binding, result, oracleBefore, kind === 'project-archive')
      if (kind) await freshDenial(f, kind, 'fresh-after-held-' + kind)
    }
  } finally {
    if (gateHeld) await gate.query('SELECT pg_advisory_unlock(1789018878,78001)')
    try {
      if (pending) await bounded(pending, 'Gated request cleanup must settle', 8000)
      if (changing) await bounded(changing, 'Authority writer cleanup must settle', 8000)
    } finally {
      gate.release()
      writer?.release()
    }
  }
}
it.each(withdrawals)(
  'withdrawal %s: create must pin authority or deny without publishing after commit-first withdrawal',
  async (kind) => {
    await gated(await fixture('developer'), bindingFor(kind), kind)
  },
)
it.each(['bound', 'omitted'] as const)(
  'control: healthy gated developer creates %s Key with exact audit and signed directory',
  async (binding) => {
    await gated(await fixture('developer'), binding)
  },
)
it.each(withdrawals)(
  'control: fresh %s withdrawal denies actual create and preserves every persisted fact',
  async (kind) => {
    const f = await fixture('developer')
    const writer = await pool.connect()
    try {
      await withdraw(writer, f, kind)
    } finally {
      writer.release()
    }
    await freshDenial(f, kind, 'fresh-control-' + kind)
  },
)

it.each(['project-membership', 'role-bound'] as const)(
  'denies %s withdrawal committed while the transaction project authority guard waits',
  async (kind) => {
    const f = await fixture('developer')
    const gate = await pool.connect()
    let gateOpen = false
    let pending: Promise<Response> | undefined
    let settled = false
    try {
      await gate.query('BEGIN')
      gateOpen = true
      await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [f.project])
      const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      const req = request(f, 'bound')
      pending = createKey(req).finally(() => {
        settled = true
      })
      await waitFor(async () => {
        const rows = (
          await owner!.query(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
           AND $1=ANY(pg_blocking_pids(pid))
           AND query ~* 'FROM[[:space:]]+projects' AND query ~* 'FOR[[:space:]]+SHARE'`,
            [gatePid],
          )
        ).rows
        return rows.length === 1 ? (rows[0].pid as number) : undefined
      }, 'Actual transaction project authority guard must wait after initial HTTP scope checks')
      expect([req.bodyUsed, settled]).toEqual([true, false])
      const writer = await pool.connect()
      try {
        await bounded(withdraw(writer, f, kind), 'Withdrawal before project guard release must commit')
      } finally {
        writer.release()
      }
      await freshDenial(f, kind, 'fresh-after-guard-wait-' + kind)
      const before = await facts()
      const beforeDirectory = await directory(f)
      expect(settled).toBe(false)
      await gate.query('COMMIT')
      gateOpen = false
      const result = await observe(
        f,
        'guard-wait-' + kind,
        before,
        beforeDirectory,
        await bounded(pending, 'Guard-wait denied actual create must settle'),
      )
      Object.assign(result.observation, {
        actualProjectGuardBlocked: true,
        withdrawalCommittedBeforeGuardRelease: true,
      })
      const expected = denialFor(kind)
      denied(result, expected.status, expected.code)
    } finally {
      try {
        if (gateOpen) await gate.query('ROLLBACK')
      } finally {
        gate.release()
        if (pending) await bounded(pending, 'Project guard wait request cleanup must settle', 8000)
      }
    }
  },
)

const commitGate = 780178
async function installCommitGate(f: Fixture, reject: boolean) {
  expect(/^key-create-authority-78-[0-9]+-new-key$/.test(f.name)).toBe(true)
  await pool.query(`CREATE FUNCTION round78_key_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
    BEGIN
      IF NEW.name=TG_ARGV[0] THEN
        PERFORM pg_advisory_xact_lock(${commitGate});
        IF TG_ARGV[1]='reject' THEN RAISE EXCEPTION 'synthetic Key creation commit unavailable'; END IF;
      END IF;
      RETURN NEW;
    END
    $guard$;
    CREATE CONSTRAINT TRIGGER round78_key_commit_guard AFTER INSERT ON downstream_api_keys
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION round78_key_commit_guard('${f.name}','${reject ? 'reject' : 'accept'}');`)
}
async function dropCommitGate() {
  await pool.query(
    'DROP TRIGGER IF EXISTS round78_key_commit_guard ON downstream_api_keys; DROP FUNCTION IF EXISTS round78_key_commit_guard()',
  )
}
async function commitBoundary(binding: Binding, kind?: Withdrawal) {
  const f = await fixture('developer')
  const before = await facts()
  const beforeDirectory = await directory(f)
  let gate: PoolClient | undefined
  let gateHeld = false
  let pending: Promise<Response> | undefined
  let writer: PoolClient | undefined
  let changing: Promise<void> | undefined
  let writerCommitted = false
  let requestSettled = false
  try {
    await installCommitGate(f, !kind)
    gate = await pool.connect()
    await gate.query('SELECT pg_advisory_lock($1::bigint)', [commitGate])
    gateHeld = true
    const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
    const req = request(f, binding)
    pending = createKey(req).finally(() => {
      requestSettled = true
    })
    const routePid = await waitFor(async () => {
      const rows = (
        await owner!.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active'
         AND upper(trim(query))='COMMIT' AND $1=ANY(pg_blocking_pids(pid))`,
          [gatePid],
        )
      ).rows
      return rows.length === 1 ? (rows[0].pid as number) : undefined
    }, 'Actual Key creation COMMIT must wait on the deferred constraint trigger')
    expect([req.bodyUsed, requestSettled]).toEqual([true, false])
    same(await facts(), before, 'Pending actual COMMIT exposes no Key, binding, expiry, audit or history changes')
    same(await directory(f), beforeDirectory, 'Pending actual COMMIT exposes no signed-directory changes')
    if (kind) {
      writer = await pool.connect()
      const writerPid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid as number
      changing = withdraw(writer, f, kind).then(() => {
        writerCommitted = true
      })
      void changing.catch(() => {})
      await waitFor(async () => {
        const row = (await owner!.query('SELECT $1=ANY(pg_blocking_pids($2)) held', [routePid, writerPid])).rows[0]
        return row?.held ? true : undefined
      }, 'Creation authority must block withdrawal through actual COMMIT')
      expect(writerCommitted).toBe(false)
      same(await facts(), before, 'Blocked authority withdrawal preserves every visible fact before creation COMMIT')
      same(
        await directory(f),
        beforeDirectory,
        'Blocked authority withdrawal preserves signed directory before creation COMMIT',
      )
    }
    expect(requestSettled).toBe(false)
    await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
    gateHeld = false
    const response = await bounded(pending, 'Commit-gated actual creation must settle', 7000)
    if (changing) await bounded(changing, 'Commit-held authority withdrawal must settle', 7000)
    const oracleBefore = kind ? afterWithdrawal(before, f, kind) : before
    const result = await observe(
      f,
      kind ? 'commit-held-' + kind : 'commit-rejected-' + binding,
      oracleBefore,
      beforeDirectory,
      response,
    )
    Object.assign(result.observation, {
      actualCommitBlocked: true,
      uncommittedFactsAndDirectoryInvisible: true,
      authorityBlockedThroughCommit: Boolean(kind),
      writerCommitted: kind ? writerCommitted : null,
    })
    if (kind) {
      expect(writerCommitted).toBe(true)
      accepted(f, binding, result, oracleBefore, kind === 'project-archive')
      await freshDenial(f, kind, 'fresh-after-actual-commit-' + kind)
    } else denied(result, 500, 'internal_error')
  } finally {
    try {
      if (gate && gateHeld) await gate.query('SELECT pg_advisory_unlock($1::bigint)', [commitGate])
    } finally {
      gate?.release()
      try {
        if (pending) await bounded(pending, 'Commit-gated creation request cleanup must settle', 8000)
      } finally {
        try {
          if (changing) await bounded(changing, 'Commit-held writer cleanup must settle', 8000)
        } finally {
          writer?.release()
          await dropCommitGate()
        }
      }
    }
  }
}
it.each(withdrawals)('holds %s creation authority through the actual PostgreSQL COMMIT', async (kind) => {
  await commitBoundary(bindingFor(kind), kind)
})
it.each(['bound', 'omitted'] as const)(
  'rolls back %s creation, audit and signed directory when actual deferred COMMIT rejects',
  async (binding) => {
    await commitBoundary(binding)
  },
)

it('compatibility: current developer can create for an inactive unarchived project', async () => {
  const f = await fixture('developer')
  await pool.query("UPDATE projects SET status='inactive',archived_at=NULL WHERE id=$1", [f.project])
  const before = await facts()
  const beforeDirectory = await directory(f)
  const result = await observe(
    f,
    'compatibility-inactive-unarchived',
    before,
    beforeDirectory,
    await createKey(request(f, 'bound')),
  )
  accepted(f, 'bound', result, before, true)
})
it.each([null, ''] as const)(
  'compatibility: explicit projectId %j retains existing unbound issuance and response',
  async (projectId) => {
    const f = await fixture('developer')
    const before = await facts()
    const beforeDirectory = await directory(f)
    const body = JSON.stringify({ ...payload(f, 'omitted'), projectId })
    const result = await observe(
      f,
      projectId === null ? 'compatibility-null-binding' : 'compatibility-empty-binding',
      before,
      beforeDirectory,
      await createKey(request(f, 'omitted', body)),
    )
    accepted(f, 'omitted', result, before, false, projectId)
  },
)
