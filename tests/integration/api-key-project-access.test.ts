import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { sha256hex } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { GET as session } from '@/app/api/auth/session/route'
import { GET as listProjects } from '@/app/api/projects/route'
import { GET as getProject } from '@/app/api/projects/[id]/route'
import { GET as listKeys, POST as createKey } from '@/app/api/keys/route'

// Destructive setup accepts only the independent fixture or verified serial CI.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Explicit independent DATABASE_URL required')
let target: URL
try {
  target = new URL(databaseUrl)
} catch {
  throw new Error('Invalid independent DATABASE_URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_api_key_project_round62', '/convergence_ci15'].includes(target.pathname) ||
  databaseUrl.includes('?') ||
  databaseUrl.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback API key project database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'key-project-tenant'
const organization = 'key-project-org'
const csrf = 'key-project-csrf'
const roles = ['developer', 'owner', 'admin', 'viewer'] as const
type Role = (typeof roles)[number]
let cookies: Record<Role, string>
const userId = (role: Role) => `key-project-${role}`
const projectId = (name: string) => `key-project-${name}`
const params = (name: string) => ({ params: Promise.resolve({ id: projectId(name) }) })
const observations: Record<string, unknown>[] = []
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
  'providers',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'quota_snapshots',
  'external_observed_usage',
  'audit_events',
  'request_records',
  'attempts',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
] as const
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
interface KeyResponse {
  token?: string
  key?: { id: string; projectId: string | null }
  error?: { code: string; message: string }
}
interface CreateOptions {
  withCsrf?: boolean
  scopes?: string[]
  expiresAt?: string
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const request = (role: Role, pathname: string, body?: unknown, withCsrf = true) =>
  new Request(`http://localhost${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `${cookies[role]}; nexus_csrf=${csrf}`,
      ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name === target.pathname.slice(1)).toBe(true)
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  // One organization per tenant, as required by the canonical schema.
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES
      ($1,$2,'Key project fixture','key-project-org'),
      ('key-project-foreign-org','key-project-foreign-tenant','Other tenant','key-project-foreign-org')`,
    [organization, tenant],
  )
  cookies = {} as Record<Role, string>
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      userId(role),
      `${role}@key-project.example.invalid`,
      'synthetic-unused-password-hash',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [organization, tenant, userId(role), role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: userId(role) })).token}`
    const response = await session(request(role, '/api/auth/session'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.authenticated && body.freshAuth && body.role === role).toBe(true)
    expect(body.capabilities.includes('apikey:create')).toBe(role !== 'viewer')
  }
  for (const name of ['visible', 'private', 'inactive', 'archived'])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$4)', [
      projectId(name),
      tenant,
      organization,
      `Synthetic ${name}`,
    ])
  await pool.query(
    `INSERT INTO projects(id,tenant_id,organization_id,name)
      VALUES($1,'key-project-foreign-tenant','key-project-foreign-org','Other tenant project')`,
    [projectId('foreign')],
  )
  await pool.query("UPDATE projects SET status='inactive' WHERE id=$1", [projectId('inactive')])
  await pool.query("UPDATE projects SET status='archived',archived_at=now() WHERE id=$1", [projectId('archived')])
  for (const role of ['developer', 'viewer'] as const)
    for (const name of ['visible', 'inactive', 'archived'])
      await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
        tenant,
        projectId(name),
        userId(role),
      ])
  // A retained historical key makes accidental mutation observable without holding a real credential.
  await pool.query(
    `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,project_id,created_by)
      VALUES('key-project-history',$1,$2,'Synthetic history',$3,'sk-nx-',$4::jsonb,$5,$6)`,
    [
      organization,
      tenant,
      sha256hex('fixture-history'),
      JSON.stringify(['models:read']),
      projectId('visible'),
      userId('admin'),
    ],
  )
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_KEY_PROJECT_AUDIT_REPORT === '1')
    console.info('API key project safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('API key project fixture pool close timeout')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
})

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
const except = (value: Facts, excluded: readonly (typeof tables)[number][]) =>
  Object.fromEntries(tables.filter((table) => !excluded.includes(table)).map((table) => [table, value[table]]))
const createdAudits = (value: Facts) => value.audit_events.filter((row) => row.action === 'apikey.created')

async function invoke(name: string, role: Role, project?: string | null, options: CreateOptions = {}) {
  const before = await facts()
  const response = await createKey(
    request(
      role,
      '/api/keys',
      {
        name,
        ...(project === undefined ? {} : { projectId: project }),
        ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      },
      options.withCsrf !== false,
    ),
  )
  if (options.withCsrf === false)
    await expect
      .poll(
        async () =>
          (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='csrf.rejected'")).rows[0].n,
        { timeout: 3000 },
      )
      .toBe(1)
  const body = (await response.json()) as KeyResponse
  const after = await facts()
  const addedKeys = after.downstream_api_keys.filter(
    (row) => !before.downstream_api_keys.some((previous) => previous.id === row.id),
  )
  const addedAudits = createdAudits(after).filter(
    (row) => !before.audit_events.some((previous) => previous.id === row.id),
  )
  // Only fixed labels, status codes, counts and booleans leave the process.
  observations.push({
    name,
    status: response.status,
    code: ['tenant_isolation', 'project_not_found', 'forbidden', 'csrf_failed'].includes(body.error?.code ?? '')
      ? body.error?.code
      : null,
    returnedToken: typeof body.token === 'string',
    returnedKey: body.key !== undefined,
    keyDelta: after.downstream_api_keys.length - before.downstream_api_keys.length,
    successfulAuditDelta: createdAudits(after).length - createdAudits(before).length,
    createdKeyProjectMatches: addedKeys.length === 1 ? addedKeys[0].project_id === (project ?? null) : null,
    createdKeyTenantMatches: addedKeys.length === 1 ? addedKeys[0].tenant_id === tenant : null,
    createdAuditTargetMatches:
      addedKeys.length === 1 && addedAudits.length === 1 ? addedAudits[0].target_id === addedKeys[0].id : null,
    completeFactsUnchanged: isDeepStrictEqual(after, before),
  })
  if (typeof body.token === 'string') expect(JSON.stringify(after).includes(body.token)).toBe(false)
  same(
    except(after, ['downstream_api_keys', 'audit_events']),
    except(before, ['downstream_api_keys', 'audit_events']),
    'Key creation leaves workspace, credentials, sessions and accounting facts unchanged',
  )
  return { response, body, before, after }
}

function denied(result: Awaited<ReturnType<typeof invoke>>, status: number, codes: string[]) {
  expect(result.response.status).toBe(status)
  expect(codes.includes(result.body.error?.code ?? '')).toBe(true)
  same(Object.keys(result.body), ['error'], 'Denied creation returns no key, token or project facts')
  same(
    result.body.error,
    { code: result.body.error?.code, message: status === 404 ? '项目不存在' : result.body.error?.message },
    'Project denial uses the fixed management error',
  )
}

async function accepted(name: string, role: Role, project?: string | null, options: CreateOptions = {}) {
  const result = await invoke(name, role, project, options)
  expect(result.response.status).toBe(201)
  expect(typeof result.body.token === 'string' && /^sk-nx-[A-Za-z0-9_-]+$/.test(result.body.token)).toBe(true)
  const token = result.body.token as string
  const key = result.after.downstream_api_keys.filter(
    (row) => !result.before.downstream_api_keys.some((previous) => previous.id === row.id),
  )
  expect(key.length).toBe(1)
  const row = key[0]
  const scopes = [...new Set(options.scopes ?? ['chat:write'])]
  expect(row.hash === sha256hex(token) && row.fingerprint === sha256hex(token).slice(0, 16)).toBe(true)
  same(
    { ...row, id: null, hash: null, fingerprint: null, created_at: null },
    {
      id: null,
      organization_id: organization,
      tenant_id: tenant,
      name,
      hash: null,
      prefix: 'sk-nx-',
      fingerprint: null,
      scopes,
      project_id: project ?? null,
      enabled: true,
      expires_at: options.expiresAt ? new Date(options.expiresAt) : null,
      last_used_at: null,
      revoked_at: null,
      created_by: userId(role),
      created_at: null,
      deleted_at: null,
    },
    'The new key preserves tenant, organization, actor, scopes, expiry and exact project attribution',
  )
  same(
    result.body.key,
    {
      id: row.id,
      name,
      prefix: 'sk-nx-',
      scopes,
      enabled: true,
      expiresAt: options.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: (row.created_at as Date).toISOString(),
      status: 'active',
      projectId: project ?? null,
    },
    'The one-time response exposes the safe key projection',
  )
  same(
    result.after.downstream_api_keys.filter((row) => row.id !== key[0].id),
    result.before.downstream_api_keys,
    'Existing keys remain unchanged',
  )
  const audits = result.after.audit_events.filter(
    (row) => !result.before.audit_events.some((previous) => previous.id === row.id),
  )
  expect(audits.length).toBe(1)
  const audit = audits[0]
  same(
    { ...audit, id: null, created_at: null },
    {
      id: null,
      tenant_id: tenant,
      actor_user_id: userId(role),
      action: 'apikey.created',
      target_type: 'downstream_api_key',
      target_id: row.id,
      metadata: { name, scopes, prefix: 'sk-nx-', fingerprint: row.fingerprint, expiresAt: options.expiresAt ?? null },
      ip: '127.0.0.1',
      trace_id: null,
      created_at: null,
    },
    'Key creation appends exactly one audit with existing attribution metadata',
  )
  same(
    result.after.audit_events.filter((row) => row.id !== audit.id),
    result.before.audit_events,
    'Existing audit history remains unchanged',
  )
  expect(JSON.stringify(result.after).includes(token)).toBe(false)
  const listed = await listKeys(request(role, '/api/keys'))
  expect(listed.status).toBe(200)
  expect(JSON.stringify(await listed.json()).includes(token)).toBe(false)
  same(await facts(), result.after, 'Listing keys neither persists plaintext nor changes domain facts')
}

it('denies key issuance for an active private project hidden by the actual project routes', async () => {
  const detail = await getProject(request('developer', `/api/projects/${projectId('private')}`), params('private'))
  expect(detail.status).toBe(404)
  same(
    await detail.json(),
    { error: { code: 'tenant_isolation', message: '项目不存在' } },
    'The actual project route already hides the private project',
  )
  const list = await listProjects(request('developer', '/api/projects'))
  expect(list.status).toBe(200)
  const ids = (await list.json()).projects.map((row: { id: string }) => row.id)
  expect(ids.includes(projectId('visible')) && !ids.includes(projectId('private'))).toBe(true)
  const result = await invoke('hidden_project', 'developer', projectId('private'))
  denied(result, 404, ['tenant_isolation'])
  same(result.after, result.before, 'Hidden project issuance creates no key or successful audit')
})

it('allows project members and retains inactive but unarchived project behavior', async () => {
  const expiresAt = new Date(Date.now() + 3600000).toISOString()
  for (const name of ['visible', 'inactive']) {
    const detail = await getProject(request('developer', `/api/projects/${projectId(name)}`), params(name))
    expect(detail.status).toBe(200)
    await accepted(`member_${name}`, 'developer', projectId(name), {
      scopes: ['models:read', 'chat:write', 'models:read'],
      expiresAt,
    })
  }
})

it('preserves owner and admin access to organization projects without individual membership', async () => {
  for (const role of ['owner', 'admin'] as const) {
    expect((await getProject(request(role, `/api/projects/${projectId('private')}`), params('private'))).status).toBe(
      200,
    )
    await accepted(`${role}_private`, role, projectId('private'))
  }
})

it('preserves omitted and null project bindings and default key scopes', async () => {
  await accepted('omitted_project', 'developer')
  await accepted('null_project', 'developer', null)
})

it('keeps foreign and missing projects inaccessible without key or audit changes', async () => {
  for (const name of ['foreign', 'missing']) {
    const detail = await getProject(request('admin', `/api/projects/${projectId(name)}`), params(name))
    expect(detail.status).toBe(404)
    expect((await detail.json()).error.code).toBe('tenant_isolation')
    const result = await invoke(`${name}_project`, 'admin', projectId(name))
    // The existing tenant-only check and managed-project resolver use these respective fixed codes.
    denied(result, 404, ['project_not_found', 'tenant_isolation'])
    same(result.after, result.before, 'Unresolvable project creates no key or successful audit')
  }
})

it('retains the original archived-project rejection for an otherwise visible project', async () => {
  expect(
    (await getProject(request('developer', `/api/projects/${projectId('archived')}`), params('archived'))).status,
  ).toBe(200)
  const result = await invoke('archived_project', 'developer', projectId('archived'))
  denied(result, 404, ['project_not_found'])
  same(result.after, result.before, 'Archived project creates no key or successful audit')
})

it('retains the key-creation capability and legitimate CSRF rejection audit', async () => {
  const viewer = await invoke('viewer_denied', 'viewer', projectId('visible'))
  denied(viewer, 403, ['forbidden'])
  same(viewer.after, viewer.before, 'A project viewer cannot create keys or successful audits')
  const csrfResult = await invoke('csrf_denied', 'developer', projectId('visible'), { withCsrf: false })
  denied(csrfResult, 403, ['csrf_failed'])
  same(
    except(csrfResult.after, ['audit_events']),
    except(csrfResult.before, ['audit_events']),
    'CSRF rejection changes no keys, workspace or accounting facts',
  )
  same(
    createdAudits(csrfResult.after),
    createdAudits(csrfResult.before),
    'CSRF rejection creates no successful key audit',
  )
  const audits = csrfResult.after.audit_events.filter(
    (row) => !csrfResult.before.audit_events.some((previous) => previous.id === row.id),
  )
  expect(audits.length).toBe(1)
  expect(audits[0].action).toBe('csrf.rejected')
  same(
    audits[0].metadata,
    { method: 'POST', hadHeaderToken: false, hadCookieToken: true },
    'CSRF auditing retains only the existing nonsecret diagnostic fields',
  )
})
