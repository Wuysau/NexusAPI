import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { hashPassword } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { GET as sessionEndpoint } from '@/app/api/auth/session/route'
import { POST as login } from '@/app/api/auth/login/route'
import { POST as reauthenticate } from '@/app/api/auth/reauth/route'
import { GET as readProjects, POST as createProject } from '@/app/api/projects/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent inactive-session DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid inactive-session fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_inactive_session_round66', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback inactive-session fixture required')

const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const password = 'Isolated fixture password 66'
const passwordHash = hashPassword(password)
const observations: Record<string, string | number | boolean>[] = []
let fixtureOwner: PoolClient | undefined
let sequence = 0

beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Inactive-session fixture database mismatch')
  const locked = await fixtureOwner.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
    ['nexus-inactive-session-fixture:' + target.pathname],
  )
  if (!locked.rows[0]?.locked) throw new Error('Inactive-session fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Inactive-session fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  expect(
    (
      await fixtureOwner.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='deleted_at'",
      )
    ).rows.length,
  ).toBe(1)
  const labels = await fixtureOwner.query<{ enumlabel: string }>(
    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='user_status' ORDER BY e.enumlabel",
  )
  expect(labels.rows.map((row) => row.enumlabel)).toEqual(['active', 'invited', 'suspended'])
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_INACTIVE_SESSION_REPORT === '1')
    console.info('Inactive-session safe observations:', JSON.stringify(observations))
  if (fixtureOwner) {
    await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
      'nexus-inactive-session-fixture:' + target.pathname,
    ])
    fixtureOwner.release()
  }
  await pool.end()
})

interface Fixture {
  user: string
  organization: string
  tenant: string
  email: string
  sessionId: string
  cookie: string
  csrf: string
}
async function fixture(): Promise<Fixture> {
  const name = 'inactive-session-' + ++sequence
  const user = name + '-user'
  const organization = name + '-org'
  const tenant = name + '-tenant'
  const email = name + '@example.invalid'
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [organization, tenant])
  // Omit status: an existing/default ACTIVE User must remain compatible.
  await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$1,$3)', [user, email, passwordHash])
  await pool.query(
    "INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,'admin')",
    [organization, tenant, user],
  )
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    name + '-private-project',
    tenant,
    organization,
  ])
  const session = await createSession({ userId: user })
  const csrf = issueCsrfToken()
  return {
    user,
    organization,
    tenant,
    email,
    sessionId: session.session.id,
    cookie: `${SESSION_COOKIE}=${session.token}`,
    csrf,
  }
}
function request(f: Fixture, path: string, method = 'GET', body?: unknown, validCsrf = true) {
  return new Request('http://localhost' + path, {
    method,
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: validCsrf ? f.csrf : 'mismatched-synthetic-csrf' }),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function facts(f: Fixture) {
  const domain: Record<string, unknown[]> = {}
  for (const table of ['projects', 'project_memberships', 'project_workspace_roots', 'owned_connections'])
    domain[table] = (
      await pool.query(
        `SELECT * FROM ${table} WHERE tenant_id=$1 ORDER BY ${table === 'project_workspace_roots' ? 'organization_id,root' : 'id'}`,
        [f.tenant],
      )
    ).rows
  return {
    domain,
    keys: (await pool.query('SELECT * FROM downstream_api_keys WHERE tenant_id=$1 ORDER BY id', [f.tenant])).rows,
    sessions: (await pool.query('SELECT * FROM sessions WHERE user_id=$1 ORDER BY id', [f.user])).rows,
    successAudits: Number(
      (
        await pool.query(
          "SELECT count(*)::text count FROM audit_events WHERE actor_user_id=$1 AND action IN ('project.created','auth.reauth_succeeded','session.created','session.revoked')",
          [f.user],
        )
      ).rows[0].count,
    ),
  }
}
async function protectedCalls(f: Fixture, kind: string) {
  const before = await facts(f)
  const session = await sessionEndpoint(request(f, '/api/auth/session'))
  const authenticated = (await session.json()).authenticated === true
  const read = await readProjects(request(f, '/api/projects'))
  const write = await createProject(request(f, '/api/projects', 'POST', { name: 'Protected mutation fixture' }))
  const after = await facts(f)
  const result = {
    kind,
    sessionStatus: session.status,
    authenticated,
    readStatus: read.status,
    writeStatus: write.status,
    domainUnchanged: isDeepStrictEqual(before.domain, after.domain),
    keysUnchanged: isDeepStrictEqual(before.keys, after.keys),
    sessionsUnchanged: isDeepStrictEqual(before.sessions, after.sessions),
    successAuditDelta: after.successAudits - before.successAudits,
  }
  observations.push(result)
  return result
}
function expectUnauthenticated(result: Awaited<ReturnType<typeof protectedCalls>>) {
  // Only statuses/counts/booleans reach assertion output; fixture rows/tokens never do.
  expect([
    result.sessionStatus,
    result.authenticated,
    result.readStatus,
    result.writeStatus,
    result.domainUnchanged,
    result.keysUnchanged,
    result.sessionsUnchanged,
    result.successAuditDelta,
  ]).toEqual([200, false, 401, 401, true, true, true, 0])
}

it.each(['suspended', 'invited', 'deleted'] as const)(
  'rejects an existing session after User becomes %s',
  async (kind) => {
    const f = await fixture()
    if (kind === 'deleted') await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [f.user])
    else await pool.query('UPDATE users SET status=$2 WHERE id=$1', [f.user, kind])
    const loginBefore = await facts(f)
    const freshLogin = await login(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: f.email, password }),
      }),
    )
    const loginAfter = await facts(f)
    expect(freshLogin.status).toBe(401)
    expect(isDeepStrictEqual(loginBefore.sessions, loginAfter.sessions)).toBe(true)
    observations.push({ kind: kind + '-fresh-login-control', status: freshLogin.status, sessionsUnchanged: true })
    expectUnauthenticated(await protectedCalls(f, kind))
  },
)

it('preserves a default ACTIVE legacy session and real project read/write', async () => {
  const result = await protectedCalls(await fixture(), 'active-control')
  expect([
    result.sessionStatus,
    result.authenticated,
    result.readStatus,
    result.writeStatus,
    result.domainUnchanged,
    result.keysUnchanged,
    result.sessionsUnchanged,
    result.successAuditDelta,
  ]).toEqual([200, true, 200, 201, false, true, true, 1])
})

it.each(['deleted', 'revoked', 'expired'] as const)(
  'continues rejecting a %s session without side effects',
  async (kind) => {
    const f = await fixture()
    if (kind === 'deleted') await pool.query('DELETE FROM sessions WHERE id=$1', [f.sessionId])
    else if (kind === 'revoked') await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [f.sessionId])
    else await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.sessionId])
    expectUnauthenticated(await protectedCalls(f, kind + '-session-control'))
  },
)

it('retains actual CSRF rejection before a valid-session project mutation', async () => {
  const f = await fixture()
  const before = await facts(f)
  const response = await createProject(request(f, '/api/projects', 'POST', { name: 'CSRF denied fixture' }, false))
  const after = await facts(f)
  const unchanged = isDeepStrictEqual(before, after)
  observations.push({ kind: 'csrf-control', status: response.status, protectedFactsUnchanged: unchanged })
  expect([response.status, unchanged]).toEqual([403, true])
})

it.each(['suspended', 'invited'] as const)('refuses session rotation for an existing %s User', async (kind) => {
  const f = await fixture()
  await pool.query('UPDATE users SET status=$2 WHERE id=$1', [f.user, kind])
  const before = await facts(f)
  const response = await reauthenticate(request(f, '/api/auth/reauth', 'POST', { password }))
  const after = await facts(f)
  const result = {
    kind: kind + '-reauth',
    status: response.status,
    cookiesIssued: response.headers.has('set-cookie'),
    sessionsUnchanged: isDeepStrictEqual(before.sessions, after.sessions),
    domainUnchanged: isDeepStrictEqual(before.domain, after.domain),
    keysUnchanged: isDeepStrictEqual(before.keys, after.keys),
    successAuditDelta: after.successAudits - before.successAudits,
  }
  observations.push(result)
  expect([
    result.status,
    result.cookiesIssued,
    result.sessionsUnchanged,
    result.domainUnchanged,
    result.keysUnchanged,
    result.successAuditDelta,
  ]).toEqual([401, false, true, true, true, 0])
})

it('preserves ACTIVE reauthentication and invalidates the original session', async () => {
  const f = await fixture()
  const response = await reauthenticate(request(f, '/api/auth/reauth', 'POST', { password }))
  const session = await sessionEndpoint(request(f, '/api/auth/session'))
  const count = (await pool.query('SELECT count(*)::text count FROM sessions WHERE user_id=$1', [f.user])).rows[0].count
  const authenticated = (await session.json()).authenticated === true
  observations.push({
    kind: 'active-reauth-control',
    status: response.status,
    sessionCount: Number(count),
    oldAuthenticated: authenticated,
  })
  expect([response.status, response.headers.has('set-cookie'), count, authenticated]).toEqual([200, true, '2', false])
})

it('retains organization membership removal as an independent denial', async () => {
  const f = await fixture()
  await pool.query('DELETE FROM organization_memberships WHERE user_id=$1', [f.user])
  expectUnauthenticated(await protectedCalls(f, 'membership-removed-control'))
})
