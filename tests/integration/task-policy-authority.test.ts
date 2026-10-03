import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { hashPassword } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { PUT as savePolicy } from '@/app/api/task-runtime/policy/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit independent task-policy DATABASE_URL required')
let target: URL
try {
  target = new URL(supplied)
} catch {
  throw new Error('Invalid task-policy fixture URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_task_policy_round70', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact loopback task-policy fixture required')

// Every backend is bounded, including the actual route's transaction after a future fix.
pool.options.statement_timeout = 12000
pool.options.lock_timeout = 10000
pool.options.idle_in_transaction_session_timeout = 16000
pool.options.connectionTimeoutMillis = 4000
const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const passwordHash = hashPassword('Independent task policy fixture password 70')
const observations: Record<string, string | number | boolean>[] = []
let fixtureOwner: PoolClient | undefined
let sequence = 0

beforeAll(async () => {
  fixtureOwner = await pool.connect()
  if ((await fixtureOwner.query('SELECT current_database() AS name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Task-policy fixture database mismatch')
  const ownership = await fixtureOwner.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
    ['nexus-task-policy-fixture:' + target.pathname],
  )
  if (!ownership.rows[0]?.locked) throw new Error('Task-policy fixture already owned')
  const others = await fixtureOwner.query<{ count: string }>(
    `SELECT count(*)::text count FROM pg_stat_activity
     WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`,
  )
  if (others.rows[0]?.count !== '0') throw new Error('Task-policy fixture has another client owner')
  await fixtureOwner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_TASK_POLICY_REPORT === '1')
    console.info('Task-policy safe observations:', JSON.stringify(observations))
  if (fixtureOwner) {
    try {
      await fixtureOwner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        'nexus-task-policy-fixture:' + target.pathname,
      ])
    } finally {
      fixtureOwner.release()
    }
  }
  await pool.end()
}, 20000)

type Change = 'administrator downgrade' | 'developer project membership removed' | 'project archived'
interface Fixture {
  tenant: string
  organization: string
  actor: string
  project: string
  connection: string
  cookie: string
  csrf: string
}
function policy(f: Fixture, changed = false) {
  return {
    name: changed ? 'Changed fixture policy' : 'Original fixture policy',
    workload: 'coding-agent-high',
    requiredCapabilities: ['coding', 'tool_calling'],
    tool: 'codex',
    model: null,
    autoFailover: true,
    autoReturn: false,
    candidates: [
      {
        connectionId: f.connection,
        profileRef: 'fixture-profile',
        priority: 1,
        enabled: true,
        switchThreshold: 90,
        capabilities: ['coding', 'tool_calling'],
        allowedModels: [],
        allowedTools: ['codex'],
        costMode: 'subscription',
      },
    ],
  }
}
async function fixture(role: 'admin' | 'developer' = 'admin'): Promise<Fixture> {
  const prefix = 'task-policy-' + ++sequence
  const f = {
    tenant: prefix + '-tenant',
    organization: prefix + '-org',
    actor: prefix + '-actor',
    project: prefix + '-project',
    connection: prefix + '-connection',
    cookie: '',
    csrf: issueCsrfToken(),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [f.organization, f.tenant])
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    f.actor,
    f.actor + '@example.invalid',
    passwordHash,
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
  if (role === 'developer')
    await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
      f.tenant,
      f.project,
      f.actor,
    ])
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status,capabilities)
     VALUES($1,$2,$3,$4,'fixture-provider','subscription_interactive','active',$5::jsonb)`,
    [
      f.connection,
      f.tenant,
      f.actor,
      f.project,
      JSON.stringify({ connection_type: 'subscription', execution_mode: 'interactive', routing: false }),
    ],
  )
  await pool.query(
    'INSERT INTO resource_routing_policies(tenant_id,organization_id,project_id,policy) VALUES($1,$2,$3,$4::jsonb)',
    [f.tenant, f.organization, f.project, JSON.stringify(policy(f))],
  )
  await pool.query(
    `INSERT INTO nexus_tasks(tenant_id,organization_id,project_id,original_goal,cwd,context)
     VALUES($1,$2,$3,'Frozen fixture goal','/fixture/task-policy-70',$4::jsonb)`,
    [f.tenant, f.organization, f.project, JSON.stringify({ lastUserInstruction: 'Frozen instruction' })],
  )
  await pool.query(
    `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,occurred_at,connection_id,project_id,project_name,matched_root,attributed_at,parser_version)
     VALUES($1,$2,'codex_local','client_observed',$3,$3,now(),$4,$5,'Frozen project','/fixture/task-policy-70',now(),'codex-rollout-v1')`,
    [f.tenant, f.organization, f.connection + '-history', f.connection, f.project],
  )
  f.cookie = `${SESSION_COOKIE}=${(await createSession({ userId: f.actor })).token}`
  return f
}
function request(f: Fixture, body: BodyInit): Request {
  return new Request('http://localhost/api/task-runtime/policy', {
    method: 'PUT',
    headers: {
      cookie: `${f.cookie}; ${CSRF_COOKIE}=${f.csrf}`,
      [CSRF_HEADER]: f.csrf,
      'content-type': 'application/json',
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
}
const body = (f: Fixture) => JSON.stringify({ projectId: f.project, policy: policy(f, true) })
const immutableTables = [
  'nexus_tasks',
  'task_sessions',
  'task_handoff_snapshots',
  'task_resource_transitions',
  'external_observed_usage',
  'owned_connections',
  'provider_credentials',
  'downstream_api_keys',
  'request_records',
  'usage_events',
  'usage_records',
  'ledger_transactions',
  'ledger_postings',
  'sessions',
] as const
async function immutableFacts() {
  const facts: Record<string, unknown> = {}
  for (const table of immutableTables) facts[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows
  return facts
}
async function storedPolicy(f: Fixture) {
  return (
    await pool.query(
      'SELECT policy FROM resource_routing_policies WHERE tenant_id=$1 AND organization_id=$2 AND project_id=$3',
      [f.tenant, f.organization, f.project],
    )
  ).rows[0]?.policy
}
async function successAudits(f: Fixture) {
  return Number(
    (
      await pool.query(
        "SELECT count(*)::text count FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='task.policy.updated'",
        [f.tenant, f.project],
      )
    ).rows[0]?.count,
  )
}
async function changeAuthority(db: Pick<PoolClient, 'query'>, f: Fixture, change: Change) {
  if (change === 'administrator downgrade')
    await db.query(
      'UPDATE organization_memberships SET role=$1 WHERE tenant_id=$2 AND organization_id=$3 AND user_id=$4',
      ['viewer', f.tenant, f.organization, f.actor],
    )
  else if (change === 'developer project membership removed')
    await db.query('DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3', [
      f.tenant,
      f.project,
      f.actor,
    ])
  else
    await db.query(
      "UPDATE projects SET status='archived',archived_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND id=$3",
      [f.tenant, f.organization, f.project],
    )
}
async function authorityChanged(f: Fixture, change: Change) {
  if (change === 'administrator downgrade')
    return (
      (
        await pool.query(
          'SELECT role FROM organization_memberships WHERE tenant_id=$1 AND organization_id=$2 AND user_id=$3',
          [f.tenant, f.organization, f.actor],
        )
      ).rows[0]?.role === 'viewer'
    )
  if (change === 'developer project membership removed')
    return (
      (
        await pool.query('SELECT id FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3', [
          f.tenant,
          f.project,
          f.actor,
        ])
      ).rows.length === 0
    )
  return Boolean(
    (
      await pool.query('SELECT archived_at FROM projects WHERE tenant_id=$1 AND organization_id=$2 AND id=$3', [
        f.tenant,
        f.organization,
        f.project,
      ])
    ).rows[0]?.archived_at,
  )
}
async function bounded<T>(promise: Promise<T>, message: string, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const changes: Change[] = ['administrator downgrade', 'developer project membership removed', 'project archived']

it.each(changes)(
  'holds current project authority through policy commit: %s',
  async (change) => {
    const f = await fixture(change === 'developer project membership removed' ? 'developer' : 'admin')
    const before = await immutableFacts()
    const auditBefore = await successAudits(f)
    const gate = await pool.connect()
    let writer: PoolClient | undefined
    let pending: Promise<Response> | undefined
    let changing: Promise<void> | undefined
    let response: Response | undefined
    let changeFinishedBeforeCommit = false
    let changeWaitedForCommit = false
    let gateConfirmed = false
    let routeSettled = false
    try {
      writer = await pool.connect()
      await gate.query('BEGIN')
      const gatePID = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      const writerPID = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      await gate.query(
        'SELECT project_id FROM resource_routing_policies WHERE tenant_id=$1 AND organization_id=$2 AND project_id=$3 FOR UPDATE',
        [f.tenant, f.organization, f.project],
      )
      pending = savePolicy(request(f, body(f)))
      void pending.then(
        () => {
          routeSettled = true
        },
        () => {
          routeSettled = true
        },
      )
      let routePID: number | undefined
      const gateDeadline = Date.now() + 4000
      while (!routeSettled && Date.now() < gateDeadline) {
        const waiting = await fixtureOwner!.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
         AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%INSERT INTO resource_routing_policies%'`,
          [gatePID],
        )
        if (waiting.rows.length === 1) {
          routePID = waiting.rows[0].pid
          gateConfirmed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(gateConfirmed, 'Actual policy UPSERT must wait at the fixture row lock').toBe(true)
      let changeSettled = false
      changing = changeAuthority(writer, f, change)
      void changing.then(
        () => {
          changeSettled = true
        },
        () => {
          changeSettled = true
        },
      )
      const changeDeadline = Date.now() + 4000
      while (!changeSettled && Date.now() < changeDeadline) {
        const waiting = await fixtureOwner!.query<{ waiting: boolean }>(
          'SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS waiting',
          [writerPID, routePID],
        )
        if (waiting.rows[0]?.waiting) {
          changeWaitedForCommit = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      changeFinishedBeforeCommit = changeSettled
    } finally {
      try {
        try {
          await gate.query('ROLLBACK')
        } finally {
          gate.release()
        }
      } finally {
        // Release the policy gate before awaiting either operation; GREEN intentionally blocks the writer.
        try {
          if (pending) response = await bounded(pending, 'Policy route did not settle after gate release')
        } finally {
          try {
            if (changing) await bounded(changing, 'Authority writer did not settle after policy commit')
          } finally {
            writer?.release()
          }
        }
      }
    }
    const observation = {
      kind: change,
      status: response!.status,
      gateConfirmed,
      changeFinishedBeforeCommit,
      changeWaitedForCommit,
      policyChanged: isDeepStrictEqual(await storedPolicy(f), policy(f, true)),
      authorityChanged: await authorityChanged(f, change),
      immutableFactsUnchanged: isDeepStrictEqual(await immutableFacts(), before),
      successAuditDelta: (await successAudits(f)) - auditBefore,
    }
    observations.push(observation)
    expect(observation.status).toBe(200)
    expect(observation.policyChanged).toBe(true)
    expect(observation.authorityChanged).toBe(true)
    expect(observation.immutableFactsUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(1)
    expect(
      observation.changeFinishedBeforeCommit,
      'Revocation must not finish while an authorized policy commit is pending',
    ).toBe(false)
    expect(
      observation.changeWaitedForCommit,
      'Revocation must wait for the route transaction authorization locks',
    ).toBe(true)
  },
  20000,
)

it.each(['admin', 'developer'] as const)(
  'control: current %s can save policy without execution or accounting effects',
  async (role) => {
    const f = await fixture(role)
    const before = await immutableFacts()
    const auditBefore = await successAudits(f)
    const response = await bounded(savePolicy(request(f, body(f))), 'Normal policy save did not settle')
    const observation = {
      kind: 'normal-' + role,
      status: response.status,
      policyChanged: isDeepStrictEqual(await storedPolicy(f), policy(f, true)),
      immutableFactsUnchanged: isDeepStrictEqual(await immutableFacts(), before),
      successAuditDelta: (await successAudits(f)) - auditBefore,
    }
    observations.push(observation)
    expect(observation.status).toBe(200)
    expect(observation.policyChanged).toBe(true)
    expect(observation.immutableFactsUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(1)
  },
)

it.each(changes)(
  'control: body-delayed policy save checks fresh authority after %s',
  async (change) => {
    const f = await fixture(change === 'developer project membership removed' ? 'developer' : 'admin')
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let entered!: () => void
    const consumed = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
        },
        pull() {
          entered()
        },
      },
      { highWaterMark: 0 },
    )
    const req = request(f, stream)
    const pending = savePolicy(req)
    let bodyFinished = false
    let response: Response | undefined
    let before: Awaited<ReturnType<typeof immutableFacts>> | undefined
    let auditBefore: number | undefined
    try {
      await bounded(consumed, 'Actual policy route did not consume its body', 4000)
      expect(req.bodyUsed).toBe(true)
      await changeAuthority(pool, f, change)
      before = await immutableFacts()
      auditBefore = await successAudits(f)
      bodyFinished = true
      controller.enqueue(new TextEncoder().encode(body(f)))
      controller.close()
    } finally {
      if (!bodyFinished) controller.error(new Error('Fixture body closed during cleanup'))
      response = await bounded(pending, 'Body-delayed policy route did not settle')
    }
    const observation = {
      kind: 'body-delayed-' + change,
      status: response.status,
      policyUnchanged: isDeepStrictEqual(await storedPolicy(f), policy(f)),
      immutableFactsUnchanged: isDeepStrictEqual(await immutableFacts(), before),
      successAuditDelta: (await successAudits(f)) - auditBefore!,
    }
    observations.push(observation)
    expect(observation.status).toBe(change === 'administrator downgrade' ? 403 : 404)
    expect(observation.policyUnchanged).toBe(true)
    expect(observation.immutableFactsUnchanged).toBe(true)
    expect(observation.successAuditDelta).toBe(0)
  },
  20000,
)
