import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { issueCsrfToken, CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf'
import { getRevocationEpoch } from '@/lib/auth/api-keys'
import { GET as listKeys } from '@/app/api/keys/route'
import { PATCH as patchKey, DELETE as revokeKey } from '@/app/api/keys/[id]/route'
import { GET as readProject } from '@/app/api/projects/[id]/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable Key lifecycle database required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid Key lifecycle fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_access_key_lifecycle_round76', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact Key lifecycle loopback fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'key-lifecycle76-tenant',
  org = 'key-lifecycle76-org'
const visible = 'key-lifecycle76-visible',
  hidden = 'key-lifecycle76-hidden'
const roles = ['admin', 'developer', 'viewer'] as const
type Role = (typeof roles)[number]
const user = (role: Role) => 'key-lifecycle76-' + role
const cookies = {} as Record<Role, string>
const csrf = issueCsrfToken()
let owner: PoolClient | undefined,
  locked = false
const observations: Record<string, unknown>[] = []
const params = (id: string) => ({ params: Promise.resolve({ id }) })
function request(role: Role, path: string, method = 'GET', body?: unknown) {
  return new Request('http://localhost' + path, {
    method,
    headers: {
      cookie: `${cookies[role]}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
beforeAll(async () => {
  owner = await pool.connect()
  expect((await owner.query('SELECT current_database() AS name')).rows[0]?.name).toBe(target.pathname.slice(1))
  locked = (
    await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [
      'key-lifecycle76:' + target.pathname,
    ])
  ).rows[0]?.locked
  if (!locked) throw new Error('Key lifecycle fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Key lifecycle fixture has other clients')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [org, tenant])
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      user(role),
      role + '@key-lifecycle76.example.invalid',
      'synthetic-unused-password',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [org, tenant, user(role), role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: user(role) })).token}`
  }
  for (const id of [visible, hidden])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [id, tenant, org])
  for (const role of ['developer', 'viewer'] as const)
    await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
      tenant,
      visible,
      user(role),
    ])
}, 30000)
afterAll(async () => {
  console.info('Key lifecycle safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked)
      await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['key-lifecycle76:' + target.pathname])
  } finally {
    owner?.release()
    await pool.end()
  }
})
async function key(projectId: string | null, creator: Role = 'admin', enabled = true) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,project_id,created_by,enabled)
    VALUES($1,$2,$3,'Synthetic lifecycle target',$4,'fixture','["models:read"]',$5,$6,$7)`,
    [
      id,
      org,
      tenant,
      createHash('sha256')
        .update('synthetic-key-lifecycle76:' + id)
        .digest('hex'),
      projectId,
      user(creator),
      enabled,
    ],
  )
  return id
}
async function facts() {
  return {
    keys: (await pool.query('SELECT * FROM downstream_api_keys ORDER BY id')).rows,
    audits: (await pool.query('SELECT * FROM audit_events ORDER BY id')).rows,
    outbox: (await pool.query('SELECT * FROM outbox_events ORDER BY id')).rows,
    projects: (await pool.query('SELECT * FROM projects ORDER BY id')).rows,
    memberships: (await pool.query('SELECT * FROM project_memberships ORDER BY id')).rows,
    requests: (await pool.query('SELECT * FROM request_records ORDER BY id')).rows,
  }
}
async function mutate(role: Role, id: string, operation: 'disable' | 'enable' | 'revoke') {
  const req = request(
    role,
    '/api/keys/' + id,
    operation === 'revoke' ? 'DELETE' : 'PATCH',
    operation === 'revoke' ? undefined : { enabled: operation === 'enable' },
  )
  return operation === 'revoke' ? revokeKey(req, params(id)) : patchKey(req, params(id))
}
it.each(roles.filter((role) => role !== 'admin'))(
  'omits a hidden-project Key from %s metadata listing',
  async (role) => {
    const id = await key(hidden)
    const project = await readProject(request(role, '/api/projects/' + hidden), params(hidden))
    expect(project.status).toBe(404)
    const before = await facts()
    const response = await listKeys(request(role, '/api/keys'))
    const body = await response.json()
    observations.push({
      name: 'list-hidden-' + role,
      status: response.status,
      hiddenKeyReturned: body.keys.some((row: { id: string }) => row.id === id),
      factsUnchanged: isDeepStrictEqual(before, await facts()),
    })
    expect(response.status).toBe(200)
    expect(body.keys.some((row: { id: string }) => row.id === id)).toBe(false)
    expect(isDeepStrictEqual(before, await facts())).toBe(true)
  },
)
it.each(['disable', 'enable', 'revoke'] as const)(
  'rejects developer %s of a hidden-project Key without facts or cache changes',
  async (operation) => {
    const id = await key(hidden, 'admin', operation !== 'enable')
    const before = await facts(),
      epoch = getRevocationEpoch()
    const response = await mutate('developer', id, operation)
    const body = await response.json(),
      after = await facts()
    observations.push({
      name: 'hidden-' + operation,
      status: response.status,
      factsUnchanged: isDeepStrictEqual(before, after),
      successAuditsAdded: after.audits.length - before.audits.length,
      outboxAdded: after.outbox.length - before.outbox.length,
      epochChanged: getRevocationEpoch() !== epoch,
    })
    expect(response.status).toBe(404)
    expect(body.error?.code).toBe('not_found')
    expect(isDeepStrictEqual(before, after)).toBe(true)
    expect(getRevocationEpoch()).toBe(epoch)
  },
)
it.each(['disable', 'revoke'] as const)('rejects developer %s of another owner unbound Key', async (operation) => {
  const id = await key(null)
  const before = await facts(),
    epoch = getRevocationEpoch()
  const response = await mutate('developer', id, operation)
  const after = await facts()
  observations.push({
    name: 'hidden-unbound-' + operation,
    status: response.status,
    factsUnchanged: isDeepStrictEqual(before, after),
    epochChanged: getRevocationEpoch() !== epoch,
  })
  expect(response.status).toBe(404)
  expect(isDeepStrictEqual(before, after)).toBe(true)
  expect(getRevocationEpoch()).toBe(epoch)
})
it.each([
  { role: 'developer' as const, project: visible, creator: 'admin' as const },
  { role: 'developer' as const, project: null, creator: 'developer' as const },
  { role: 'admin' as const, project: hidden, creator: 'admin' as const },
  { role: 'admin' as const, project: null, creator: 'developer' as const },
])('retains legitimate $role disable on $project created by $creator', async ({ role, project, creator }) => {
  const id = await key(project, creator)
  const response = await mutate(role, id, 'disable')
  expect(response.status).toBe(200)
  expect((await pool.query('SELECT enabled FROM downstream_api_keys WHERE id=$1', [id])).rows[0]?.enabled).toBe(false)
  expect(
    (await pool.query("SELECT count(*)::int n FROM audit_events WHERE target_id=$1 AND action='apikey.disabled'", [id]))
      .rows[0]?.n,
  ).toBe(1)
})
it('retains visible project and own-unbound metadata with secret-free response', async () => {
  const bound = await key(visible),
    own = await key(null, 'developer')
  const response = await listKeys(request('developer', '/api/keys'))
  const body = await response.json()
  expect(response.status).toBe(200)
  expect([bound, own].every((id) => body.keys.some((row: { id: string }) => row.id === id))).toBe(true)
  expect(
    body.keys.every(
      (row: Record<string, unknown>) => !['hash', 'fingerprint', 'token', 'plaintext'].some((field) => field in row),
    ),
  ).toBe(true)
})
it('retains actual Viewer write denial before Key mutation', async () => {
  const id = await key(visible),
    before = await facts()
  const response = await mutate('viewer', id, 'disable')
  expect(response.status).toBe(403)
  expect((await response.json()).error.code).toBe('forbidden')
  expect(isDeepStrictEqual(before, await facts())).toBe(true)
})

it.each([
  { role: 'developer' as const, project: visible, creator: 'admin' as const },
  { role: 'developer' as const, project: null, creator: 'developer' as const },
  { role: 'admin' as const, project: hidden, creator: 'admin' as const },
])('retains legitimate $role revoke on $project with audit and outbox', async ({ role, project, creator }) => {
  const id = await key(project, creator)
  const before = await facts(),
    epoch = getRevocationEpoch()
  const response = await mutate(role, id, 'revoke')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id, revoked: true })
  const after = await facts()
  const targetKey = after.keys.find((row) => row.id === id)
  expect(targetKey?.enabled).toBe(false)
  expect(targetKey?.revoked_at instanceof Date).toBe(true)
  expect(getRevocationEpoch()).toBe(epoch + 1)
  const audits = after.audits.filter((row) => row.target_id === id && row.action === 'apikey.revoked')
  expect(audits.length).toBe(1)
  expect([audits[0].actor_user_id, audits[0].tenant_id, audits[0].metadata]).toEqual([
    user(role),
    tenant,
    { revocationEpoch: epoch + 1 },
  ])
  const events = after.outbox.filter((row) => row.aggregate_id === id && row.event_type === 'api_key.revoked')
  expect(events.length).toBe(1)
  expect(events[0].payload).toEqual({ keyId: id, revocationEpoch: epoch + 1 })
  expect(
    isDeepStrictEqual(
      before.keys.filter((row) => row.id !== id),
      after.keys.filter((row) => row.id !== id),
    ),
  ).toBe(true)
  for (const name of ['projects', 'memberships', 'requests'] as const)
    expect(isDeepStrictEqual(before[name], after[name])).toBe(true)
})

it('retains actual recent-auth refusal for a visible Key', async () => {
  const id = await key(visible)
  const stale = await createSession({ userId: user('developer') })
  await pool.query("UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE id=$1", [stale.session.id])
  const before = await facts(),
    epoch = getRevocationEpoch()
  const response = await revokeKey(
    new Request('http://localhost/api/keys/' + id, {
      method: 'DELETE',
      headers: { cookie: `${SESSION_COOKIE}=${stale.token}; ${CSRF_COOKIE}=${csrf}`, [CSRF_HEADER]: csrf },
    }),
    params(id),
  )
  expect(response.status).toBe(401)
  expect((await response.json()).error.code).toBe('forbidden')
  expect(isDeepStrictEqual(before, await facts())).toBe(true)
  expect(getRevocationEpoch()).toBe(epoch)
})
