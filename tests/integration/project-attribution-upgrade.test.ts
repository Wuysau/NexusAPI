import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeEach, expect, it } from 'vitest'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const folder = mkdtempSync(join(tmpdir(), 'nexus-project17-upgrade-'))
  try {
    cpSync('drizzle', folder, { recursive: true })
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, 9)
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
    await runMigrations(pool, { migrationsFolder: folder })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('a','ta','A','upgrade-a'),('b','tb','B','upgrade-b');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pa','ta','a','A'),('pb','tb','b','B');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES ('r','ta','a','alias','byok')`)
})
afterAll(async () => {
  await pool.end()
})
it.each(['key', 'connection', 'conflicting-project'])('refuses contaminated legacy %s facts', async (kind) => {
  await pool.query("INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pa2','ta','a','Another')")
  await pool.query(
    "INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix) VALUES ('kb','tb','b','B','bad-key-hash','test')",
  )
  await pool.query("INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES ('cb','tb','provider','byok')")
  if (kind === 'conflicting-project') await pool.query("UPDATE request_records SET project_id='pa2' WHERE id='r'")
  await pool.query(
    "INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,api_key_id,connection_id,execution_mode,attribution_status) VALUES ('r','ta','a','pa',$1,$2,'byok','attributed')",
    [kind === 'key' ? 'kb' : null, kind === 'connection' ? 'cb' : null],
  )
  await expect(runMigrations(pool)).rejects.toThrow(/scope|mismatch/)
})
it.each(['request', 'fact'])('refuses pre-existing cross-tenant %s project attribution atomically', async (kind) => {
  if (kind === 'request') await pool.query("UPDATE request_records SET project_id='pb' WHERE id='r'")
  else
    await pool.query(
      "INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,execution_mode,attribution_status) VALUES ('r','ta','a','pb','byok','attributed')",
    )
  await expect(runMigrations(pool)).rejects.toThrow(/scope/)
  expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount).toBe(9)
})
it('preserves legitimate 0008 facts while adding immutable enforcement', async () => {
  await pool.query(
    "INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,execution_mode,attribution_status) VALUES ('r','ta','a','pa','byok','attributed')",
  )
  const currentJournal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  expect((await runMigrations(pool)).applied).toBe(currentJournal.entries.length - 9)
  expect(
    (await pool.query("SELECT project_id FROM request_project_facts WHERE request_id='r'")).rows[0].project_id,
  ).toBe('pa')
  await expect(pool.query("DELETE FROM request_project_facts WHERE request_id='r'")).rejects.toThrow(/immutable/)
})
