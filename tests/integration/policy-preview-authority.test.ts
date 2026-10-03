import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { POST as preview } from '@/app/api/projects/[id]/policy-preview/route'
import { GET as listConnections } from '@/app/api/connections/route'
import { GET as getProject } from '@/app/api/projects/[id]/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent preview-authority DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid preview-authority fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_policy_preview_round72', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback preview-authority fixture required')

const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
let fixtureOwner: PoolClient | undefined
let fixtureLocked = false
let sequence = 0
const observations: Record<string, string | number | boolean | null>[] = []
beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Preview-authority fixture database mismatch')
  fixtureLocked = (
    await fixtureOwner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
      'nexus-policy-preview-authority-fixture:' + target.pathname,
    ])
  ).rows[0]?.locked
  if (!fixtureLocked) throw new Error('Preview-authority fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Preview-authority fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
}, 30000)
afterAll(async () => {
  if (process.env.NEXUS_POLICY_PREVIEW_AUTHORITY_REPORT === '1')
    console.info('Preview-authority safe observations:', JSON.stringify(observations))
  try {
    if (fixtureOwner && fixtureLocked)
      await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        'nexus-policy-preview-authority-fixture:' + target.pathname,
      ])
  } finally {
    fixtureOwner?.release()
    await pool.end()
  }
})

type Role = 'admin' | 'viewer' | 'developer' | 'billing'
type Shape = 'hidden-unbound' | 'hidden-bound' | 'own-unbound' | 'visible-bound' | 'foreign'
interface Fixture {
  tenant: string
  organization: string
  actor: string
  owner: string
  project: string
  privateProject: string
  foreignProject: string
  connections: Record<Shape, string>
  cookie: string
  csrf: string
}
async function fixture(role: Role = 'admin'): Promise<Fixture> {
  const prefix = 'preview-authority-72-' + ++sequence
  const f: Fixture = {
    tenant: prefix + '-tenant',
    organization: prefix + '-org',
    actor: prefix + '-actor',
    owner: prefix + '-other',
    project: prefix + '-project',
    privateProject: prefix + '-private-project',
    foreignProject: prefix + '-foreign-project',
    connections: Object.fromEntries(
      ['hidden-unbound', 'hidden-bound', 'own-unbound', 'visible-bound', 'foreign'].map((shape) => [
        shape,
        prefix + '-' + shape,
      ]),
    ) as Record<Shape, string>,
    cookie: '',
    csrf: issueCsrfToken(),
  }
  for (const [organization, tenant] of [
    [f.organization, f.tenant],
    [prefix + '-foreign-org', prefix + '-foreign-tenant'],
  ])
    await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [organization, tenant])
  for (const user of [f.actor, f.owner])
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      user,
      user + '@example.invalid',
      'synthetic-unused-password-hash',
    ])
  await pool.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
    f.organization,
    f.tenant,
    f.actor,
    role,
  ])
  for (const project of [f.project, f.privateProject])
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
      project,
      f.tenant,
      f.organization,
    ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    f.foreignProject,
    prefix + '-foreign-tenant',
    prefix + '-foreign-org',
  ])
  await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
    f.tenant,
    f.project,
    f.actor,
  ])
  for (const shape of ['hidden-unbound', 'hidden-bound', 'own-unbound', 'visible-bound', 'foreign'] as const)
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities)
       VALUES($1,$2,$3,$4,'synthetic-preview-provider','external_endpoint','active',$5::jsonb)`,
      [
        f.connections[shape],
        shape === 'foreign' ? prefix + '-foreign-tenant' : f.tenant,
        shape === 'own-unbound' ? f.actor : shape === 'foreign' ? null : f.owner,
        shape === 'hidden-bound'
          ? f.privateProject
          : shape === 'visible-bound'
            ? f.project
            : shape === 'foreign'
              ? f.foreignProject
              : null,
        JSON.stringify({ operations: ['chat'] }),
      ],
    )
  // Nonempty synthetic history must remain byte-for-byte equivalent in memory.
  await pool.query(
    `INSERT INTO request_records(id,organization_id,tenant_id,request_model,channel_kind,status,project_id,project_name,connection_id)
     VALUES($1,$2,$3,'synthetic-history-model','platform','completed',$4,'Synthetic retained project',$5)`,
    [prefix + '-request-history', f.organization, f.tenant, f.privateProject, f.connections['hidden-unbound']],
  )
  await pool.query(
    `INSERT INTO external_observed_usage(id,tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,
       occurred_at,parser_version,project_id,project_name,matched_root,attributed_at,input_tokens,output_tokens,total_tokens)
     VALUES($1,$2,$3,'codex_local','client_observed',$4,$5,now(),'synthetic-parser',$6,'Synthetic retained project','/fixture/preview-history',now(),1,2,3)`,
    [
      prefix + '-observed-history',
      f.tenant,
      f.organization,
      prefix + '-synthetic-session',
      prefix + '-synthetic-event',
      f.privateProject,
    ],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
const body = (f: Fixture, shape: Shape) => ({
  connectionId: f.connections[shape],
  operation: 'chat',
  model: 'synthetic-preview-model',
})
const params = (id: string) => ({ params: Promise.resolve({ id }) })
function request(f: Fixture, shape: Shape, value: BodyInit = JSON.stringify(body(f, shape)), validCsrf = true) {
  return new Request('http://localhost/api/projects/' + f.project + '/policy-preview', {
    method: 'POST',
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      [CSRF_HEADER]: validCsrf ? f.csrf : 'mismatched-synthetic-csrf',
      'content-type': 'application/json',
    },
    body: value,
    ...(value instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
}
function readRequest(f: Fixture, path: string) {
  return new Request('http://localhost' + path, { headers: { cookie: f.cookie } })
}
const tables = [
  'organizations',
  'organization_memberships',
  'users',
  'sessions',
  'projects',
  'project_memberships',
  'owned_connections',
  'project_workspace_roots',
  'provider_credentials',
  'downstream_api_keys',
  'request_records',
  'attempts',
  'external_observed_usage',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
  'quota_snapshots',
  'nexus_tasks',
  'task_sessions',
  'task_handoff_snapshots',
  'task_resource_transitions',
  'resource_routing_policies',
] as const
async function facts() {
  const result = {} as Record<(typeof tables)[number], Record<string, unknown>[]>
  for (const table of tables) {
    const order =
      table === 'project_workspace_roots'
        ? 'tenant_id,organization_id,root'
        : table === 'resource_routing_policies'
          ? 'tenant_id,organization_id,project_id'
          : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}
async function audits(f: Fixture) {
  return (
    await pool.query("SELECT * FROM audit_events WHERE tenant_id=$1 AND action='policy.previewed' ORDER BY id", [
      f.tenant,
    ])
  ).rows
}
const pendingBodies: { pending: Promise<Response>; abort: () => void }[] = []
afterEach(async () => {
  const pending = pendingBodies.splice(0)
  for (const item of pending) item.abort()
  expect(
    (await Promise.allSettled(pending.map((item) => item.pending))).every((item) => item.status === 'fulfilled'),
  ).toBe(true)
})
function delayedRequest(f: Fixture, shape: Shape) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let consumed!: () => void
  const entered = new Promise<void>((resolve) => {
    consumed = resolve
  })
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        consumed()
      },
    },
    { highWaterMark: 0 },
  )
  const req = request(f, shape, stream)
  let finished = false
  let settled = false
  const pending = preview(req, params(f.project)).finally(() => {
    settled = true
  })
  pendingBodies.push({
    pending,
    abort() {
      if (!finished) {
        finished = true
        controller.error(new Error('Preview fixture body closed during cleanup'))
      }
    },
  })
  return {
    pending,
    async waitForBody() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Actual preview route did not consume delayed body')), 5000)
          }),
        ])
        expect([req.bodyUsed, settled]).toEqual([true, false])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    finish() {
      if (finished) throw new Error('Preview fixture body already finished')
      finished = true
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body(f, shape))))
      controller.close()
    },
  }
}
async function observe(
  f: Fixture,
  kind: string,
  response: Response,
  before: Awaited<ReturnType<typeof facts>>,
  auditBefore: Awaited<ReturnType<typeof audits>>,
) {
  const payload = await response.json()
  const after = await facts()
  const auditAfter = await audits(f)
  const observation = {
    kind,
    status: response.status,
    returnedConnection: payload.connection !== undefined,
    returnedDecision: payload.decision !== undefined,
    domainUnchanged: isDeepStrictEqual(after, before),
    historicalFactsUnchanged:
      isDeepStrictEqual(after.request_records, before.request_records) &&
      isDeepStrictEqual(after.external_observed_usage, before.external_observed_usage),
    successAuditsUnchanged: isDeepStrictEqual(auditAfter, auditBefore),
    successAuditDelta: auditAfter.length - auditBefore.length,
  }
  observations.push(observation)
  expect([observation.domainUnchanged, observation.historicalFactsUnchanged]).toEqual([true, true])
  return { payload, observation, auditBefore, auditAfter }
}
function denied(result: Awaited<ReturnType<typeof observe>>, status = 404) {
  expect([
    result.observation.status,
    result.observation.returnedConnection,
    result.observation.returnedDecision,
    result.observation.successAuditsUnchanged,
    result.observation.successAuditDelta,
  ]).toEqual([status, false, false, true, 0])
  for (const field of ['projectId', 'connection', 'decision', 'alternatives'])
    expect(field in result.payload).toBe(false)
}
function accepted(f: Fixture, shape: Shape, result: Awaited<ReturnType<typeof observe>>) {
  expect(result.observation.status).toBe(200)
  expect(result.payload).toEqual({
    projectId: f.project,
    connection: {
      id: f.connections[shape],
      provider: 'synthetic-preview-provider',
      mode: 'external_endpoint',
      status: 'active',
    },
    decision: { allowed: true },
    alternatives: [],
  })
  const appended = result.auditAfter.filter((row) => !result.auditBefore.some((old) => old.id === row.id))
  expect([result.observation.successAuditDelta, appended.length]).toEqual([1, 1])
  expect([appended[0].actor_user_id, appended[0].tenant_id, appended[0].target_type, appended[0].target_id]).toEqual([
    f.actor,
    f.tenant,
    'project',
    f.project,
  ])
  expect(appended[0].metadata).toEqual({ ...body(f, shape), decision: { allowed: true } })
}

it.each(
  (['viewer', 'developer'] as const).flatMap((role) =>
    (['hidden-unbound', 'hidden-bound'] as const).map((shape) => ({ role, shape })),
  ),
)('rejects cached admin visibility after body-wait demotion to $role for $shape', async ({ role, shape }) => {
  const f = await fixture()
  const delayed = delayedRequest(f, shape)
  await delayed.waitForBody()
  const changed = await pool.query(
    'UPDATE organization_memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3 RETURNING role',
    [role, f.organization, f.actor],
  )
  expect(changed.rows[0]?.role).toBe(role)
  expect((await getProject(readRequest(f, '/api/projects/' + f.project), params(f.project))).status).toBe(200)
  const visible = await listConnections(readRequest(f, '/api/connections'))
  expect(visible.status).toBe(200)
  expect((await visible.json()).connections.some((row: { id: string }) => row.id === f.connections[shape])).toBe(false)
  const before = await facts()
  const auditBefore = await audits(f)
  delayed.finish()
  const result = await observe(f, 'delayed-' + role + '-' + shape, await delayed.pending, before, auditBefore)
  denied(result)
  expect(result.payload.error.code).toBe('not_found')
})
it.each(['hidden-unbound', 'hidden-bound'] as const)('control: fresh viewer rejects %s', async (shape) => {
  const f = await fixture('viewer')
  const before = await facts()
  const auditBefore = await audits(f)
  denied(
    await observe(f, 'fresh-viewer-' + shape, await preview(request(f, shape), params(f.project)), before, auditBefore),
  )
})
it.each(['hidden-unbound', 'hidden-bound'] as const)('control: current admin retains %s preview', async (shape) => {
  const f = await fixture()
  const before = await facts()
  const auditBefore = await audits(f)
  accepted(
    f,
    shape,
    await observe(f, 'admin-' + shape, await preview(request(f, shape), params(f.project)), before, auditBefore),
  )
})
it.each(['own-unbound', 'visible-bound'] as const)('control: demoted developer retains %s preview', async (shape) => {
  const f = await fixture()
  const delayed = delayedRequest(f, shape)
  await delayed.waitForBody()
  expect(
    (
      await pool.query(
        "UPDATE organization_memberships SET role='developer' WHERE organization_id=$1 AND user_id=$2 RETURNING role",
        [f.organization, f.actor],
      )
    ).rows[0]?.role,
  ).toBe('developer')
  const before = await facts()
  const auditBefore = await audits(f)
  delayed.finish()
  accepted(f, shape, await observe(f, 'delayed-developer-' + shape, await delayed.pending, before, auditBefore))
})
it('control: admin changed to billing keeps privileged read after body-wait', async () => {
  const f = await fixture()
  const delayed = delayedRequest(f, 'hidden-unbound')
  await delayed.waitForBody()
  expect(
    (
      await pool.query(
        "UPDATE organization_memberships SET role='billing' WHERE organization_id=$1 AND user_id=$2 RETURNING role",
        [f.organization, f.actor],
      )
    ).rows[0]?.role,
  ).toBe('billing')
  const before = await facts()
  const auditBefore = await audits(f)
  delayed.finish()
  accepted(f, 'hidden-unbound', await observe(f, 'delayed-billing', await delayed.pending, before, auditBefore))
})
it.each(['project', 'connection'] as const)('control: foreign %s remains hidden', async (scope) => {
  const f = await fixture()
  const before = await facts()
  const auditBefore = await audits(f)
  denied(
    await observe(
      f,
      'foreign-' + scope,
      await preview(
        request(f, scope === 'connection' ? 'foreign' : 'visible-bound'),
        params(scope === 'project' ? f.foreignProject : f.project),
      ),
      before,
      auditBefore,
    ),
  )
})
it('control: real CSRF mismatch rejects before reading body without success audit', async () => {
  const f = await fixture()
  const before = await facts()
  const auditBefore = await audits(f)
  const req = request(f, 'hidden-unbound', JSON.stringify(body(f, 'hidden-unbound')), false)
  const result = await observe(f, 'csrf-control', await preview(req, params(f.project)), before, auditBefore)
  denied(result, 403)
  expect([req.bodyUsed, result.payload.error.code]).toEqual([false, 'csrf_failed'])
})
