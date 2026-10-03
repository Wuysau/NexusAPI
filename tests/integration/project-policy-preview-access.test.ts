import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { GET as listProjects } from '@/app/api/projects/route'
import { GET as getProject } from '@/app/api/projects/[id]/route'
import { GET as listConnections } from '@/app/api/connections/route'
import { GET as listResources } from '@/app/api/resources/route'
import { POST as preview } from '@/app/api/projects/[id]/policy-preview/route'

// Destructive setup is limited to the independent fixture or serial CI.
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
  !['/workspace_access_policy_preview_round58', '/convergence_ci15'].includes(target.pathname) ||
  databaseUrl.includes('?') ||
  databaseUrl.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback policy preview database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'preview-tenant'
const organization = 'preview-org'
const csrf = 'preview-synthetic-csrf'
const model = 'preview-synthetic-model'
const roles = ['viewer', 'developer', 'owner', 'admin', 'billing'] as const
type Role = (typeof roles)[number]
let cookies: Record<Role, string>
const userId = (role: Role) => `preview-${role}`
const projectId = (name: string) => `preview-${name}-project`
const connectionId = (name: string) => `preview-${name}-connection`
const params = (name: string) => ({ params: Promise.resolve({ id: projectId(name) }) })
const observations: Record<string, unknown>[] = []
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'project_memberships',
  'projects',
  'project_workspace_roots',
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
const request = (role: Role, url: string, body?: unknown, withCsrf = true) =>
  new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `${cookies[role]}; nexus_csrf=${csrf}`,
      ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(target.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  // The canonical schema permits one organization per tenant.
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES
      ($1,$2,'Preview fixture','preview-org'),
      ('preview-foreign-org','preview-foreign-tenant','Other tenant','preview-foreign-org')`,
    [organization, tenant],
  )
  cookies = {} as Record<Role, string>
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      userId(role),
      `${role}@preview.example.invalid`,
      'synthetic-unused-password-hash',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [organization, tenant, userId(role), role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: userId(role) })).token}`
  }
  for (const name of ['visible', 'second-visible', 'private', 'archived'])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$4)', [
      projectId(name),
      tenant,
      organization,
      `Synthetic ${name}`,
    ])
  await pool.query(
    `INSERT INTO projects(id,tenant_id,organization_id,name)
     VALUES($1,'preview-foreign-tenant','preview-foreign-org','Other tenant project')`,
    [projectId('foreign')],
  )
  await pool.query("UPDATE projects SET status='archived',archived_at=now() WHERE id=$1", [projectId('archived')])
  for (const role of ['viewer', 'developer'] as const)
    for (const name of ['visible', 'second-visible', 'archived'])
      await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
        tenant,
        projectId(name),
        userId(role),
      ])
  for (const [name, scope, binding, owner] of [
    ['visible', tenant, projectId('visible'), userId('admin')],
    ['second-visible', tenant, projectId('second-visible'), userId('admin')],
    ['private', tenant, projectId('private'), userId('admin')],
    ['viewer-unbound', tenant, null, userId('viewer')],
    ['developer-unbound', tenant, null, userId('developer')],
    ['other-unbound', tenant, null, userId('admin')],
    ['foreign', 'preview-foreign-tenant', projectId('foreign'), null],
    ['revoked', tenant, projectId('visible'), userId('admin')],
  ])
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,project_id,owner_user_id,provider,mode,status,capabilities)
       VALUES($1,$2,$3,$4,'fixture','external_endpoint','active',$5::jsonb)`,
      [connectionId(String(name)), scope, binding, owner, JSON.stringify({ operations: ['chat'] })],
    )
  await pool.query("UPDATE owned_connections SET status='revoked',revoked_at=now() WHERE id=$1", [
    connectionId('revoked'),
  ])
}, 30000)

afterAll(async () => {
  // Reports contain fixed labels, status codes, counts and booleans only.
  if (process.env.NEXUS_POLICY_PREVIEW_AUDIT_REPORT === '1')
    console.info('Policy preview safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Policy preview fixture pool close timeout')), 5000)
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
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const withoutAudit = (value: Facts) =>
  Object.fromEntries(tables.filter((table) => table !== 'audit_events').map((table) => [table, value[table]]))
const previewAudits = (value: Facts) => value.audit_events.filter((row) => row.action === 'policy.previewed')

async function visibility(role: Role) {
  const projectResponse = await listProjects(request(role, '/api/projects'))
  const connectionResponse = await listConnections(request(role, '/api/connections'))
  const resourceResponse = await listResources(request(role, '/api/resources'))
  expect(projectResponse.status).toBe(200)
  expect(connectionResponse.status).toBe(200)
  expect(resourceResponse.status).toBe(200)
  return {
    projects: (await projectResponse.json()).projects.map((row: { id: string }) => row.id) as string[],
    connections: (await connectionResponse.json()).connections.map((row: { id: string }) => row.id) as string[],
    resources: (await resourceResponse.json()).resources.map(
      (row: { connectionId: string | null }) => row.connectionId,
    ),
  }
}
async function invoke(role: Role, project: string, connection: string, operation?: string, withCsrf = true) {
  const before = await facts()
  const response = await preview(
    request(
      role,
      `/api/projects/${projectId(project)}/policy-preview`,
      { connectionId: connectionId(connection), model, ...(operation === undefined ? {} : { operation }) },
      withCsrf,
    ),
    params(project),
  )
  if (!withCsrf)
    await expect
      .poll(
        async () =>
          (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='csrf.rejected'")).rows[0].n,
        { timeout: 3000 },
      )
      .toBe(1)
  const after = await facts()
  const body = await response.json()
  observations.push({
    name: `${role}_${project}_${connection}_${operation ?? 'default'}${withCsrf ? '' : '_csrf_denial'}`,
    status: response.status,
    code: ['tenant_isolation', 'not_found', 'csrf_failed'].includes(body.error?.code) ? body.error.code : null,
    returnedConnection: body.connection !== undefined,
    returnedDecision: body.decision !== undefined,
    allowed: typeof body.decision?.allowed === 'boolean' ? body.decision.allowed : null,
    domainUnchanged: isDeepStrictEqual(withoutAudit(after), withoutAudit(before)),
    completeFactsUnchanged: isDeepStrictEqual(after, before),
    successfulAuditDelta: previewAudits(after).length - previewAudits(before).length,
  })
  // This holds even on the OLD unauthorized-success characterization.
  same(withoutAudit(after), withoutAudit(before), 'Policy preview does not change domain or accounting facts')
  return { response, body, before, after }
}

it.each([
  { name: 'hidden project', role: 'viewer' as const, project: 'private', connection: 'visible' },
  { name: 'hidden project connection', role: 'developer' as const, project: 'visible', connection: 'private' },
  {
    name: 'another owner’s unbound connection',
    role: 'viewer' as const,
    project: 'visible',
    connection: 'other-unbound',
  },
])('denies a preview of $name already hidden by the actual resource routes', async ({ role, project, connection }) => {
  const visible = await visibility(role)
  expect(visible.projects.includes(projectId('visible'))).toBe(true)
  expect(visible.projects.includes(projectId('private'))).toBe(false)
  expect(visible.connections.includes(connectionId('visible'))).toBe(true)
  expect(visible.connections.includes(connectionId('private'))).toBe(false)
  expect(visible.connections.includes(connectionId('other-unbound'))).toBe(false)
  expect(visible.resources.includes(connectionId('visible'))).toBe(true)
  expect(visible.resources.includes(connectionId('private'))).toBe(false)
  expect(visible.resources.includes(connectionId('other-unbound'))).toBe(false)
  const hiddenProject = await getProject(request(role, `/api/projects/${projectId('private')}`), params('private'))
  expect(hiddenProject.status).toBe(404)
  expect((await hiddenProject.json()).error.code).toBe('tenant_isolation')
  const result = await invoke(role, project, connection)
  expect(result.response.status).toBe(404)
  expect(result.body.error?.code).toBe(project === 'private' ? 'tenant_isolation' : 'not_found')
  expect(result.body.projectId).toBeUndefined()
  expect(result.body.connection).toBeUndefined()
  expect(result.body.decision).toBeUndefined()
  same(result.after, result.before, 'Invisible preview preserves complete facts and successful audits')
})

async function accepted(role: Role, project: string, connection: string, operation?: string, reason?: string) {
  const result = await invoke(role, project, connection, operation)
  expect(result.response.status).toBe(200)
  expect(result.body.projectId).toBe(projectId(project))
  same(
    result.body.connection,
    {
      id: connectionId(connection),
      provider: 'fixture',
      mode: 'external_endpoint',
      status: connection === 'revoked' ? 'revoked' : 'active',
    },
    'Authorized preview returns the exact visible connection projection',
  )
  const decision = reason ? { allowed: false, reason } : { allowed: true }
  same(result.body.decision, decision, 'Authorized preview preserves existing capability and revocation decisions')
  expect(result.body.alternatives.length).toBe(reason ? 1 : 0)
  expect(result.after.audit_events.length - result.before.audit_events.length).toBe(1)
  const audits = previewAudits(result.after).filter(
    (row) => !previewAudits(result.before).some((old) => old.id === row.id),
  )
  expect(audits.length).toBe(1)
  const audit = audits[0]
  expect(audit.tenant_id).toBe(tenant)
  expect(audit.actor_user_id).toBe(userId(role))
  expect(audit.target_type).toBe('project')
  expect(audit.target_id).toBe(projectId(project))
  same(
    audit.metadata,
    { connectionId: connectionId(connection), operation: operation ?? 'chat', model, decision },
    'Preview audit preserves exact attribution',
  )
}

it('allows actual developer and viewer project members, including another visible project connection', async () => {
  for (const role of ['developer', 'viewer'] as const) {
    expect((await getProject(request(role, `/api/projects/${projectId('visible')}`), params('visible'))).status).toBe(
      200,
    )
    await accepted(role, 'visible', 'visible')
    // A preview does not create a binding between the chosen project and connection.
    await accepted(role, 'visible', 'second-visible', 'chat')
  }
})
it('allows each ordinary member to preview their own unbound connection', async () => {
  for (const role of ['developer', 'viewer'] as const) {
    const connection = `${role}-unbound`
    const visible = await visibility(role)
    expect(visible.connections.includes(connectionId(connection))).toBe(true)
    expect(visible.resources.includes(connectionId(connection))).toBe(true)
    await accepted(role, 'visible', connection)
  }
})
it('preserves owner, admin and billing access to organization projects and other owners’ connections', async () => {
  for (const role of ['owner', 'admin', 'billing'] as const) {
    const visible = await visibility(role)
    expect(visible.projects.includes(projectId('private'))).toBe(true)
    expect(visible.connections.includes(connectionId('private'))).toBe(true)
    expect(visible.connections.includes(connectionId('other-unbound'))).toBe(true)
    await accepted(role, 'private', 'private')
    await accepted(role, 'visible', 'other-unbound')
  }
})
it('retains the readable revoked-connection and unsupported-operation decisions', async () => {
  await accepted('viewer', 'visible', 'revoked', 'chat', 'connection_revoked')
  await accepted('developer', 'visible', 'visible', 'embeddings', 'operation_not_supported')
})
it('retains foreign-tenant, missing-resource and archived-project denials without successful audits', async () => {
  for (const [project, connection] of [
    ['foreign', 'visible'],
    ['visible', 'foreign'],
    ['missing', 'visible'],
    ['visible', 'missing'],
    ['archived', 'visible'],
  ]) {
    const result = await invoke('owner', project, connection)
    expect(result.response.status).toBe(404)
    // Managed-project authorization uses tenant_isolation; absent connections use not_found.
    expect(['tenant_isolation', 'not_found'].includes(result.body.error?.code)).toBe(true)
    expect(result.body.connection).toBeUndefined()
    expect(result.body.decision).toBeUndefined()
    same(result.after, result.before, 'Unresolvable preview preserves all facts and successful audits')
  }
})
it('keeps the legitimate CSRF rejection audit without preview success or domain writes', async () => {
  const result = await invoke('viewer', 'visible', 'visible', undefined, false)
  expect(result.response.status).toBe(403)
  expect(result.body.error?.code).toBe('csrf_failed')
  same(previewAudits(result.after), previewAudits(result.before), 'CSRF rejection appends no successful preview audit')
  expect(result.after.audit_events.length - result.before.audit_events.length).toBe(1)
  const newAudit = result.after.audit_events.find((row) => !result.before.audit_events.some((old) => old.id === row.id))
  expect(newAudit?.action).toBe('csrf.rejected')
})
