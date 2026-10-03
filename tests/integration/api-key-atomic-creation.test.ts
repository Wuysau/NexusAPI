import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { sha256hex } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { POST as createKey } from '@/app/api/keys/route'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'

const databaseURL = process.env.DATABASE_URL
if (!databaseURL) throw new Error('Explicit atomic Key disposable database required')
const target = new URL(databaseURL)
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_key_atomic_round65', '/convergence_ci15'].includes(target.pathname) ||
  databaseURL.includes('?') ||
  databaseURL.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated atomic Key fixture database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'key-atomic-tenant'
const organization = 'key-atomic-org'
const project = 'key-atomic-project'
const owner = 'key-atomic-owner'
const csrf = 'key-atomic-fixture-csrf'
const internalToken = 'key-atomic-internal-fixture-token'
const signing = 'key-atomic-signing-fixture-key'
const auditLock = 65165
let cookie: string

beforeAll(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name === target.pathname.slice(1)).toBe(true)
  const owners = await pool.query(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
  )
  expect(owners.rows[0].n).toBe(0)
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  process.env.GATEWAY_INTERNAL_TOKEN = internalToken
  process.env.SNAPSHOT_SIGNING_KEY = signing
  process.env.SNAPSHOT_SIGNING_KEY_VERSION = '1'
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$3,$4)', [
    organization,
    tenant,
    'Atomic Key fixture',
    organization,
  ])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    owner,
    'owner@key-atomic.example.invalid',
    'fixture-unused-password-hash',
  ])
  await pool.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
    organization,
    tenant,
    owner,
    'owner',
  ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$4)', [
    project,
    tenant,
    organization,
    'Atomic Key fixture project',
  ])
  await pool.query(
    "INSERT INTO gateway_snapshots(id,sequence_number,signature,signing_key_id,payload) VALUES('atomic-fixture',1,'fixture','hmac-sha256:v1','{}')",
  )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: owner })).token}; nexus_csrf=${csrf}`
}, 30000)

beforeEach(async () => {
  await pool.query(`DROP TRIGGER IF EXISTS key_atomic_audit_guard ON audit_events;
    DROP TRIGGER IF EXISTS key_atomic_binding_guard ON downstream_api_keys;
    DROP FUNCTION IF EXISTS key_atomic_audit_guard();
    DROP FUNCTION IF EXISTS key_atomic_binding_guard();
    DELETE FROM audit_events;
    DELETE FROM downstream_api_keys`)
  await pool.query(
    `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,project_id)
    VALUES('key-atomic-history',$1,$2,'Historical fixture',$3,'fixture',$4::jsonb,$5)`,
    [organization, tenant, sha256hex('fixture-retained-history'), JSON.stringify(['models:read']), project],
  )
})
afterAll(async () => {
  await pool.end()
})

const request = (name: string, bound = true) =>
  new Request('http://localhost/api/keys', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(bound ? { projectId: project } : {}),
      scopes: ['models:read', 'chat:write'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  })
async function facts() {
  return {
    keys: (await pool.query('SELECT * FROM downstream_api_keys ORDER BY id')).rows,
    audits: (await pool.query('SELECT * FROM audit_events ORDER BY id')).rows,
  }
}
async function directory() {
  const response = await snapshot(
    new Request('http://localhost/api/internal/gateway/snapshot', {
      headers: { authorization: `Bearer ${internalToken}` },
    }),
  )
  expect(response.status).toBe(200)
  return (await response.json()).bundle.keys as Array<{
    key_id: string
    project_id: string | null
    attribution_status: string
    enabled: boolean
    hash_sha256: string
  }>
}

it('does not publish any newly issued Key until scope and successful audit commit together', async () => {
  await pool.query(`CREATE FUNCTION key_atomic_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='apikey.created' THEN PERFORM pg_advisory_xact_lock(${auditLock}); END IF; RETURN NEW; END $$;
    CREATE TRIGGER key_atomic_audit_guard BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION key_atomic_audit_guard()`)
  const gate = await pool.connect()
  let pending: Promise<Response> | undefined
  let response: Response | undefined
  let publishedBeforeCommit: boolean | undefined
  try {
    await gate.query('SELECT pg_advisory_lock($1::bigint)', [auditLock])
    pending = createKey(request('atomic-pending'))
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted",
              [auditLock],
            )
          ).rows[0].n,
        { timeout: 5000 },
      )
      .toBe(1)
    publishedBeforeCommit = (await directory()).some((key) => key.key_id !== 'key-atomic-history')
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1::bigint)', [auditLock])
    gate.release()
    if (pending) response = await pending
  }
  expect(publishedBeforeCommit).toBe(false)
  expect(response?.status).toBe(201)
  const body = await response!.json()
  const key = (await directory()).find((entry) => entry.key_id === body.key.id)
  expect(key?.project_id === project && key?.attribution_status === 'attributed' && key?.enabled === true).toBe(true)
  expect(key?.hash_sha256 === sha256hex(body.token)).toBe(true)
  expect(body.key.projectId === project).toBe(true)
  expect(body.key.expiresAt).toBe('2099-01-01T00:00:00.000Z')
  const stored = await facts()
  expect(stored.audits.filter((row) => row.action === 'apikey.created').length).toBe(1)
  expect(JSON.stringify(stored).includes(body.token)).toBe(false)
})

it('rolls back Key and success audit if the requested project binding cannot persist', async () => {
  await pool.query(`CREATE FUNCTION key_atomic_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name='atomic-binding-failure' AND NEW.project_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic project binding unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER key_atomic_binding_guard BEFORE INSERT OR UPDATE ON downstream_api_keys FOR EACH ROW EXECUTE FUNCTION key_atomic_binding_guard()`)
  const before = await facts()
  const response = await createKey(request('atomic-binding-failure'))
  const body = await response.json()
  expect(response.status).toBe(500)
  expect('token' in body).toBe(false)
  expect(body.error.code).toBe('internal_error')
  expect(JSON.stringify(await facts()) === JSON.stringify(before)).toBe(true)
})

it('rolls back issuance when mandatory credential audit cannot persist', async () => {
  await pool.query(`CREATE FUNCTION key_atomic_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='apikey.created' THEN RAISE EXCEPTION 'synthetic mandatory audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER key_atomic_audit_guard BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION key_atomic_audit_guard()`)
  const before = await facts()
  const response = await createKey(request('atomic-audit-failure'))
  const body = await response.json()
  expect(response.status).toBe(500)
  expect('token' in body).toBe(false)
  expect(JSON.stringify(await facts()) === JSON.stringify(before)).toBe(true)
})

it('retains explicit no-project issuance, one-time plaintext and exactly one success audit', async () => {
  const response = await createKey(request('atomic-unattributed', false))
  const body = await response.json()
  expect(response.status).toBe(201)
  expect(body.key.projectId).toBeNull()
  const key = (await directory()).find((entry) => entry.key_id === body.key.id)
  expect(key?.project_id === null && key?.attribution_status === 'unattributed' && key?.enabled === true).toBe(true)
  const stored = await facts()
  expect(stored.audits.filter((row) => row.action === 'apikey.created').length).toBe(1)
  expect(JSON.stringify(stored).includes(body.token)).toBe(false)
})
