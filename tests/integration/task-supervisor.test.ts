import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResourceObservation, RuntimeEvent, ToolAdapter } from '../../src/lib/local-agent/adapter'
import type { AgentConfig } from '../../src/lib/task-runtime/configuration'
import { TaskSupervisor } from '../../src/lib/task-runtime/supervisor'
import {
  createTask,
  requestTaskAction,
  requestContinuation,
  savePolicy,
  type TaskRow,
  type TaskScope,
} from '../../src/lib/task-runtime/store'
import type { RoutingPolicy } from '../../src/lib/task-runtime/router'

const runnerPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runnerPath)
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL is required for supervisor tests')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
const git = promisify(execFile)
let scope: TaskScope
let root: string
let config: AgentConfig
let routing: RoutingPolicy
let connections: [string, string]
let adapters: FakeAdapter[]
let supervisors: TaskSupervisor[]
let resumeSupported: boolean

class FakeAdapter implements ToolAdapter {
  state: ReturnType<ToolAdapter['inspect']>['state'] = 'idle'
  sessionId: string | null = null
  events: RuntimeEvent[] = []
  submissions: { prompt: string; binding: TaskRow }[] = []
  stoppedWhileRunning = false
  failStop = false
  onStop?: () => Promise<void>
  profileRef: string | null = null
  readResourceObservation?: () => Promise<ResourceObservation>
  async launch(profile: { profileRef: string }) {
    this.profileRef = profile.profileRef
    this.state = 'idle'
  }
  async startSession() {
    this.sessionId = randomUUID()
    return this.sessionId
  }
  async canResumeConversation(sessionId: string) {
    if (
      resumeSupported &&
      adapters.some((other) => other !== this && other.sessionId === sessionId && other.state !== 'stopped')
    )
      throw new Error('source_runtime_writer_still_alive')
    return resumeSupported
  }
  async canSwitchResourceInPlace() {
    return false
  }
  async switchResourceInPlace(): Promise<string> {
    throw new Error('unsupported')
  }
  async canMigrateConversation() {
    return false
  }
  async resumeSession(sessionId: string) {
    if (!resumeSupported) throw new Error('conversation_unavailable')
    this.sessionId = sessionId
    return sessionId
  }
  async submit(sessionId: string, prompt: string) {
    // Observe the durable binding at the dispatch boundary, before any fake work starts.
    const result = await pool.query<TaskRow>(
      `SELECT t.* FROM nexus_tasks t JOIN task_sessions s ON s.task_id=t.id AND s.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.organization_id=$2 AND t.project_id=$3 AND t.active_session=$4
       AND s.external_session_id=$4 AND s.status='running' AND t.active_resource=COALESCE((
         SELECT target_connection_id FROM task_resource_transitions r
         WHERE r.tenant_id=t.tenant_id AND r.organization_id=t.organization_id AND r.task_id=t.id
         AND r.target_conversation_id=$4 ORDER BY r.created_at DESC,r.id DESC LIMIT 1
       ),s.connection_id)`,
      [scope.tenantId, scope.organizationId, scope.projectId, sessionId],
    )
    if (!result.rows[0]) throw new Error('dispatch_without_durable_binding')
    this.submissions.push({ prompt, binding: result.rows[0] })
    this.state = 'running'
  }
  inspect() {
    return { state: this.state, sessionId: this.sessionId }
  }
  async stop() {
    if (this.failStop) throw new Error('runtime_stop_timeout')
    const callback = this.onStop
    this.onStop = undefined
    await callback?.()
    this.stoppedWhileRunning ||= this.state === 'running'
    this.state = 'stopped'
  }
  drainEvents() {
    return this.events.splice(0)
  }
  fail(reason: RuntimeEvent['reason']) {
    this.state = 'failed'
    this.events.push({ type: 'session_failed', sessionId: this.sessionId!, reason })
  }
  complete() {
    this.state = 'idle'
    this.events.push({ type: 'turn_completed', sessionId: this.sessionId! })
  }
}
function supervisor(readProfiles = false) {
  const value = new TaskSupervisor(pool, config, () => {
    const adapter = new FakeAdapter()
    if (readProfiles) {
      adapter.readResourceObservation = async () => ({
        source: 'codex_app_server',
        identity: null,
        account: { type: 'chatgpt', email: `${adapter.profileRef}@example.invalid`, planType: 'pro' },
        quotas: [
          {
            windowType: 'codex:codex:primary',
            used: '10',
            remaining: '90',
            resetAt: new Date(Date.now() + 3600000).toISOString(),
            metadata: { unit: 'percent', limitId: 'codex', window: 'primary', windowDurationMins: 300 },
          },
        ],
      })
    }
    adapters.push(adapter)
    return adapter
  })
  supervisors.push(value)
  return value
}
const launched = () => adapters.filter((adapter) => adapter.sessionId !== null)
async function task(id: string): Promise<TaskRow> {
  return (await pool.query<TaskRow>('SELECT * FROM nexus_tasks WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id]))
    .rows[0]
}
async function setQuota(connectionId: string, used: number) {
  await pool.query(
    `INSERT INTO quota_snapshots(tenant_id,connection_id,observation_id,window_type,used,remaining,source,source_kind,
      confidence,scope,attribution_mode,availability,observed_at,stale_at,reset_at,provenance_version,metadata)
     VALUES($1,$2,$3,'daily',$4,$5,'provider','official','reported','connection','exclusive','available',
      clock_timestamp(),now()+interval '5 minutes',now()+interval '1 hour',1,'{"unit":"percent"}')`,
    [scope.tenantId, connectionId, randomUUID(), String(used), String(100 - used)],
  )
}
async function start(readProfiles = false) {
  const created = await createTask(pool, scope, {
    cwd: config.workspaces[0].cwd,
    goal: 'Finish the existing parser and verify its tests.',
    persistContext: true,
  })
  const runtime = supervisor(readProfiles)
  await runtime.tick()
  expect((await task(created.id)).status).toBe('running')
  return { created, runtime, adapter: launched()[0] }
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
}, 30000)
beforeEach(async () => {
  const id = randomUUID()
  scope = { tenantId: `supervisor-${id}`, organizationId: `org-${id}`, projectId: `project-${id}` }
  connections = [`a-${id}`, `b-${id}`]
  adapters = []
  supervisors = []
  resumeSupported = false
  root = await mkdtemp(path.join(tmpdir(), 'nexus-supervisor-'))
  const cwd = path.join(root, 'repository')
  await mkdir(cwd)
  await git('git', ['init', '--quiet'], { cwd, windowsHide: true })
  await writeFile(path.join(cwd, 'README.md'), 'Task supervisor fixture\n')
  await git('git', ['add', 'README.md'], { cwd, windowsHide: true })
  await git(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
    { cwd, windowsHide: true },
  )
  config = {
    ...scope,
    profiles: connections.map((connectionId, i) => ({
      connectionId,
      profileRef: `profile-${i}`,
      home: path.join(root, `profile-${i}`),
    })),
    workspaces: [{ projectId: scope.projectId, cwd }],
  }
  routing = {
    name: 'coding',
    workload: 'coding',
    requiredCapabilities: ['coding'],
    tool: 'codex',
    model: null,
    autoFailover: true,
    autoReturn: false,
    candidates: connections.map((connectionId, i) => ({
      connectionId,
      profileRef: `profile-${i}`,
      priority: i,
      enabled: true,
      switchThreshold: 90,
      capabilities: ['coding'],
      allowedModels: [],
      allowedTools: ['codex'],
      costMode: 'subscription',
    })),
  }
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [
    scope.organizationId,
    scope.tenantId,
  ])
  await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
    scope.projectId,
    scope.tenantId,
    scope.organizationId,
  ])
  for (const connectionId of connections) {
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,status,capabilities)
       VALUES($1,$2,$3,'openai','subscription_interactive','active',
       '{"routing":false,"execution_mode":"interactive","connection_type":"subscription"}')`,
      [connectionId, scope.tenantId, scope.projectId],
    )
    await setQuota(connectionId, 10)
  }
  await savePolicy(pool, scope, routing)
}, 20000)
afterEach(async () => {
  for (const adapter of adapters) {
    adapter.failStop = false
    if (adapter.state === 'running') adapter.state = 'idle'
  }
  for (const runtime of supervisors) await runtime.stop()
  for (const table of [
    'task_resource_transitions',
    'task_handoff_snapshots',
    'task_sessions',
    'nexus_tasks',
    'resource_routing_policies',
    'quota_snapshots',
    'owned_connections',
    'projects',
    'organizations',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [scope.tenantId])
  }
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('nexus-supervisor-'))
    throw new Error('unsafe_fixture_cleanup')
  await rm(resolved, { recursive: true, force: true })
}, 20000)
afterAll(async () => {
  await pool.end()
})

describe('durable task supervisor', () => {
  it('continues an exhausted resource on the same conversation when the target profile can load it', async () => {
    resumeSupported = true
    const { created, runtime, adapter } = await start()
    adapter.fail('quota_exhausted')
    await runtime.tick()
    const current = await task(created.id)
    expect(current).toMatchObject({
      status: 'resumed',
      active_resource: connections[1],
      active_session: adapter.sessionId,
    })
    const transitions = (
      await pool.query(
        'SELECT switch_type,source_conversation_id,target_conversation_id FROM task_resource_transitions WHERE tenant_id=$1 AND task_id=$2',
        [scope.tenantId, created.id],
      )
    ).rows
    expect(transitions).toEqual([
      {
        switch_type: 'runtime_restart',
        source_conversation_id: adapter.sessionId,
        target_conversation_id: adapter.sessionId,
      },
    ])
    expect(
      (
        await pool.query('SELECT count(*)::int count FROM task_sessions WHERE tenant_id=$1 AND task_id=$2', [
          scope.tenantId,
          created.id,
        ])
      ).rows[0].count,
    ).toBe(1)
    expect(
      (
        await pool.query('SELECT count(*)::int count FROM task_handoff_snapshots WHERE tenant_id=$1 AND task_id=$2', [
          scope.tenantId,
          created.id,
        ])
      ).rows[0].count,
    ).toBe(0)
  })

  it('resumes a completed task in its existing conversation when the profile still has that history', async () => {
    resumeSupported = true
    const { created, runtime, adapter } = await start()
    adapter.complete()
    await runtime.tick()
    await requestContinuation(pool, scope, created.id, 'Add one more parser assertion.')
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({
      status: 'resumed',
      active_resource: connections[0],
      active_session: adapter.sessionId,
    })
    expect(
      (
        await pool.query('SELECT count(*)::int count FROM task_sessions WHERE tenant_id=$1 AND task_id=$2', [
          scope.tenantId,
          created.id,
        ])
      ).rows[0].count,
    ).toBe(1)
  })
  it('binds the initial session to the task and resource before dispatch', async () => {
    const { created, adapter } = await start()
    expect(launched()).toHaveLength(1)
    expect(adapter.submissions[0].binding).toMatchObject({
      id: created.id,
      project_id: scope.projectId,
      active_resource: connections[0],
      active_session: adapter.sessionId,
    })
    expect(adapter.submissions[0].prompt).toContain(created.original_goal)
  })

  it('captures an emergency handoff and continues the same task in a new session', async () => {
    const { created, runtime, adapter } = await start()
    await writeFile(path.join(config.workspaces[0].cwd, 'progress.txt'), 'Already completed a local step\n')
    adapter.fail('quota_exhausted')
    await runtime.tick()
    const current = await task(created.id)
    expect(current).toMatchObject({
      status: 'resumed',
      active_resource: connections[1],
      original_goal: created.original_goal,
    })
    expect(current.active_session).not.toBe(adapter.sessionId)
    const history = (
      await pool.query('SELECT * FROM task_handoff_snapshots WHERE tenant_id=$1 AND task_id=$2', [
        scope.tenantId,
        created.id,
      ])
    ).rows
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      source_connection_id: connections[0],
      source_session_id: adapter.sessionId,
      target_connection_id: connections[1],
      reason: 'quota_exhausted',
    })
    expect(history[0].workspace_state.modifiedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'progress.txt' })]),
    )
    expect(launched()[1].submissions[0].prompt).toContain('Do not replay completed or uncertain external actions')
  })

  it('refreshes the fallback profile quota after its previous observation expires', async () => {
    // This case obtains every official window from profile RPC, without unrelated seeded provider windows.
    await pool.query('DELETE FROM quota_snapshots WHERE tenant_id=$1', [scope.tenantId])
    const { created, runtime, adapter } = await start(true)
    await pool.query(
      "UPDATE quota_snapshots SET observed_at=now()-interval '10 minutes',stale_at=now()-interval '5 minutes' WHERE tenant_id=$1 AND connection_id=$2",
      [scope.tenantId, connections[1]],
    )
    adapter.fail('quota_exhausted')
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'resumed', active_resource: connections[1] })
    expect(launched()).toHaveLength(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM quota_snapshots WHERE tenant_id=$1 AND connection_id=$2 AND source='codex_app_server' AND stale_at>now()",
          [scope.tenantId, connections[1]],
        )
      ).rows[0].count,
    ).toBeGreaterThan(0)
  })

  it('prepares fallback at 99% and continues the current resource through completion', async () => {
    const { created, runtime, adapter } = await start()
    await setQuota(connections[0], 99)
    await runtime.tick()
    expect((await task(created.id)).status).toBe('running')
    expect((await task(created.id)).active_resource).toBe(connections[0])
    expect(launched()).toHaveLength(1)
    expect(adapter.stoppedWhileRunning).toBe(false)
    adapter.complete()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'completed', active_resource: connections[0] })
    expect(launched()).toHaveLength(1)
    expect(adapter.stoppedWhileRunning).toBe(false)
  })

  it('routes a manual switch through the same boundary and persisted snapshot pipeline', async () => {
    const { created, runtime, adapter } = await start()
    await requestTaskAction(pool, scope, created.id, 'switch', connections[1])
    await runtime.tick()
    expect((await task(created.id)).status).toBe('handoff_pending')
    adapter.complete()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({
      status: 'resumed',
      active_resource: connections[1],
      requested_action: null,
    })
    const snapshots = (
      await pool.query('SELECT reason,target_connection_id FROM task_handoff_snapshots WHERE tenant_id=$1', [
        scope.tenantId,
      ])
    ).rows
    expect(snapshots).toEqual([{ reason: 'manual_switch', target_connection_id: connections[1] }])
  })

  it('does not fail over for an ordinary session failure', async () => {
    const { created, runtime, adapter } = await start()
    adapter.fail('unknown')
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'failed', pause_reason: 'unknown' })
    expect((await task(created.id)).active_session).toBe(adapter.sessionId)
    expect(launched()).toHaveLength(1)
  })

  it('classifies a local account authentication requirement before switching', async () => {
    const { created, runtime, adapter } = await start()
    await pool.query('UPDATE owned_connections SET account_observation=$3::jsonb WHERE tenant_id=$1 AND id=$2', [
      scope.tenantId,
      connections[0],
      JSON.stringify({ organizationId: scope.organizationId, status: 'authentication_required' }),
    ])
    await runtime.tick()
    expect((await task(created.id)).pause_reason).toBe('authentication_failure')
    expect(adapter.stoppedWhileRunning).toBe(false)
    adapter.complete()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'resumed', active_resource: connections[1] })
    const reason = (
      await pool.query('SELECT reason FROM task_resource_transitions WHERE tenant_id=$1 AND task_id=$2', [
        scope.tenantId,
        created.id,
      ])
    ).rows[0]?.reason
    expect(reason).toBe('authentication_failure')
  })

  it('does not switch a healthy active resource back to a preferred candidate', async () => {
    await savePolicy(pool, scope, { ...routing, autoReturn: true })
    await setQuota(connections[0], 100)
    const { created, runtime, adapter } = await start()
    expect((await task(created.id)).active_resource).toBe(connections[1])
    await setQuota(connections[0], 10)
    await runtime.tick()
    expect((await task(created.id)).active_resource).toBe(connections[1])
    expect(launched()).toHaveLength(1)
    adapter.state = 'idle'
    await runtime.tick()
    expect((await task(created.id)).active_resource).toBe(connections[1])
    expect(launched()).toHaveLength(1)
    expect(adapter.stoppedWhileRunning).toBe(false)
  })

  it('does not auto-return when disabled or launch extra work after task completion', async () => {
    await setQuota(connections[0], 100)
    const { created, runtime, adapter } = await start()
    await setQuota(connections[0], 10)
    adapter.state = 'idle'
    await runtime.tick()
    expect((await task(created.id)).active_resource).toBe(connections[1])
    expect(launched()).toHaveLength(1)
    await savePolicy(pool, scope, { ...routing, autoReturn: true })
    adapter.complete()
    await runtime.tick()
    expect((await task(created.id)).status).toBe('completed')
    expect(launched()).toHaveLength(1)
  })

  it.each([false, true])('continues a completed task with a new user turn and autoReturn=%s', async (autoReturn) => {
    await savePolicy(pool, scope, { ...routing, autoReturn })
    await setQuota(connections[0], 100)
    const { created, runtime, adapter } = await start()
    expect((await task(created.id)).active_resource).toBe(connections[1])
    adapter.complete()
    await runtime.tick()
    expect((await task(created.id)).status).toBe('completed')
    await setQuota(connections[0], 10)
    const instruction = 'Now add regression coverage for the completed parser.'
    await requestContinuation(pool, scope, created.id, instruction)
    await runtime.tick()
    const current = await task(created.id)
    expect(current).toMatchObject({
      id: created.id,
      status: 'resumed',
      original_goal: created.original_goal,
      active_resource: connections[1],
      context: { lastUserInstruction: instruction },
    })
    expect(launched()).toHaveLength(2)
    expect(current.active_session).not.toBe(adapter.sessionId)
    expect(launched()[1].submissions[0].prompt).toContain(instruction)
    expect(launched()[1].submissions[0].prompt).toContain(created.original_goal)
    launched()[1].complete()
    await runtime.tick()
    expect((await task(created.id)).status).toBe('completed')
  })

  it('preserves a continuation queued during runtime shutdown when clearing the old PID', async () => {
    const { created, runtime, adapter } = await start()
    await pool.query('UPDATE nexus_tasks SET context=context || $3::jsonb WHERE tenant_id=$1 AND id=$2', [
      scope.tenantId,
      created.id,
      JSON.stringify({ runtimePid: 2147483647 }),
    ])
    const instruction = 'Follow up with the new parser edge case after this completed turn.'
    adapter.onStop = async () => {
      expect((await task(created.id)).status).toBe('completed')
      await requestContinuation(pool, scope, created.id, instruction)
    }
    adapter.complete()
    await runtime.tick()
    const queued = await task(created.id)
    expect(queued).toMatchObject({ requested_action: 'resume', context: { lastUserInstruction: instruction } })
    expect(queued.context).not.toHaveProperty('runtimePid')
    await runtime.tick()
    expect(launched()).toHaveLength(2)
    expect(launched()[1].submissions[0].prompt).toContain(instruction)
    expect((await task(created.id)).original_goal).toBe(created.original_goal)
  })

  it.each([false, true])(
    'does not overwrite a newer supervisor after lease loss with newer turn completed=%s',
    async (completed) => {
      const { created, runtime, adapter } = await start()
      const locks = (
        await pool.query(`SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
      ).rows
      expect(locks).toHaveLength(1)
      await pool.query('SELECT pg_terminate_backend($1)', [locks[0].pid])
      await runtime.tick()
      await runtime.tick()
      const contender = supervisor()
      let newSession: string | null = null
      adapter.onStop = async () => {
        // Another supervisor recovers and accepts an explicit new turn while the old one is stopping.
        await contender.tick()
        await requestContinuation(pool, scope, created.id, 'New owner continuation must survive stale recovery.')
        await contender.tick()
        newSession = (await task(created.id)).active_session
        if (completed) {
          launched()[1].complete()
          await contender.tick()
        }
      }
      adapter.fail('quota_exhausted')
      await runtime.tick()
      expect(launched()).toHaveLength(2)
      expect(await task(created.id)).toMatchObject({
        status: completed ? 'completed' : 'resumed',
        active_session: newSession,
        command_seq: 1,
        context: { lastUserInstruction: 'New owner continuation must survive stale recovery.' },
      })
      const latest = (
        await pool.query('SELECT status FROM task_sessions WHERE tenant_id=$1 AND external_session_id=$2', [
          scope.tenantId,
          newSession,
        ])
      ).rows[0]
      expect(latest.status).toBe(completed ? 'completed' : 'running')
    },
  )

  it('waits for a safe boundary after the database lease is terminated and never dispatches fallback', async () => {
    const { created, runtime, adapter } = await start()
    const locks = (
      await pool.query(`SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
    ).rows
    expect(locks).toHaveLength(1)
    expect((await pool.query('SELECT pg_terminate_backend($1) AS terminated', [locks[0].pid])).rows[0].terminated).toBe(
      true,
    )
    await runtime.tick()
    await runtime.tick()
    expect(adapter.inspect().state).toBe('running')
    expect(adapter.stoppedWhileRunning).toBe(false)
    expect(launched()).toHaveLength(1)
    adapter.fail('quota_exhausted')
    await runtime.tick()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'paused', pause_reason: 'supervisor_interrupted' })
    expect(launched()).toHaveLength(1)
    expect(adapter.stoppedWhileRunning).toBe(false)
    const sessions = (
      await pool.query('SELECT status,ended_at FROM task_sessions WHERE tenant_id=$1 AND task_id=$2', [
        scope.tenantId,
        created.id,
      ])
    ).rows
    expect(sessions[0].status).toBe('paused')
    expect(sessions[0].ended_at).not.toBeNull()
  })

  it('pauses once with the next reset when all resources are exhausted', async () => {
    await setQuota(connections[0], 100)
    await setQuota(connections[1], 100)
    const created = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'Continue when capacity exists',
      persistContext: true,
    })
    const runtime = supervisor()
    await runtime.tick()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'paused', pause_reason: 'no_compatible_resources' })
    expect((await task(created.id)).next_reset_at!.getTime()).toBeGreaterThan(Date.now())
    expect(launched()).toHaveLength(0)
  })

  it('automatically resumes the preserved conversation after fresh provider recovery', async () => {
    resumeSupported = true
    await setQuota(connections[1], 100)
    const { created, runtime, adapter } = await start()
    adapter.fail('quota_exhausted')
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({ status: 'paused', active_session: adapter.sessionId })
    await setQuota(connections[0], 10)
    await pool.query("UPDATE nexus_tasks SET heartbeat_at=now()-interval '31 seconds' WHERE tenant_id=$1 AND id=$2", [
      scope.tenantId,
      created.id,
    ])
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({
      status: 'resumed',
      active_resource: connections[0],
      active_session: adapter.sessionId,
    })
    expect(
      (
        await pool.query('SELECT count(*)::int count FROM task_sessions WHERE tenant_id=$1 AND task_id=$2', [
          scope.tenantId,
          created.id,
        ])
      ).rows[0].count,
    ).toBe(1)
  })

  it('allows only one supervisor and task to run in the same workspace', async () => {
    const first = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'First task',
      persistContext: true,
    })
    const second = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'Second task',
      persistContext: true,
    })
    const a = supervisor(),
      b = supervisor()
    await Promise.all([a.tick(), b.tick()])
    expect(launched()).toHaveLength(1)
    expect([await task(first.id), await task(second.id)].filter((t) => t.status === 'running')).toHaveLength(1)
    expect([await task(first.id), await task(second.id)].filter((t) => t.requested_action === 'start')).toHaveLength(1)
  })

  it('does not run two workspaces against the same local account profile', async () => {
    const otherCwd = path.join(root, 'repository-two')
    await mkdir(otherCwd)
    await git('git', ['init', '--quiet'], { cwd: otherCwd, windowsHide: true })
    config.workspaces.push({ projectId: scope.projectId, cwd: otherCwd })
    const first = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'First workspace',
      persistContext: true,
    })
    const second = await createTask(pool, scope, {
      cwd: otherCwd,
      goal: 'Second workspace',
      persistContext: true,
    })
    const runtime = supervisor()
    await runtime.tick()
    const resources = [await task(first.id), await task(second.id)].map((row) => row.active_resource).sort()
    expect(resources).toEqual([...connections].sort())
  })

  it('keeps a profile occupied by another live task after its database lease is lost', async () => {
    const { runtime } = await start()
    const otherCwd = path.join(root, 'repository-two')
    await mkdir(otherCwd)
    await git('git', ['init', '--quiet'], { cwd: otherCwd, windowsHide: true })
    const second = await createTask(pool, scope, { cwd: otherCwd, goal: 'Second workspace', persistContext: true })
    const lease = (
      await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
       AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY pid HAVING count(*) >= 2`,
      )
    ).rows
    expect(lease).toHaveLength(1)
    await pool.query('SELECT pg_terminate_backend($1)', [lease[0].pid])
    config.workspaces.splice(0, 1, { projectId: scope.projectId, cwd: otherCwd })
    const contender = supervisor()
    await contender.tick()
    expect((await task(second.id)).active_resource).toBe(connections[1])
    expect(runtime).toBeDefined()
  })

  it('fences the current account after same-conversation failover loses its lease', async () => {
    resumeSupported = true
    const { runtime, adapter } = await start()
    adapter.fail('quota_exhausted')
    await runtime.tick()
    const otherCwd = path.join(root, 'repository-two')
    await mkdir(otherCwd)
    await git('git', ['init', '--quiet'], { cwd: otherCwd, windowsHide: true })
    const second = await createTask(pool, scope, { cwd: otherCwd, goal: 'Second workspace', persistContext: true })
    const lease = (
      await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
       AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY pid HAVING count(*) >= 2`,
      )
    ).rows
    expect(lease).toHaveLength(1)
    await pool.query('SELECT pg_terminate_backend($1)', [lease[0].pid])
    config.workspaces.splice(0, 1, { projectId: scope.projectId, cwd: otherCwd })
    const contender = supervisor()
    await contender.tick()
    expect((await task(second.id)).active_resource).toBeNull()
    expect((await task(second.id)).pause_reason).toBe('no_compatible_resources')
  })

  it('pauses an uncertain persisted launch after restart without replay', async () => {
    const created = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'Never replay a possible external write',
      persistContext: true,
    })
    await pool.query("UPDATE nexus_tasks SET status='switching',requested_action=NULL WHERE tenant_id=$1 AND id=$2", [
      scope.tenantId,
      created.id,
    ])
    const runtime = supervisor()
    await runtime.tick()
    await runtime.tick()
    expect(await task(created.id)).toMatchObject({
      status: 'paused',
      pause_reason: 'supervisor_interrupted',
      requested_action: null,
    })
    expect(launched()).toHaveLength(0)
  })

  it('pauses at a safe boundary during graceful shutdown', async () => {
    const { created, runtime, adapter } = await start()
    adapter.complete()
    await runtime.stop()
    expect(await task(created.id)).toMatchObject({ status: 'paused', pause_reason: 'supervisor_interrupted' })
    expect(adapter.stoppedWhileRunning).toBe(false)
  })

  it('prioritizes shutdown over a queued terminal quota failure without starting fallback', async () => {
    const { created, runtime, adapter } = await start()
    adapter.fail('quota_exhausted')
    await runtime.stop()
    expect(await task(created.id)).toMatchObject({ status: 'paused', pause_reason: 'supervisor_interrupted' })
    expect(launched()).toHaveLength(1)
  })

  it('retains the workspace lease and runtime when stop times out without launching fallback', async () => {
    const { created, runtime, adapter } = await start()
    adapter.failStop = true
    adapter.fail('quota_exhausted')
    await runtime.tick()
    expect(launched()).toHaveLength(1)
    expect(adapter.inspect()).toMatchObject({ state: 'failed', sessionId: adapter.sessionId })
    const pending = await createTask(pool, scope, {
      cwd: config.workspaces[0].cwd,
      goal: 'Must wait for original process',
      persistContext: true,
    })
    const contender = supervisor()
    await contender.tick()
    expect((await task(pending.id)).requested_action).toBe('start')
    expect((await task(created.id)).active_session).toBe(adapter.sessionId)
    expect(launched()).toHaveLength(1)
    // A separate database session cannot take the same canonical workspace lock.
    const client = await pool.connect()
    try {
      const key = config.workspaces[0].cwd.replace(/\\/g, '/').replace(/\/+$/, '')
      const lock = 'nexus-workspace:' + (/^[A-Za-z]:\//.test(key) ? key.toLowerCase() : key)
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lock])
      if (result.rows[0].locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock])
      expect(result.rows[0].locked).toBe(false)
    } finally {
      client.release()
    }
  })

  it.runIf(process.platform === 'win32')(
    'blocks a live prior PID under a case and slash alias of the Windows workspace',
    async () => {
      const cwd = config.workspaces[0].cwd
      const previous = await createTask(pool, scope, {
        cwd: cwd.toUpperCase().replace(/\\/g, '/'),
        goal: 'Previous process may still act',
        persistContext: true,
      })
      await pool.query(
        'UPDATE nexus_tasks SET requested_action=NULL,context=context || $3::jsonb WHERE tenant_id=$1 AND id=$2',
        [scope.tenantId, previous.id, JSON.stringify({ runtimePid: process.pid })],
      )
      const created = await createTask(pool, scope, { cwd, goal: 'Do not overlap previous PID', persistContext: true })
      await supervisor().tick()
      expect(await task(created.id)).toMatchObject({ status: 'paused', pause_reason: 'previous_runtime_still_alive' })
      expect(launched()).toHaveLength(0)
    },
  )
})
