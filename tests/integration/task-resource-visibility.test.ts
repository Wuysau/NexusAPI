import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { GET as listConnections } from '@/app/api/connections/route'
import { GET as readQuota } from '@/app/api/connections/[id]/quota/route'
import { GET as readTasks } from '@/app/api/task-runtime/route'
import { PUT as savePolicy } from '@/app/api/task-runtime/policy/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent task-resource DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid task-resource fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_task_resources_round71', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback task-resource fixture required')

pool.options.statement_timeout = 8000
pool.options.lock_timeout = 6000
pool.options.idle_in_transaction_session_timeout = 10000
pool.options.connectionTimeoutMillis = 4000
const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const tenant = 'task-resource71-tenant'
const organization = 'task-resource71-org'
const project = 'task-resource71-project'
const foreignTenant = 'task-resource71-foreign-tenant'
const foreignOrganization = 'task-resource71-foreign-org'
const csrf = issueCsrfToken()
const roles = ['developer', 'viewer', 'admin', 'owner'] as const
type Role = (typeof roles)[number]
type Connection =
  'developer-unbound' | 'viewer-unbound' | 'other-unbound' | 'project-bound' | 'foreign-organization' | 'foreign-tenant'
const connectionId = (name: Connection) => 'task-resource71-' + name
const userId = (role: Role) => 'task-resource71-' + role
const hiddenProvider = 'fixture-private-provider71'
const foreignProvider = 'fixture-foreign-provider71'
const hiddenReset = '2098-02-03T04:05:06.000Z'
const visibleReset = '2099-01-01T00:00:00.000Z'
const foreignReset = '2097-02-03T04:05:06.000Z'
const cookies = {} as Record<Role, string>
const observations: Record<string, string | number | boolean>[] = []
let fixtureOwner: PoolClient | undefined
let fixtureLocked = false

function policy(names: Connection[]) {
  return {
    name: 'Task resource fixture policy',
    workload: 'coding-agent-high',
    requiredCapabilities: ['coding', 'tool_calling'],
    tool: 'codex',
    model: null,
    autoFailover: true,
    autoReturn: false,
    candidates: names.map((name, index) => ({
      connectionId: connectionId(name),
      profileRef: 'fixture-profile-' + name,
      priority: index + 1,
      enabled: true,
      switchThreshold: 90,
      capabilities: ['coding', 'tool_calling'],
      allowedModels: [],
      allowedTools: ['codex'],
      costMode: 'subscription',
    })),
  }
}
async function seedPolicy(names: Connection[]) {
  await pool.query(
    `INSERT INTO resource_routing_policies(tenant_id,organization_id,project_id,policy) VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT(tenant_id,organization_id,project_id) DO UPDATE SET policy=excluded.policy,updated_at=now()`,
    [tenant, organization, project, JSON.stringify(policy(names))],
  )
}
beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Task-resource fixture database mismatch')
  fixtureLocked = (
    await fixtureOwner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
      'nexus-task-resource-fixture:' + target.pathname,
    ])
  ).rows[0]?.locked
  if (!fixtureLocked) throw new Error('Task-resource fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Task-resource fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrated = await runMigrations(pool)
  expect([migrated.total, migrated.applied]).toEqual([28, 28])
  for (const [org, scope] of [
    [organization, tenant],
    [foreignOrganization, foreignTenant],
  ])
    await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [org, scope])
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      userId(role),
      userId(role) + '@example.invalid',
      'unused-synthetic-password-hash',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [organization, tenant, userId(role), role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: userId(role) })).token}`
  }
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    project,
    tenant,
    organization,
  ])
  for (const role of ['developer', 'viewer'] as const)
    await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
      tenant,
      project,
      userId(role),
    ])
  for (const name of [
    'developer-unbound',
    'viewer-unbound',
    'other-unbound',
    'project-bound',
    'foreign-organization',
    'foreign-tenant',
  ] as Connection[]) {
    const foreign = name.startsWith('foreign-')
    const scope = name === 'foreign-tenant' ? foreignTenant : tenant
    const observationOrg = foreign ? foreignOrganization : organization
    const owner =
      name === 'developer-unbound' || name === 'foreign-organization'
        ? 'developer'
        : name === 'viewer-unbound'
          ? 'viewer'
          : 'owner'
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities,account_observation)
       VALUES($1,$2,$3,$4,$5,'subscription_interactive','active',$6::jsonb,$7::jsonb)`,
      [
        connectionId(name),
        scope,
        userId(owner),
        name === 'project-bound' ? project : null,
        name === 'other-unbound' ? hiddenProvider : foreign ? foreignProvider : 'fixture-visible-provider71',
        JSON.stringify({
          connection_type: 'subscription',
          execution_mode: 'interactive',
          routing: false,
          subscription_product: 'openai_codex',
        }),
        JSON.stringify({ organizationId: observationOrg, status: 'connected', source: 'synthetic-fixture' }),
      ],
    )
    await pool.query(
      `INSERT INTO quota_snapshots(tenant_id,connection_id,observation_id,window_type,used,remaining,source,source_kind,confidence,scope,attribution_mode,availability,observed_at,stale_at,reset_at,provenance_version,metadata)
       VALUES($1,$2,$3,'daily',$4,$5,'synthetic_provider_fixture','official','reported','account','shared','available',now()-interval '1 second',now()+interval '1 hour',$6,1,$7::jsonb)`,
      [
        scope,
        connectionId(name),
        connectionId(name) + '-quota',
        name === 'other-unbound' ? '73' : '25',
        name === 'other-unbound' ? '27' : '75',
        name === 'other-unbound' ? hiddenReset : foreign ? foreignReset : visibleReset,
        JSON.stringify({ unit: 'percent' }),
      ],
    )
  }
  await pool.query(
    `INSERT INTO nexus_tasks(tenant_id,organization_id,project_id,original_goal,cwd,context)
     VALUES($1,$2,$3,'Frozen task goal','/fixture/task-resource-71',$4::jsonb)`,
    [tenant, organization, project, JSON.stringify({ lastUserInstruction: 'Frozen task instruction' })],
  )
  await pool.query(
    `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,occurred_at,connection_id,project_id,project_name,matched_root,attributed_at,parser_version)
     VALUES($1,$2,'codex_local','client_observed','fixture-resource71-session','fixture-resource71-event',now(),$3,$4,'Frozen project','/fixture/task-resource-71',now(),'codex-rollout-v1')`,
    [tenant, organization, connectionId('project-bound'), project],
  )
}, 30000)

beforeEach(async () => {
  await seedPolicy(['developer-unbound'])
})
afterAll(async () => {
  if (process.env.NEXUS_TASK_RESOURCE_VISIBILITY_REPORT === '1')
    console.info('Task-resource safe observations:', JSON.stringify(observations))
  try {
    if (fixtureOwner && fixtureLocked)
      await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        'nexus-task-resource-fixture:' + target.pathname,
      ])
  } finally {
    fixtureOwner?.release()
    await bounded(pool.end(), 'Task-resource fixture pool did not close', 12000)
  }
}, 16000)

function request(role: Role, path: string, value?: unknown) {
  return new Request('http://localhost' + path, {
    method: value === undefined ? 'GET' : 'PUT',
    headers: {
      cookie: `${cookies[role]}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      'content-type': 'application/json',
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
}
async function bounded<T>(pending: Promise<T>, message: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'project_memberships',
  'projects',
  'owned_connections',
  'quota_snapshots',
  'external_observed_usage',
  'resource_routing_policies',
  'nexus_tasks',
  'task_sessions',
  'task_handoff_snapshots',
  'task_resource_transitions',
  'providers',
  'channels',
  'provider_credentials',
  'downstream_api_keys',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
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
async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables) {
    const order =
      table === 'resource_routing_policies'
        ? 'tenant_id,organization_id,project_id'
        : table === 'connector_pairings'
          ? 'connection_id'
          : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}
const unchangedExcept = (before: Facts, after: Facts, excluded: (typeof tables)[number][] = []) =>
  tables.filter((table) => !excluded.includes(table)).every((table) => isDeepStrictEqual(before[table], after[table]))
const policyAudits = (value: Facts) =>
  value.audit_events.filter((row) => row.action === 'task.policy.updated' && row.target_id === project).length
async function visibility(role: Role, name: Connection) {
  const listed = await bounded(
    listConnections(request(role, '/api/connections')),
    'Connection visibility oracle did not settle',
  )
  expect(listed.status).toBe(200)
  const list = await listed.json()
  const quota = await bounded(
    readQuota(request(role, '/api/connections/' + connectionId(name) + '/quota'), {
      params: Promise.resolve({ id: connectionId(name) }),
    }),
    'Quota visibility oracle did not settle',
  )
  return {
    listed: list.connections.some((row: { id: string }) => row.id === connectionId(name)),
    quotaStatus: quota.status,
  }
}
async function runtime(role: Role) {
  const response = await bounded(
    readTasks(request(role, '/api/task-runtime?projectId=' + encodeURIComponent(project))),
    'Task resource read did not settle',
  )
  expect(response.status).toBe(200)
  return { response, body: await response.json() }
}

it('refuses a project developer policy containing another owner unbound connection', async () => {
  const oracle = await visibility('developer', 'other-unbound')
  expect([oracle.listed, oracle.quotaStatus]).toEqual([false, 404])
  const before = await facts()
  const response = await bounded(
    savePolicy(
      request('developer', '/api/task-runtime/policy', { projectId: project, policy: policy(['other-unbound']) }),
    ),
    'Hidden policy write did not settle',
  )
  const after = await facts()
  const observation = {
    kind: 'developer-hidden-policy-write',
    status: response.status,
    hiddenByConnectionList: !oracle.listed,
    quotaDenied: oracle.quotaStatus === 404,
    policyUnchanged: isDeepStrictEqual(before.resource_routing_policies, after.resource_routing_policies),
    completeFactsUnchanged: unchangedExcept(before, after),
    otherFactsUnchanged: unchangedExcept(before, after, ['resource_routing_policies', 'audit_events']),
    successAuditDelta: policyAudits(after) - policyAudits(before),
  }
  observations.push(observation)
  expect([400, 404].includes(observation.status)).toBe(true)
  expect(observation.policyUnchanged).toBe(true)
  expect(observation.completeFactsUnchanged).toBe(true)
  expect(observation.successAuditDelta).toBe(0)
})

it.each(['developer', 'viewer'] as const)(
  'legacy policy does not expose another owner live resource facts to %s',
  async (role) => {
    const own: Connection = role === 'developer' ? 'developer-unbound' : 'viewer-unbound'
    const oracle = await visibility(role, 'other-unbound')
    expect([oracle.listed, oracle.quotaStatus]).toEqual([false, 404])
    const names: Connection[] = ['other-unbound', own]
    await seedPolicy(names)
    const before = await facts()
    const { response, body } = await runtime(role)
    const after = await facts()
    const returned = body.resources.map((row: { connectionId: string }) => row.connectionId)
    const hiddenResource = body.resources.find(
      (row: { connectionId: string }) => row.connectionId === connectionId('other-unbound'),
    )
    const serialized = JSON.stringify(body)
    const observation = {
      kind: 'legacy-policy-' + role,
      status: response.status,
      hiddenByConnectionList: !oracle.listed,
      quotaDenied: oracle.quotaStatus === 404,
      hiddenResourceReturned: returned.includes(connectionId('other-unbound')),
      hiddenQuotaReturned: hiddenResource?.usedPercent === 73,
      hiddenProviderReturned: serialized.includes(hiddenProvider),
      hiddenResetReturned: serialized.includes(hiddenReset),
      ownResourceReturned: returned.includes(connectionId(own)),
      // Retain project policy configuration; its references do not grant live resource visibility.
      legacyPolicyUnchanged: isDeepStrictEqual(body.policy, policy(names)),
      completeFactsUnchanged: unchangedExcept(before, after),
      successAuditDelta: policyAudits(after) - policyAudits(before),
    }
    observations.push(observation)
    expect(observation.ownResourceReturned).toBe(true)
    expect(observation.legacyPolicyUnchanged).toBe(true)
    expect(observation.completeFactsUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(0)
    expect([
      observation.hiddenResourceReturned,
      observation.hiddenQuotaReturned,
      observation.hiddenProviderReturned,
      observation.hiddenResetReturned,
    ]).toEqual([false, false, false, false])
    expect(isDeepStrictEqual(returned, [connectionId(own)])).toBe(true)
  },
)

it.each([
  { role: 'developer' as const, connection: 'developer-unbound' as const },
  { role: 'developer' as const, connection: 'project-bound' as const },
  { role: 'admin' as const, connection: 'other-unbound' as const },
])('control: $role can author and read visible $connection resources', async ({ role, connection }) => {
  const oracle = await visibility(role, connection)
  expect([oracle.listed, oracle.quotaStatus]).toEqual([true, 200])
  const before = await facts()
  const response = await bounded(
    savePolicy(request(role, '/api/task-runtime/policy', { projectId: project, policy: policy([connection]) })),
    'Visible policy write did not settle',
  )
  const { body } = await runtime(role)
  const after = await facts()
  const resource = body.resources.find((row: { connectionId: string }) => row.connectionId === connectionId(connection))
  const observation = {
    kind: 'visible-' + role + '-' + connection,
    status: response.status,
    policyMatches: isDeepStrictEqual(body.policy, policy([connection])),
    onlyRequestedResource: body.resources.length === 1 && Boolean(resource),
    resourceAvailable: resource?.availability === 'available' && resource?.quotaState === 'available',
    quotaMatches: resource?.usedPercent === (connection === 'other-unbound' ? 73 : 25),
    resetMatches: resource?.resetAt === (connection === 'other-unbound' ? hiddenReset : visibleReset),
    otherFactsUnchanged: unchangedExcept(before, after, ['resource_routing_policies', 'audit_events']),
    successAuditDelta: policyAudits(after) - policyAudits(before),
  }
  observations.push(observation)
  expect([
    observation.status,
    observation.policyMatches,
    observation.onlyRequestedResource,
    observation.resourceAvailable,
    observation.quotaMatches,
    observation.resetMatches,
    observation.otherFactsUnchanged,
    observation.successAuditDelta,
  ]).toEqual([200, true, true, true, true, true, true, 1])
})

it.each(['foreign-organization', 'foreign-tenant'] as const)(
  'control: foreign scope %s cannot be authored or expose live facts',
  async (connection) => {
    const before = await facts()
    const response = await bounded(
      savePolicy(
        request('developer', '/api/task-runtime/policy', { projectId: project, policy: policy([connection]) }),
      ),
      'Foreign policy write did not settle',
    )
    const denied = await facts()
    await seedPolicy([connection, 'developer-unbound'])
    const seeded = await facts()
    const { body } = await runtime('developer')
    const after = await facts()
    const returned = body.resources.map((row: { connectionId: string }) => row.connectionId)
    const serialized = JSON.stringify(body)
    const observation = {
      kind: connection,
      status: response.status,
      deniedWriteUnchanged: unchangedExcept(before, denied),
      successAuditDelta: policyAudits(after) - policyAudits(before),
      onlyOwnResourceReturned: isDeepStrictEqual(returned, [connectionId('developer-unbound')]),
      foreignProviderReturned: serialized.includes(foreignProvider),
      foreignResetReturned: serialized.includes(foreignReset),
      readFactsUnchanged: unchangedExcept(seeded, after),
    }
    observations.push(observation)
    expect([400, 404].includes(observation.status)).toBe(true)
    expect([
      observation.deniedWriteUnchanged,
      observation.successAuditDelta,
      observation.onlyOwnResourceReturned,
      observation.foreignProviderReturned,
      observation.foreignResetReturned,
      observation.readFactsUnchanged,
    ]).toEqual([true, 0, true, false, false, true])
  },
)
