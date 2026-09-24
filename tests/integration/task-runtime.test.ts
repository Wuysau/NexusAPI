import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTask, readTasks, requestTaskAction } from '../../src/lib/task-runtime/store'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const scope = { tenantId: 'supervisor-t', organizationId: 'supervisor-o', projectId: 'supervisor-p' }
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(
    "INSERT INTO organizations(id,tenant_id,name,slug) VALUES('supervisor-o','supervisor-t','Supervisor','supervisor') ON CONFLICT DO NOTHING",
  )
  await pool.query(
    "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('supervisor-p','supervisor-t','supervisor-o','Supervisor') ON CONFLICT DO NOTHING",
  )
})
afterAll(async () => {
  await pool.end()
})
it('persists one task independently of sessions and enforces command state/scope', async () => {
  const task = await createTask(pool, scope, { cwd: 'D:/fixture', goal: 'Complete fixture', persistContext: true })
  expect(task.status).toBe('paused')
  expect(task.requested_action).toBe('start')
  expect((await readTasks(pool, { ...scope, tenantId: 'other' })).length).toBe(0)
  await expect(requestTaskAction(pool, { ...scope, tenantId: 'other' }, task.id, 'resume')).rejects.toThrow()
  await expect(requestTaskAction(pool, scope, task.id, 'switch', 'missing')).rejects.toThrow()
  await pool.query("UPDATE nexus_tasks SET requested_action=NULL,status='paused' WHERE tenant_id=$1 AND id=$2", [
    scope.tenantId,
    task.id,
  ])
  await requestTaskAction(pool, scope, task.id, 'resume')
  await expect(requestTaskAction(pool, scope, task.id, 'resume')).rejects.toThrow()
  expect((await readTasks(pool, scope)).find((t) => t.id === task.id)?.sessions).toEqual([])
})
it('refuses task content persistence without explicit opt-in and absent project', async () => {
  await expect(
    createTask(pool, scope, { cwd: 'D:/fixture', goal: 'secret goal', persistContext: false }),
  ).rejects.toThrow()
  await expect(
    createTask(pool, { ...scope, projectId: 'foreign' }, { cwd: 'D:/fixture', goal: 'goal', persistContext: true }),
  ).rejects.toThrow()
})
