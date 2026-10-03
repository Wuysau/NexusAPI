import { createHmac } from 'node:crypto'
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
if (!supplied) throw new Error('Explicit independent Key-authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid Key-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_access_key_authority_round75', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact loopback Key-authority fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const fixtureLock = 'nexus-key-authority-round75'
const internalToken = 'key-authority-75-synthetic-internal-token'
const signing = 'key-authority-75-synthetic-signing-key'
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
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Key-authority actual database mismatch')
  locked = (await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [fixtureLock])).rows[0]
    ?.locked
  if (!locked) throw new Error('Key-authority fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Key-authority fixture has other clients')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
  process.env.GATEWAY_INTERNAL_TOKEN = internalToken
  process.env.SNAPSHOT_SIGNING_KEY = signing
  process.env.SNAPSHOT_SIGNING_KEY_VERSION = '1'
  await pool.query(
    "INSERT INTO gateway_snapshots(id,sequence_number,signature,signing_key_id,payload) VALUES('key-authority-75-snapshot',1,'synthetic','hmac-sha256:v1','{}')",
  )
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_KEY_AUTHORITY_REPORT === '1')
    console.info('Key-authority safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [fixtureLock])
  } finally {
    owner?.release()
    await bounded(pool.end(), 'Key-authority fixture pool close timeout')
  }
})

type Role = 'admin' | 'viewer'
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
  const prefix = 'key-authority-75-' + ++sequence
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
      f.project,
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
function denied(result: Awaited<ReturnType<typeof observe>>, code = 'forbidden', csrf = false) {
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
  ]).toEqual([403, false, false, 0, 0, true, true, true, true, false, false])
  expect(result.body.error?.code).toBe(code)
  if (!csrf) expect([o.completeFactsUnchanged, o.auditsUnchanged]).toEqual([true, true])
}
function accepted(f: Fixture, binding: Binding, result: Awaited<ReturnType<typeof observe>>, before: Facts) {
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
      result.body.key?.projectId === key.project_id &&
      result.body.key?.expiresAt === expiresAt,
  ).toBe(true)
  expect(!('hash' in result.body.key) && !('fingerprint' in result.body.key)).toBe(true)
  const published = result.afterDirectory.find((row) => row.key_id === key.id)
  expect(
    published?.enabled === true &&
      published?.hash_sha256 === key.hash &&
      published?.project_id === key.project_id &&
      published?.expires_at === expiresAt &&
      published?.attribution_status === (binding === 'bound' ? 'attributed' : 'unattributed'),
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
async function delayed(binding: Binding, demote: boolean) {
  const f = await fixture('admin')
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
  const req = request(f, binding, stream)
  let complete = false
  let settled = false
  const pending = createKey(req).finally(() => {
    settled = true
  })
  try {
    await bounded(entered, 'Actual Key POST did not consume body after initial authorization')
    expect([req.bodyUsed, settled]).toEqual([true, false])
    if (demote) {
      expect(
        (
          await pool.query(
            'UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3 RETURNING role',
            ['viewer', f.org, f.actor],
          )
        ).rows[0]?.role,
      ).toBe('viewer')
      await retainedProject(f)
      const beforeFresh = await facts()
      const freshDirectory = await directory(f)
      const freshRequest = request(f, binding)
      denied(await observe(f, 'fresh-viewer-' + binding, beforeFresh, freshDirectory, await createKey(freshRequest)))
      expect(freshRequest.bodyUsed).toBe(false)
    }
    const before = await facts()
    const beforeDirectory = await directory(f)
    complete = true
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload(f, binding))))
    controller.close()
    const result = await observe(
      f,
      (demote ? 'delayed-admin-viewer-' : 'healthy-delayed-admin-') + binding,
      before,
      beforeDirectory,
      await bounded(pending, 'Native delayed Key POST must complete'),
    )
    if (demote) denied(result)
    else accepted(f, binding, result, before)
  } finally {
    if (!complete) controller.error(new Error('Synthetic Key body closed during fixture cleanup'))
    await bounded(pending, 'Delayed Key request cleanup must complete')
  }
}
const bindings = ['bound', 'omitted'] as const
it.each(bindings)(
  'refuses %s Key issuance after admin becomes a retained project-member viewer while body waits',
  async (binding) => {
    await delayed(binding, true)
  },
)
it.each(bindings)('control: healthy current administrator retains delayed %s Key issuance', async (binding) => {
  await delayed(binding, false)
})
it.each(bindings)('control: fresh retained project-member viewer cannot issue %s Key', async (binding) => {
  const f = await fixture('viewer')
  await retainedProject(f)
  const before = await facts()
  const beforeDirectory = await directory(f)
  const req = request(f, binding)
  denied(await observe(f, 'fresh-viewer-control-' + binding, before, beforeDirectory, await createKey(req)))
  expect(req.bodyUsed).toBe(false)
})
it.each(bindings)('control: actual CSRF denial preserves %s Key and history facts', async (binding) => {
  const f = await fixture('admin')
  const before = await facts()
  const beforeDirectory = await directory(f)
  const req = request(f, binding, undefined, false)
  const response = await createKey(req)
  const csrfBefore = before.audit_events.filter((row) => row.action === 'csrf.rejected').length
  await expect
    .poll(
      async () =>
        (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='csrf.rejected'")).rows[0]?.n,
      { timeout: 3000 },
    )
    .toBe(csrfBefore + 1)
  const result = await observe(f, 'csrf-control-' + binding, before, beforeDirectory, response)
  denied(result, 'csrf_failed', true)
  expect(req.bodyUsed).toBe(false)
  expect(result.after.audit_events.length - before.audit_events.length).toBe(1)
  same(
    result.after.audit_events.filter((row) => before.audit_events.some((old) => old.id === row.id)),
    before.audit_events,
    'CSRF rejection preserves every existing audit',
  )
  for (const table of tables.filter((name) => name !== 'audit_events'))
    same(result.after[table], before[table], table + ' unchanged on CSRF denial')
})
