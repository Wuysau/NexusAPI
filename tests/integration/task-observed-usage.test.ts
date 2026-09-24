import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { configureObserver, scanCodex } from '../../src/lib/observer/importer'
import { createTask, readTasks } from '../../src/lib/task-runtime/store'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const id = randomUUID()
const scope = { tenantId: `task-observed-${id}`, organizationId: `org-${id}`, projectId: `task-project-${id}` }
const otherProject = `workspace-project-${id}`
const connections = [`connection-a-${id}`, `connection-b-${id}`]
const sessions = [`session-a-${id}`, `session-b-${id}`]
let directory: string

beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'nexus-task-observed-'))
  await pool.query('INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,$1,$1)', [
    scope.organizationId,
    scope.tenantId,
  ])
  for (const projectId of [scope.projectId, otherProject]) {
    await pool.query('INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,$1)', [
      projectId,
      scope.tenantId,
      scope.organizationId,
    ])
  }
})
afterAll(async () => {
  for (const table of [
    'observer_scan_cursors',
    'external_observed_usage',
    'project_workspace_roots',
    'task_resource_transitions',
    'task_sessions',
    'nexus_tasks',
    'owned_connections',
    'projects',
    'organizations',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [scope.tenantId])
  }
  await pool.end()
  if (directory) {
    const resolved = path.resolve(directory)
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('nexus-task-observed-')
    )
      throw new Error('unsafe_fixture_cleanup')
    await rm(resolved, { recursive: true, force: true })
  }
})

it('attributes two Codex sessions to their durable task resources despite identical providers and conflicting workspace mapping, without billing', async () => {
  const config = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    sources: [directory],
    roots: [{ root: directory, projectId: otherProject }],
    providers: [{ identifier: 'openai', provider: 'openai', product: 'openai_codex', connectionId: connections[0] }],
  }
  await configureObserver(pool, config)
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,status,capabilities)
    VALUES($1,$2,$3,'openai','subscription_interactive','active',
    '{"routing":false,"execution_mode":"interactive","connection_type":"subscription","subscription_product":"openai_codex","provider_identifier":"openai"}')`,
    [connections[1], scope.tenantId, scope.projectId],
  )
  const created = await createTask(pool, scope, {
    cwd: directory,
    goal: 'Continue one task across accounts',
    persistContext: true,
  })
  for (const [index, session] of sessions.entries()) {
    await pool.query(
      `INSERT INTO task_sessions(tenant_id,organization_id,task_id,connection_id,profile_ref,external_session_id,status)
      VALUES($1,$2,$3,$4,$5,$6,'completed')`,
      [scope.tenantId, scope.organizationId, created.id, connections[index], `profile-${index}`, session],
    )
    const total = index === 0 ? 25 : 40
    const usage = { input_tokens: total - 5, output_tokens: 5, total_tokens: total }
    const events = [
      { type: 'session_meta', payload: { id: session, cwd: directory, model_provider: 'openai', source: 'cli' } },
      { type: 'turn_context', payload: { turn_id: `turn-${index}`, cwd: directory, model: 'model-fixture' } },
      {
        type: 'event_msg',
        timestamp: '2026-09-22T10:00:00Z',
        payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } },
      },
    ]
    await writeFile(
      path.join(directory, `session-${index}.jsonl`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    )
  }
  expect((await scanCodex(pool, config)).newEvents).toBe(2)
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
  const observed = (
    await pool.query(
      `SELECT external_session_id,connection_id,project_id,total_tokens::text,reasoning_tokens
    FROM external_observed_usage WHERE tenant_id=$1 ORDER BY external_session_id`,
      [scope.tenantId],
    )
  ).rows
  expect(observed).toEqual(
    sessions.map((session, index) => ({
      external_session_id: session,
      connection_id: connections[index],
      project_id: scope.projectId,
      total_tokens: index === 0 ? '25' : '40',
      reasoning_tokens: null,
    })),
  )
  const result = await readTasks(pool, scope)
  expect(result).toHaveLength(1)
  expect(result[0].usage).toEqual(
    expect.arrayContaining([
      { connectionId: connections[0], totalTokens: '25' },
      { connectionId: connections[1], totalTokens: '40' },
    ]),
  )
  for (const table of ['usage_events', 'usage_records', 'outbox_events', 'ledger_transactions', 'request_records']) {
    expect(
      (await pool.query(`SELECT count(*)::int count FROM ${table} WHERE tenant_id=$1`, [scope.tenantId])).rows[0].count,
    ).toBe(0)
  }
})

it('attributes one preserved conversation to its resource at each observed turn time', async () => {
  const session = `preserved-${randomUUID()}`
  const created = await createTask(pool, scope, {
    cwd: directory,
    goal: 'Preserve the current conversation through a resource switch',
    persistContext: true,
  })
  await pool.query(
    `INSERT INTO task_sessions(tenant_id,organization_id,task_id,connection_id,profile_ref,external_session_id,status)
     VALUES($1,$2,$3,$4,'profile-a',$5,'completed')`,
    [scope.tenantId, scope.organizationId, created.id, connections[0], session],
  )
  await pool.query(
    `INSERT INTO task_resource_transitions(tenant_id,organization_id,task_id,source_connection_id,target_connection_id,source_conversation_id,target_conversation_id,switch_type,reason,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$6,'runtime_restart','quota_exhausted',$7)`,
    [scope.tenantId, scope.organizationId, created.id, connections[0], connections[1], session, '2026-09-22T10:03:00Z'],
  )
  const events = [
    { type: 'session_meta', payload: { id: session, cwd: directory, model_provider: 'openai', source: 'cli' } },
    { type: 'turn_context', payload: { turn_id: 'before', cwd: directory, model: 'model-fixture' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-22T10:01:00Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          total_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        },
      },
    },
    { type: 'turn_context', payload: { turn_id: 'after', cwd: directory, model: 'model-fixture' } },
    {
      type: 'event_msg',
      timestamp: '2026-09-22T10:05:00Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 14, output_tokens: 6, total_tokens: 20 },
          total_token_usage: { input_tokens: 22, output_tokens: 8, total_tokens: 30 },
        },
      },
    },
  ]
  await writeFile(
    path.join(directory, `session-preserved-${randomUUID()}.jsonl`),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  )
  const config = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    sources: [directory],
    roots: [{ root: directory, projectId: otherProject }],
    providers: [],
  }
  await scanCodex(pool, config)
  const rows = (
    await pool.query(
      'SELECT connection_id,total_tokens::text FROM external_observed_usage WHERE tenant_id=$1 AND external_session_id=$2 ORDER BY occurred_at',
      [scope.tenantId, session],
    )
  ).rows
  expect(rows).toEqual([
    { connection_id: connections[0], total_tokens: '10' },
    { connection_id: connections[1], total_tokens: '20' },
  ])
  expect((await readTasks(pool, scope)).find((task) => task.id === created.id)?.usage).toEqual(
    expect.arrayContaining([
      { connectionId: connections[0], totalTokens: '10' },
      { connectionId: connections[1], totalTokens: '20' },
    ]),
  )
})
