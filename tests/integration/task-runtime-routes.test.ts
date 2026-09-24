import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as taskRoutes from '@/app/api/task-runtime/route'
import * as policyRoutes from '@/app/api/task-runtime/policy/route'
import * as switchRoutes from '@/app/api/task-runtime/[id]/switch/route'
import * as resumeRoutes from '@/app/api/task-runtime/[id]/resume/route'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'

const launch = vi.hoisted(() => ({
  called: vi.fn(() => {
    throw new Error('HTTP task routes must never launch a process')
  }),
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const guarded = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map((name) => [name, launch.called]),
  )
  return { ...actual, ...guarded, default: { ...actual, ...guarded } }
})

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
// Additive, namespaced fixtures keep this suite safe to combine with other route tests.
const prefix = 'task-route-' + randomUUID()
const id = (name: string) => prefix + '-' + name
const csrf = issueCsrfToken()
const cookies: Record<string, string> = {}
function request(role: string, path: string, method = 'GET', body?: unknown, csrfMode = 'valid') {
  return new Request('http://localhost' + path, {
    method,
    headers: {
      cookie: `${cookies[role] ?? ''}; ${CSRF_COOKIE}=${csrf}`,
      ...(csrfMode === 'missing' ? {} : { [CSRF_HEADER]: csrfMode === 'valid' ? csrf : 'mismatched-token' }),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const params = (name: string) => ({ params: Promise.resolve({ id: id(name) }) })
const candidate = (name: string) => ({
  connectionId: id(name),
  profileRef: name,
  priority: 1,
  enabled: true,
  switchThreshold: 90,
  capabilities: ['coding', 'tool_calling'],
  allowedModels: [],
  allowedTools: ['codex'],
  costMode: 'subscription',
})
const policy = () => ({
  name: 'Route test',
  workload: 'coding-agent-high',
  requiredCapabilities: ['coding', 'tool_calling'],
  tool: 'codex',
  model: null,
  autoFailover: true,
  autoReturn: false,
  candidates: [candidate('connection-a'), { ...candidate('connection-b'), priority: 2 }],
})
const save = (role: string, body: unknown = { projectId: id('project-a'), policy: policy() }, csrfMode = 'valid') =>
  policyRoutes.PUT(request(role, '/api/task-runtime/policy', 'PUT', body, csrfMode))
const read = (role: string, project: string) =>
  taskRoutes.GET(request(role, '/api/task-runtime?projectId=' + encodeURIComponent(id(project))))
const switchTask = (
  role: string,
  task = 'task-running',
  body: unknown = { targetConnectionId: id('connection-b') },
  csrfMode = 'valid',
) => switchRoutes.POST(request(role, '/api/task-runtime/' + id(task) + '/switch', 'POST', body, csrfMode), params(task))
const resume = (role: string, task = 'task-paused', body: unknown = {}, csrfMode = 'valid') =>
  resumeRoutes.POST(request(role, '/api/task-runtime/' + id(task) + '/resume', 'POST', body, csrfMode), params(task))

beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  for (const [organization, tenant] of [
    ['org', 'tenant'],
    ['foreign-org', 'foreign-tenant'],
  ])
    await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [
      id(organization),
      id(tenant),
    ])
  for (const role of ['owner', 'viewer', 'developer', 'foreign-owner']) {
    await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$1,$3)', [
      id(role),
      id(role) + '@example.invalid',
      'synthetic-hash',
    ])
    const foreign = role === 'foreign-owner'
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [
        id(foreign ? 'foreign-org' : 'org'),
        id(foreign ? 'foreign-tenant' : 'tenant'),
        id(role),
        foreign ? 'owner' : role,
      ],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: id(role) })).token}`
  }
  for (const [project, organization, tenant] of [
    ['project-a', 'org', 'tenant'],
    ['project-unassigned', 'org', 'tenant'],
    ['project-foreign', 'foreign-org', 'foreign-tenant'],
  ])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
      id(project),
      id(tenant),
      id(organization),
    ])
  for (const role of ['viewer', 'developer'])
    await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
      id('tenant'),
      id('project-a'),
      id(role),
    ])
  for (const [connection, project, tenant] of [
    ['connection-a', 'project-a', 'tenant'],
    ['connection-b', 'project-a', 'tenant'],
    ['connection-unassigned', 'project-unassigned', 'tenant'],
    ['connection-foreign', 'project-foreign', 'foreign-tenant'],
  ])
    await pool.query(
      "INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,status,capabilities) VALUES($1,$2,$3,'openai','subscription_interactive','active',$4)",
      [
        id(connection),
        id(tenant),
        id(project),
        JSON.stringify({ connection_type: 'subscription', execution_mode: 'interactive', routing: false }),
      ],
    )
  for (const [task, status, project, organization, tenant] of [
    ['task-running', 'running', 'project-a', 'org', 'tenant'],
    ['task-paused', 'paused', 'project-a', 'org', 'tenant'],
    ['task-unassigned', 'running', 'project-unassigned', 'org', 'tenant'],
    ['task-foreign', 'running', 'project-foreign', 'foreign-org', 'foreign-tenant'],
  ])
    await pool.query(
      "INSERT INTO nexus_tasks(id,tenant_id,organization_id,project_id,original_goal,cwd,status,active_resource,context) VALUES($1,$2,$3,$4,$1,'/registered/workspace',$5,$6,$7)",
      [
        id(task),
        id(tenant),
        id(organization),
        id(project),
        status,
        id('connection-a'),
        JSON.stringify({ privateMarker: 'do-not-return-context' }),
      ],
    )
  expect((await save('owner')).status).toBe(200)
}, 30000)

afterAll(async () => {
  await pool.end()
})

it('requires an authenticated session and a selected project', async () => {
  expect((await read('anonymous', 'project-a')).status).toBe(401)
  expect((await taskRoutes.GET(request('owner', '/api/task-runtime'))).status).toBe(400)
})

it('allows project readers and isolates tenant, organization and unassigned projects', async () => {
  for (const role of ['owner', 'viewer', 'developer']) {
    const response = await read(role, 'project-a')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.tasks.map((task: { id: string }) => task.id).sort()).toEqual(
      [id('task-paused'), id('task-running')].sort(),
    )
    expect(body.policy).toEqual(policy())
    expect(body.resources).toHaveLength(2)
    expect(
      body.resources.every(
        (resource: { quotaState: string; usedPercent: null }) =>
          resource.quotaState === 'unknown' && resource.usedPercent === null,
      ),
    ).toBe(true)
    expect(JSON.stringify(body)).not.toContain('do-not-return-context')
  }
  const inaccessible = []
  for (const project of ['project-unassigned', 'project-foreign', 'missing']) {
    const response = await read('developer', project)
    expect(response.status).toBe(404)
    inaccessible.push(await response.json())
  }
  for (const body of inaccessible) expect(body).toEqual(inaccessible[0])
  expect((await read('owner', 'project-foreign')).status).toBe(404)
  expect((await read('foreign-owner', 'project-a')).status).toBe(404)
})

it('rejects viewer writes, including policy save, switch and recovery', async () => {
  expect((await save('viewer')).status).toBe(403)
  expect((await switchTask('viewer')).status).toBe(403)
  expect((await resume('viewer')).status).toBe(403)
})

it('write capability cannot bypass project membership or tenant and organization scope', async () => {
  for (const project of ['project-unassigned', 'project-foreign', 'missing'])
    expect((await save('developer', { projectId: id(project), policy: policy() })).status).toBe(404)
  for (const task of ['task-unassigned', 'task-foreign', 'missing']) {
    expect((await switchTask('developer', task)).status).toBe(404)
    expect((await resume('developer', task)).status).toBe(404)
  }
  expect((await switchTask('foreign-owner')).status).toBe(404)
})

it('enforces missing and mismatched CSRF on every mutation', async () => {
  for (const mode of ['missing', 'mismatched']) {
    for (const response of [
      await save('owner', undefined, mode),
      await switchTask('owner', undefined, undefined, mode),
      await resume('owner', undefined, undefined, mode),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'csrf_failed' } })
    }
  }
})

it('accepts profile references only, rejecting local paths and credential configuration', async () => {
  for (const extra of [{ cwd: '/unregistered' }, { authConfig: { apiKey: 'synthetic-credential-marker' } }]) {
    expect((await save('owner', { projectId: id('project-a'), policy: policy(), ...extra })).status).toBe(400)
    expect(
      (await switchTask('owner', 'task-running', { targetConnectionId: id('connection-b'), ...extra })).status,
    ).toBe(400)
    expect((await resume('owner', 'task-paused', extra)).status).toBe(400)
  }
  for (const patch of [
    { profileRef: '/home/private/.codex' },
    { profileRef: 'C:\\private\\auth.json' },
    { home: '/private' },
    { authConfig: { token: 'synthetic-credential-marker' } },
  ]) {
    const invalid = policy()
    Object.assign(invalid.candidates[0], patch)
    expect((await save('owner', { projectId: id('project-a'), policy: invalid })).status).toBe(400)
  }
  const persisted = (
    await pool.query('SELECT policy FROM resource_routing_policies WHERE project_id=$1', [id('project-a')])
  ).rows[0].policy
  expect(persisted).toEqual(policy())
})

it('rejects foreign and other-project candidate connections', async () => {
  for (const connection of ['connection-foreign', 'connection-unassigned', 'missing']) {
    const response = await save('owner', {
      projectId: id('project-a'),
      policy: { ...policy(), candidates: [candidate(connection)] },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'inaccessible_policy_connection' } })
    expect((await switchTask('owner', 'task-running', { targetConnectionId: id(connection) })).status).toBe(400)
  }
})

it.each([{ body: [] }, { body: true }, { body: 42 }])(
  'rejects a non-object recovery body ($body)',
  async ({ body }) => {
    const task = 'malformed-' + randomUUID()
    await pool.query(
      "INSERT INTO nexus_tasks(id,tenant_id,organization_id,project_id,original_goal,cwd,status) VALUES($1,$2,$3,$4,'Malformed request fixture','/registered/workspace','paused')",
      [id(task), id('tenant'), id('org'), id('project-a')],
    )
    expect((await resume('owner', task, body)).status).toBe(400)
    expect(
      (await pool.query('SELECT requested_action FROM nexus_tasks WHERE id=$1', [id(task)])).rows[0].requested_action,
    ).toBeNull()
  },
)

it('queues the owner manual switch and recovery without launching or creating sessions', async () => {
  const switched = await switchTask('owner')
  expect(switched.status).toBe(202)
  expect(await switched.json()).toEqual({ queued: true })
  const resumed = await resume('owner')
  expect(resumed.status).toBe(202)
  expect(await resumed.json()).toEqual({ queued: true })
  const rows = (
    await pool.query(
      'SELECT id,status,active_resource,requested_action,requested_connection_id,command_seq FROM nexus_tasks WHERE project_id=$1 ORDER BY id',
      [id('project-a')],
    )
  ).rows
  expect(rows.find((row) => row.id === id('task-running'))).toMatchObject({
    status: 'running',
    active_resource: id('connection-a'),
    requested_action: 'switch',
    requested_connection_id: id('connection-b'),
    command_seq: 1,
  })
  expect(rows.find((row) => row.id === id('task-paused'))).toMatchObject({
    status: 'paused',
    requested_action: 'resume',
    requested_connection_id: null,
    command_seq: 1,
  })
  expect((await switchTask('owner')).status).toBe(409)
  expect((await resume('owner')).status).toBe(409)
  expect(
    (await pool.query('SELECT count(*) FROM task_sessions WHERE tenant_id=$1', [id('tenant')])).rows[0].count,
  ).toBe('0')
  expect(
    (await pool.query('SELECT count(*) FROM task_handoff_snapshots WHERE tenant_id=$1', [id('tenant')])).rows[0].count,
  ).toBe('0')
  expect(
    (await pool.query('SELECT count(*) FROM ledger_transactions WHERE tenant_id=$1', [id('tenant')])).rows[0].count,
  ).toBe('0')
  expect(launch.called).not.toHaveBeenCalled()
})
