import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('oa','ta','A','a'),('ob','tb','B','b');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pa','ta','oa','Original'),('pb','tb','ob','Other');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES
    ('ra','ta','oa','alias','byok'),('rb','tb','ob','alias','byok')`)
})
afterAll(async () => {
  await pool.end()
})
const insert = (request = 'ra', tenant = 'ta', org = 'oa', project = 'pa') =>
  pool.query(
    `INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status)
   VALUES($1,$2,$3,$4,'Original','byok','attributed')`,
    [request, tenant, org, project],
  )

describe('immutable tenant-safe project attribution', () => {
  it('keeps legacy writers valid and maps all frozen dimensions', async () => {
    const columns = (
      await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='request_project_facts'")
    ).rows.map((r) => r.column_name)
    for (const column of [
      'credential_id',
      'channel_id',
      'provider_id',
      'requested_model',
      'resolved_model',
      'model_id',
      'streaming',
      'price_version_id',
      'key_kind',
      'evidence_source',
      'evidence_digest',
    ])
      expect(columns).toContain(column)
    expect(readFileSync('src/db/schema.ts', 'utf8')).toContain('export const requestProjectFacts')
  })
  it('rejects cross-tenant request and project references', async () => {
    await expect(insert('ra', 'tb', 'ob', 'pb')).rejects.toThrow(/scope|tenant/)
    await expect(insert('ra', 'ta', 'oa', 'pb')).rejects.toThrow(/scope|tenant/)
    await expect(insert('ra', 'ta', 'ob', 'pa')).rejects.toThrow(/scope|tenant/)
  })
  it('rejects every update and delete and preserves history across rename, move and deletion', async () => {
    await insert()
    await expect(
      pool.query("UPDATE request_project_facts SET project_name='Changed' WHERE request_id='ra'"),
    ).rejects.toThrow(/immutable/)
    await expect(pool.query("DELETE FROM request_project_facts WHERE request_id='ra'")).rejects.toThrow(/immutable/)
    await pool.query("UPDATE projects SET name='Renamed',tenant_id='tb',organization_id='ob' WHERE id='pa'")
    await pool.query("DELETE FROM projects WHERE id='pa'")
    expect(
      (await pool.query("SELECT project_id,project_name FROM request_project_facts WHERE request_id='ra'")).rows[0],
    ).toEqual({ project_id: 'pa', project_name: 'Original' })
    await expect(
      pool.query("UPDATE request_records SET tenant_id='tb',organization_id='ob' WHERE id='ra'"),
    ).rejects.toThrow(/scope|immutable/)
    await expect(pool.query("UPDATE request_records SET project_id='pb' WHERE id='ra'")).rejects.toThrow(/immutable/)
    await pool.query(
      "UPDATE request_records SET status='completed',input_tokens=5,output_tokens=2,charge_amount=7 WHERE id='ra'",
    )
  })
  it('rejects conflicting request and side-table identities and freezes legacy captured values', async () => {
    await pool.query("INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pb2','tb','ob','Second')")
    await pool.query("UPDATE request_records SET project_id='pb' WHERE id='rb'")
    await expect(
      pool.query("UPDATE request_records SET tenant_id='ta',organization_id='oa' WHERE id='rb'"),
    ).rejects.toThrow(/scope|immutable/)
    await expect(insert('rb', 'tb', 'ob', 'pb2')).rejects.toThrow(/mismatch/)
    await expect(pool.query("UPDATE request_records SET project_id='pb2' WHERE id='rb'")).rejects.toThrow(/immutable/)
    await expect(
      pool.query(
        "INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,project_id) VALUES ('rx','ta','oa','alias','byok','pb')",
      ),
    ).rejects.toThrow(/tenant scope/)
  })
})
