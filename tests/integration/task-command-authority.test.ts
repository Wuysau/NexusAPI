import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { POST as resume } from '@/app/api/task-runtime/[id]/resume/route'
import { POST as switchTask } from '@/app/api/task-runtime/[id]/switch/route'

const launch = vi.hoisted(() => ({
  called: vi.fn(() => {
    throw new Error('Native HTTP task-command fixtures must never launch a process')
  }),
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const guarded = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map((name) => [name, launch.called]),
  )
  return { ...actual, ...guarded, default: { ...actual, ...guarded } }
})

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent task-command DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid task-command fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_task_commands_round69', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback task-command fixture required')

const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const observations: Record<string, string | number | boolean | null>[] = []
let fixtureOwner: PoolClient | undefined
let fixtureLocked = false
let sequence = 0

beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Task-command fixture database mismatch')
  fixtureLocked = (
    await fixtureOwner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
      'nexus-task-command-fixture:' + target.pathname,
    ])
  ).rows[0]?.locked
  if (!fixtureLocked) throw new Error('Task-command fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Task-command fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  expect([migrations.total, migrations.applied]).toEqual([28, 28])
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_TASK_COMMAND_AUTHORITY_REPORT === '1')
    console.info('Task-command safe observations:', JSON.stringify(observations))
  try {
    if (fixtureOwner && fixtureLocked)
      await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        'nexus-task-command-fixture:' + target.pathname,
      ])
  } finally {
    fixtureOwner?.release()
    await pool.end()
  }
})

type Action = 'resume' | 'switch'
type ActorRole = 'admin' | 'developer' | 'viewer'
type Change = 'viewer' | 'membership-removed' | 'project-archived' | 'project-membership-removed'
const actions = ['resume', 'switch'] as const
const routes = { resume, switch: switchTask }
interface Fixture {
  action: Action
  tenant: string
  organization: string
  actor: string
  project: string
  task: string
  source: string
  destination: string
  cookie: string
  csrf: string
}
async function fixture(action: Action, role: ActorRole = 'admin'): Promise<Fixture> {
  const prefix = 'task-authority-69-' + ++sequence
  const f: Fixture = {
    action,
    tenant: prefix + '-tenant',
    organization: prefix + '-org',
    actor: prefix + '-actor',
    project: prefix + '-project',
    task: prefix + '-task',
    source: prefix + '-source',
    destination: prefix + '-destination',
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.organization, f.tenant])
  await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$1,$3)', [
    f.actor,
    f.actor + '@example.invalid',
    'synthetic-unused-password-hash',
  ])
  await pool.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
    f.organization,
    f.tenant,
    f.actor,
    role,
  ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    f.project,
    f.tenant,
    f.organization,
  ])
  await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
    f.tenant,
    f.project,
    f.actor,
  ])
  for (const connection of [f.source, f.destination])
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities)
       VALUES($1,$2,$3,$4,'synthetic-task-provider','subscription_interactive','active',$5::jsonb)`,
      [
        connection,
        f.tenant,
        f.actor,
        f.project,
        JSON.stringify({ connection_type: 'subscription', execution_mode: 'interactive', routing: false }),
      ],
    )
  const policy = {
    name: 'Synthetic task-command policy',
    workload: 'coding-agent-high',
    requiredCapabilities: ['coding', 'tool_calling'],
    tool: 'codex',
    model: null,
    autoFailover: true,
    autoReturn: false,
    candidates: [f.source, f.destination].map((connectionId, index) => ({
      connectionId,
      profileRef: 'synthetic-profile-' + index,
      priority: index + 1,
      enabled: true,
      switchThreshold: 90,
      capabilities: ['coding', 'tool_calling'],
      allowedModels: [],
      allowedTools: ['codex'],
      costMode: 'subscription',
    })),
  }
  await pool.query(
    'INSERT INTO resource_routing_policies(tenant_id,organization_id,project_id,policy) VALUES($1,$2,$3,$4::jsonb)',
    [f.tenant, f.organization, f.project, JSON.stringify(policy)],
  )
  await pool.query(
    `INSERT INTO nexus_tasks(id,tenant_id,organization_id,project_id,original_goal,cwd,status,active_resource,active_tool,context,command_seq)
     VALUES($1,$2,$3,$4,'Synthetic retained goal','/fixture/task-authority-69',$5,$6,'codex',$7::jsonb,7)`,
    [
      f.task,
      f.tenant,
      f.organization,
      f.project,
      action === 'resume' ? 'paused' : 'running',
      f.source,
      JSON.stringify({
        completedWork: ['Synthetic completed work'],
        pendingWork: ['Synthetic pending work'],
        decisions: ['Retain the fixture context'],
        knownFailures: [],
        lastUserInstruction: 'Synthetic local task-command characterization',
        lastSuccessfulOperation: 'Synthetic previous operation',
      }),
    ],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
const params = (f: Fixture) => ({ params: Promise.resolve({ id: f.task }) })
const body = (f: Fixture) => (f.action === 'resume' ? {} : { targetConnectionId: f.destination })
function request(f: Fixture, value: BodyInit = JSON.stringify(body(f)), validCsrf = true): Request {
  return new Request('http://localhost/api/task-runtime/' + f.task + '/' + f.action, {
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

const tables = [
  'nexus_tasks',
  'task_sessions',
  'task_handoff_snapshots',
  'task_resource_transitions',
  'resource_routing_policies',
  'projects',
  'project_memberships',
  'owned_connections',
  'downstream_api_keys',
  'provider_credentials',
  'request_records',
  'attempts',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
  'sessions',
] as const
async function facts() {
  const result = {} as Record<(typeof tables)[number], Record<string, unknown>[]>
  for (const table of tables)
    result[table] = (
      await pool.query(
        `SELECT * FROM ${table} ORDER BY ${table === 'resource_routing_policies' ? 'tenant_id,organization_id,project_id' : 'id'}`,
      )
    ).rows
  return result
}
async function successAudits(f: Fixture) {
  return Number(
    (
      await pool.query(
        "SELECT count(*)::text count FROM audit_events WHERE target_id=$1 AND action IN ('task.resume.requested','task.switch.requested')",
        [f.task],
      )
    ).rows[0].count,
  )
}
const pendingBodies: { pending: Promise<Response>; abort: () => void }[] = []
afterEach(async () => {
  const pending = pendingBodies.splice(0)
  for (const item of pending) item.abort()
  const settled = await Promise.allSettled(pending.map((item) => item.pending))
  expect(settled.every((item) => item.status === 'fulfilled')).toBe(true)
  expect(launch.called).not.toHaveBeenCalled()
})
function delayedRequest(f: Fixture) {
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
  const req = request(f, stream)
  let finished = false
  let settled = false
  const pending = routes[f.action](req, params(f)).finally(() => {
    settled = true
  })
  pendingBodies.push({
    pending,
    abort() {
      if (!finished) {
        finished = true
        controller.error(new Error('Fixture request body closed during cleanup'))
      }
    },
  })
  return {
    pending,
    async waitForBody() {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Actual task route did not consume delayed request body')),
              5000,
            )
          }),
        ])
        expect([req.bodyUsed, settled]).toEqual([true, false])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    },
    finish() {
      if (finished) throw new Error('Task fixture body already finished')
      finished = true
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body(f))))
      controller.close()
    },
  }
}
async function changeAuthority(f: Fixture, change: Change) {
  if (change === 'viewer') {
    const changed = await pool.query(
      "UPDATE organization_memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2 RETURNING role",
      [f.organization, f.actor],
    )
    expect(changed.rows[0]?.role).toBe('viewer')
  } else if (change === 'membership-removed') {
    const changed = await pool.query(
      'DELETE FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 RETURNING id',
      [f.organization, f.actor],
    )
    expect(changed.rows.length).toBe(1)
  } else if (change === 'project-archived') {
    const changed = await pool.query(
      "UPDATE projects SET status='archived',archived_at=now() WHERE id=$1 RETURNING status,archived_at",
      [f.project],
    )
    expect([changed.rows[0]?.status, changed.rows[0]?.archived_at !== null]).toEqual(['archived', true])
  } else {
    const changed = await pool.query(
      'DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 RETURNING id',
      [f.tenant, f.project, f.actor],
    )
    expect(changed.rows.length).toBe(1)
  }
}
async function observe(
  f: Fixture,
  kind: string,
  response: Response,
  before: Awaited<ReturnType<typeof facts>>,
  auditBefore: number,
) {
  const after = await facts()
  const beforeTask = before.nexus_tasks.find((row) => row.id === f.task)!
  const afterTask = after.nexus_tasks.find((row) => row.id === f.task)!
  const observation = {
    kind,
    action: f.action,
    status: response.status,
    taskUnchanged: isDeepStrictEqual(beforeTask, afterTask),
    requestedActionUnchanged: beforeTask.requested_action === afterTask.requested_action,
    commandSeqUnchanged: beforeTask.command_seq === afterTask.command_seq,
    domainUnchanged: isDeepStrictEqual(before, after),
    successAuditDelta: (await successAudits(f)) - auditBefore,
  }
  observations.push(observation)
  return { after, beforeTask, afterTask, observation }
}
const raceCases = actions.flatMap((action) =>
  (['viewer', 'membership-removed', 'project-archived', 'project-membership-removed'] as const).map((change) => ({
    action,
    change,
  })),
)
it.each(raceCases)('rejects $action after body-wait authority change $change', async ({ action, change }) => {
  const f = await fixture(action, change === 'project-membership-removed' ? 'developer' : 'admin')
  const delayed = delayedRequest(f)
  await delayed.waitForBody()
  await changeAuthority(f, change)
  const before = await facts()
  const auditBefore = await successAudits(f)
  delayed.finish()
  const response = await delayed.pending
  const { observation } = await observe(f, 'delayed-' + change, response, before, auditBefore)
  expect([
    observation.status,
    observation.taskUnchanged,
    observation.requestedActionUnchanged,
    observation.commandSeqUnchanged,
    observation.domainUnchanged,
    observation.successAuditDelta,
  ]).toEqual([404, true, true, true, true, 0])
})

const activeCases = actions.flatMap((action) => (['admin', 'developer'] as const).map((role) => ({ action, role })))
it.each(activeCases)('control: unchanged $role can queue $action after body-wait', async ({ action, role }) => {
  const f = await fixture(action, role)
  const delayed = delayedRequest(f)
  await delayed.waitForBody()
  const before = await facts()
  const auditBefore = await successAudits(f)
  delayed.finish()
  const response = await delayed.pending
  const { after, beforeTask, afterTask, observation } = await observe(
    f,
    'active-' + role,
    response,
    before,
    auditBefore,
  )
  expect([response.status, await response.json()]).toEqual([202, { queued: true }])
  expect([
    afterTask.requested_action,
    afterTask.requested_connection_id,
    afterTask.command_seq,
    observation.successAuditDelta,
  ]).toEqual([action, action === 'switch' ? f.destination : null, 8, 1])
  const {
    requested_action: _beforeAction,
    requested_connection_id: _beforeTarget,
    command_seq: _beforeSeq,
    updated_at: _beforeTime,
    ...beforeRetained
  } = beforeTask
  const {
    requested_action: _afterAction,
    requested_connection_id: _afterTarget,
    command_seq: _afterSeq,
    updated_at: _afterTime,
    ...afterRetained
  } = afterTask
  expect(isDeepStrictEqual(beforeRetained, afterRetained)).toBe(true)
  for (const table of tables.filter((name) => name !== 'nexus_tasks'))
    expect(isDeepStrictEqual(before[table], after[table]), table + ' unchanged').toBe(true)
  expect(
    isDeepStrictEqual(
      before.nexus_tasks.filter((row) => row.id !== f.task),
      after.nexus_tasks.filter((row) => row.id !== f.task),
    ),
  ).toBe(true)
})

it.each(actions)('control: repeated %s keeps CAS409 and complete facts unchanged', async (action) => {
  const f = await fixture(action)
  expect((await routes[action](request(f), params(f))).status).toBe(202)
  const before = await facts()
  const auditBefore = await successAudits(f)
  const response = await routes[action](request(f), params(f))
  const { observation } = await observe(f, 'cas-control', response, before, auditBefore)
  expect([
    response.status,
    (await response.json()).error.code,
    observation.taskUnchanged,
    observation.domainUnchanged,
    observation.successAuditDelta,
  ]).toEqual([409, 'task_action_conflict', true, true, 0])
})

it.each(actions)('control: mismatched real CSRF refuses %s before reading the body', async (action) => {
  const f = await fixture(action)
  const before = await facts()
  const auditBefore = await successAudits(f)
  const req = request(f, JSON.stringify(body(f)), false)
  const response = await routes[action](req, params(f))
  const { observation } = await observe(f, 'csrf-control', response, before, auditBefore)
  expect([
    response.status,
    (await response.json()).error.code,
    req.bodyUsed,
    observation.taskUnchanged,
    observation.domainUnchanged,
    observation.successAuditDelta,
  ]).toEqual([403, 'csrf_failed', false, true, true, 0])
})

it.each(actions)('control: fresh viewer refuses %s before reading the body', async (action) => {
  const f = await fixture(action, 'viewer')
  const before = await facts()
  const auditBefore = await successAudits(f)
  const req = request(f)
  const response = await routes[action](req, params(f))
  const { observation } = await observe(f, 'fresh-viewer-control', response, before, auditBefore)
  expect([
    response.status,
    req.bodyUsed,
    observation.taskUnchanged,
    observation.domainUnchanged,
    observation.successAuditDelta,
  ]).toEqual([403, false, true, true, 0])
})
