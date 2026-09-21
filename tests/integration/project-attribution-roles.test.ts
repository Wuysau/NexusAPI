import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o','t','roles','project-roles');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('p','t','o','Project');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES ('r','t','o','alias','byok')`)
})
afterAll(async () => {
  await pool.end()
})

it('Gateway captures tenant-checked attribution without reading control-plane configuration', async () => {
  const gateway = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c role=nexus_gateway' })
  try {
    await gateway.query(`INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status)
      VALUES ('r','t','o','p','Project','byok','attributed')`)
    expect(
      (await gateway.query("SELECT project_id FROM request_project_facts WHERE tenant_id='t' AND request_id='r'"))
        .rows[0].project_id,
    ).toBe('p')
    await expect(gateway.query('SELECT * FROM provider_credentials')).rejects.toMatchObject({ code: '42501' })
    await expect(gateway.query("UPDATE request_project_facts SET project_name='tampered'")).rejects.toMatchObject({
      code: '42501',
    })
    await expect(gateway.query('DELETE FROM request_project_facts')).rejects.toMatchObject({ code: '42501' })
  } finally {
    await gateway.end()
  }
})

it('Budget can capture and Worker/control can read, but cannot rewrite historical attribution', async () => {
  for (const role of ['nexus_budget', 'nexus_worker', 'nexus_control']) {
    const client = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` })
    try {
      if (role === 'nexus_budget') {
        await client.query(`INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind)
          VALUES ('budget-r','t','o','alias','byok')`)
        await client.query(`INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status)
          VALUES ('budget-r','t','o','p','Project','byok','attributed')`)
      }
      await client.query("SELECT * FROM request_project_facts WHERE tenant_id='t'")
      await expect(client.query('DELETE FROM request_project_facts')).rejects.toMatchObject({ code: '42501' })
      await expect(client.query("UPDATE request_project_facts SET project_name='tampered'")).rejects.toMatchObject({
        code: '42501',
      })
      if (role !== 'nexus_budget')
        await expect(
          client.query(`INSERT INTO request_project_facts(request_id,tenant_id,organization_id,execution_mode,attribution_status)
        VALUES ('forbidden','t','o','unknown','unknown')`),
        ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.end()
    }
  }
})
