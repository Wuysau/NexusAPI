import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const helperPath = '../../src/lib/quota/access'
const ctx = (userId: string) => ({ tenantId: 't', organizationId: 'o', session: { userId } })
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o','t','Org','quota-org'),('foreign','foreign','Foreign','quota-foreign');
    INSERT INTO users(id,email,password_hash) VALUES ('owner','quota-owner@example.invalid','fixture'),('dev','quota-dev@example.invalid','fixture'),('viewer','quota-viewer@example.invalid','fixture'),('billing','quota-billing@example.invalid','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('o','t','owner','owner'),('o','t','dev','developer'),('o','t','viewer','viewer'),('o','t','billing','billing');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('p','t','o','Project'),('private','t','o','Private'),('foreign','foreign','foreign','Foreign');
    INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES ('t','p','dev'),('t','p','viewer');
    INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status) VALUES
      ('bound','t','owner','p','fixture','direct_api','active'),('private','t','owner','private','fixture','direct_api','active'),
      ('unbound','t','dev',NULL,'fixture','direct_api','active'),('bad-project','t','owner','foreign','fixture','direct_api','active'),('foreign','foreign','owner','foreign','fixture','direct_api','active');
    INSERT INTO quota_snapshots(tenant_id,connection_id,window_type,source) VALUES ('t','bound','legacy','fixture'),('t','bound','legacy','fixture')`)
})
afterAll(async () => {
  await pool.end()
})
it('expands provenance without manufacturing stronger trust for legacy rows', async () => {
  const result = await pool.query(
    'SELECT observation_id,scope,source_kind,attribution_mode,availability,provenance_version FROM quota_snapshots',
  )
  expect(result.rows).toHaveLength(2)
  expect(result.rows[0]).toEqual({
    observation_id: null,
    scope: 'unknown',
    source_kind: 'unknown',
    attribution_mode: 'unknown',
    availability: 'unknown',
    provenance_version: null,
  })
  await pool.query(
    "INSERT INTO quota_snapshots(tenant_id,connection_id,window_type,source,observation_id) VALUES ('t','bound','daily','manual','observation')",
  )
  await expect(
    pool.query(
      "INSERT INTO quota_snapshots(tenant_id,connection_id,window_type,source,observation_id) VALUES ('t','bound','daily','manual','observation')",
    ),
  ).rejects.toMatchObject({ code: '23505' })
  await pool.query(
    "INSERT INTO quota_snapshots(tenant_id,connection_id,window_type,source,observation_id) VALUES ('t','unbound','daily','manual','observation')",
  )
})
it('requires object access after checking fresh organization read/write roles', async () => {
  const { resolveQuotaConnection } = await import(helperPath)
  for (const user of ['owner', 'dev', 'viewer', 'billing'])
    expect((await resolveQuotaConnection(pool, ctx(user), 'bound')).id).toBe('bound')
  for (const user of ['owner', 'dev'])
    expect((await resolveQuotaConnection(pool, ctx(user), 'bound', { write: true })).id).toBe('bound')
  for (const user of ['viewer', 'billing'])
    await expect(resolveQuotaConnection(pool, ctx(user), 'bound', { write: true })).rejects.toMatchObject({
      status: 404,
    })
  for (const user of ['dev', 'viewer'])
    await expect(resolveQuotaConnection(pool, ctx(user), 'private')).rejects.toMatchObject({ status: 404 })
  for (const user of ['owner', 'billing', 'dev'])
    expect((await resolveQuotaConnection(pool, ctx(user), 'unbound')).id).toBe('unbound')
  await expect(resolveQuotaConnection(pool, ctx('viewer'), 'unbound')).rejects.toMatchObject({ status: 404 })
})
it('returns uniform not-found for cross-scope, revoked and unauthorized objects', async () => {
  const { resolveQuotaConnection, resolveQuotaProject } = await import(helperPath)
  for (const id of ['missing', 'foreign', 'bad-project'])
    await expect(resolveQuotaConnection(pool, ctx('owner'), id)).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    })
  for (const status of ['revoked', 'expired', 'blocked']) {
    await pool.query('UPDATE owned_connections SET status=$1 WHERE id=$2', [status, 'bound'])
    await expect(resolveQuotaConnection(pool, ctx('owner'), 'bound')).rejects.toMatchObject({ status: 404 })
  }
  await pool.query("UPDATE owned_connections SET status='active' WHERE id='bound'")
  expect((await resolveQuotaProject(pool, ctx('dev'), 'p')).id).toBe('p')
  for (const id of ['private', 'foreign', 'missing'])
    await expect(resolveQuotaProject(pool, ctx('dev'), id)).rejects.toMatchObject({ status: 404 })
  await pool.query("UPDATE organizations SET status='suspended' WHERE id='o'")
  await expect(resolveQuotaConnection(pool, ctx('owner'), 'bound')).rejects.toMatchObject({ status: 404 })
  await pool.query("UPDATE organizations SET status='active' WHERE id='o'")
})
it('locks the connection so revocation cannot race an authorized observation', async () => {
  const { resolveQuotaConnection } = await import(helperPath)
  const client = await pool.connect(),
    revoker = await pool.connect()
  try {
    await client.query('BEGIN')
    await resolveQuotaConnection(client, ctx('dev'), 'bound', { write: true, lock: true })
    await revoker.query("SET lock_timeout='100ms'")
    await expect(revoker.query("UPDATE owned_connections SET revoked_at=now() WHERE id='bound'")).rejects.toThrow(
      /lock timeout/,
    )
    await client.query('COMMIT')
    await revoker.query("UPDATE owned_connections SET revoked_at=now() WHERE id='bound'")
    await expect(resolveQuotaConnection(pool, ctx('dev'), 'bound')).rejects.toMatchObject({ status: 404 })
  } finally {
    await client.query('ROLLBACK')
    await revoker.query('RESET lock_timeout')
    client.release()
    revoker.release()
  }
})

it('rechecks Project rebinding, archive state and membership removal', async () => {
  const { resolveQuotaConnection, resolveQuotaProject } = await import(helperPath)
  await pool.query("UPDATE owned_connections SET revoked_at=NULL,project_id='private' WHERE id='bound'")
  await expect(resolveQuotaConnection(pool, ctx('dev'), 'bound')).rejects.toMatchObject({ status: 404 })
  expect((await resolveQuotaConnection(pool, ctx('owner'), 'bound')).project_id).toBe('private')
  await pool.query(
    "UPDATE owned_connections SET project_id='p' WHERE id='bound'; UPDATE projects SET archived_at=now() WHERE id='p'",
  )
  await expect(resolveQuotaProject(pool, ctx('owner'), 'p')).rejects.toMatchObject({ status: 404 })
  await expect(resolveQuotaConnection(pool, ctx('owner'), 'bound')).rejects.toMatchObject({ status: 404 })
  await pool.query(
    "UPDATE projects SET archived_at=NULL WHERE id='p'; DELETE FROM project_memberships WHERE project_id='p' AND user_id='dev'",
  )
  await expect(resolveQuotaConnection(pool, ctx('dev'), 'bound')).rejects.toMatchObject({ status: 404 })
  await pool.query(
    "UPDATE organization_memberships SET tenant_id='foreign' WHERE organization_id='o' AND user_id='owner'",
  )
  await expect(resolveQuotaConnection(pool, ctx('owner'), 'bound')).rejects.toMatchObject({ status: 404 })
})
