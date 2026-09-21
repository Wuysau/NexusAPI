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
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o','t','Org','attempt-o'),('other','other','Other','attempt-other');
  INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('provider','provider','Provider','https://example.invalid','bearer');
  INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret,is_platform_managed) VALUES ('cred','provider','t','o','Cred','fixture',false),('foreign','provider','other','other','Foreign','fixture',false),('managed','provider',NULL,NULL,'Managed','fixture',true);
  INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES ('channel','t','provider','cred','Channel'),('foreign','other','provider','foreign','Foreign'),('managed',NULL,'provider','managed','Managed');
  INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES ('connection','t','provider','byok'),('foreign','other','provider','byok');
  INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES ('request','t','o','alias','byok'),('managed','t','o','alias','platform'),('legacy','t','o','alias','byok');
  INSERT INTO request_project_facts(request_id,tenant_id,organization_id,execution_mode,attribution_status,catalog_version_id) VALUES ('request','t','o','byok','unattributed','catalog'),('managed','t','o','managed','unattributed','catalog')`)
})
afterAll(async () => {
  await pool.end()
})
async function insert(id: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id,
    request_id: 'request',
    tenant_id: 't',
    provider_id: 'provider',
    provider_credential_id: 'cred',
    channel_id: 'channel',
    attempt_number: 1,
    connection_id: 'connection',
    resolved_model: 'model',
    execution_mode: 'byok',
    price_version_id: 'price',
    catalog_version_id: 'catalog',
    policy_version_id: null,
    ...overrides,
  }
  const fields = Object.keys(row)
  return pool.query(
    `INSERT INTO attempts(${fields.join(',')}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  )
}
it('keeps legacy writers and reconciliation updates compatible', async () => {
  await pool.query(
    "INSERT INTO attempts(id,request_id,tenant_id,attempt_number) VALUES ('legacy-attempt','legacy','t',1)",
  )
  await pool.query("UPDATE attempts SET status='unknown',input_tokens=2 WHERE id='legacy-attempt'")
  expect((await pool.query("SELECT status FROM attempts WHERE id='legacy-attempt'")).rows[0].status).toBe('unknown')
})
it('rejects tenant, credential, channel, connection and request-version mismatch', async () => {
  for (const overrides of [
    { tenant_id: 'other' },
    { provider_credential_id: 'foreign' },
    { channel_id: 'foreign' },
    { connection_id: 'foreign' },
    { catalog_version_id: 'another' },
    { execution_mode: null },
    { request_id: 'legacy' },
  ])
    await expect(insert('rejected', overrides)).rejects.toThrow(/scope|capture|pin|mode/)
})
it('freezes every captured attempt identity and pin but permits outcome reconciliation', async () => {
  await insert('frozen')
  for (const column of [
    'id',
    'request_id',
    'tenant_id',
    'provider_id',
    'provider_credential_id',
    'channel_id',
    'connection_id',
    'resolved_model',
    'execution_mode',
    'price_version_id',
    'catalog_version_id',
    'policy_version_id',
  ])
    await expect(pool.query(`UPDATE attempts SET ${column}='tampered' WHERE id='frozen'`)).rejects.toThrow(/immutable/)
  await expect(pool.query("DELETE FROM attempts WHERE id='frozen'")).rejects.toThrow(/immutable/)
  await pool.query("UPDATE attempts SET status='unknown',input_tokens=3,error_code='reconciliation' WHERE id='frozen'")
  await pool.query(
    "UPDATE owned_connections SET tenant_id='other' WHERE id='connection'; UPDATE channels SET tenant_id='other' WHERE id='channel'",
  )
  await pool.query("DELETE FROM owned_connections WHERE id='connection'; DELETE FROM channels WHERE id='channel'")
  await pool.query("UPDATE attempts SET status='completed',input_tokens=4 WHERE id='frozen'")
  expect(
    (await pool.query("SELECT connection_id,channel_id,price_version_id FROM attempts WHERE id='frozen'")).rows[0],
  ).toEqual({ connection_id: 'connection', channel_id: 'channel', price_version_id: 'price' })
})
it('allows only managed attempts to use platform credentials and channels under the Gateway role', async () => {
  await pool.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))
  await insert('managed-attempt', {
    request_id: 'managed',
    execution_mode: 'managed',
    connection_id: null,
    provider_credential_id: 'managed',
    channel_id: 'managed',
  })
  await expect(
    insert('byok-platform', { connection_id: null, provider_credential_id: 'managed', channel_id: 'managed' }),
  ).rejects.toThrow(/scope|connection/)
  const gateway = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c role=nexus_gateway' })
  try {
    await gateway.query(
      "INSERT INTO attempts(id,request_id,tenant_id,provider_id,provider_credential_id,channel_id,attempt_number,resolved_model,execution_mode,price_version_id,catalog_version_id) VALUES ('gateway-attempt','managed','t','provider','managed','managed',2,'model','managed','price','catalog')",
    )
  } finally {
    await gateway.end()
  }
})
