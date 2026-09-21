import { Pool } from 'pg'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { resolveContext } from '@/app/api/_lib/control-plane'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const ctx = { tenantId: 't', organizationId: 'o1', session: { userId: 'u' } }
const privileged = { ...ctx, session: { userId: 'admin' } }
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO users(id,email,name,password_hash) VALUES ('u','access@example.invalid','User','fixture-hash'),('admin','admin@example.invalid','Admin','fixture-hash'),('corrupt','corrupt@example.invalid','Corrupt','fixture-hash');
    INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o1','t','One','access-one'),('foreign','foreign','Foreign','access-foreign');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('o1','t','u','viewer'),('o1','t','admin','owner'),('foreign','t','corrupt','owner');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('p1','t','o1','One'),('p2','t','o1','Two'),('p3','t','o1','Three'),('foreign','foreign','foreign','Foreign');
    INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES ('t','p1','u'),('t','foreign','u');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES ('historical','t','o1','model','byok');
    INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,attribution_status,execution_mode) VALUES ('historical','t','o1','p3','Original','attributed','unknown');
    DELETE FROM projects WHERE id='p3'`)
})
afterAll(async () => {
  await pool.end()
})
it('defaults to the session organization and requires explicit Project membership for viewers', async () => {
  expect(await resolveAnalyticsAccess(pool, ctx, {})).toEqual({
    tenantId: 't',
    organizations: [{ organizationId: 'o1', allProjects: false, projectIds: ['p1'] }],
    financialOrganizationId: null,
  })
})
it('tenant scope unions actual same-tenant memberships without trusting context roles', async () => {
  expect(await resolveAnalyticsAccess(pool, ctx, { scope: 'tenant' })).toEqual({
    tenantId: 't',
    organizations: [{ organizationId: 'o1', allProjects: false, projectIds: ['p1'] }],
    financialOrganizationId: null,
  })
  expect((await resolveAnalyticsAccess(pool, privileged, { scope: 'tenant' })).financialOrganizationId).toBeNull()
  expect(
    (await resolveAnalyticsAccess(pool, { ...ctx, session: { userId: 'corrupt' } }, { scope: 'tenant' })).organizations,
  ).toEqual([])
})
it('denies absent, unauthorized and foreign Project/organization filters identically', async () => {
  for (const query of [
    { projectId: 'p2' },
    { projectId: 'missing' },
    { projectId: 'foreign' },
    { projectId: '__unknown__' },
    { projectId: '__unattributed__' },
    { organizationId: 'foreign' },
    { organizationId: 'missing' },
  ])
    await expect(resolveAnalyticsAccess(pool, ctx, query)).rejects.toMatchObject({ status: 404, message: 'Not found' })
})
it('retains privileged deleted Project history and grants finance only for whole-organization reports', async () => {
  expect((await resolveAnalyticsAccess(pool, privileged, {})).financialOrganizationId).toBe('o1')
  for (const projectId of ['p3', '__unknown__', '__unattributed__']) {
    const access = await resolveAnalyticsAccess(pool, privileged, { projectId })
    expect(access.organizations[0].allProjects).toBe(true)
    expect(access.financialOrganizationId).toBeNull()
  }
})
it('rechecks all organization roles and active membership from the database', async () => {
  for (const role of ['owner', 'admin', 'billing', 'developer', 'viewer']) {
    await pool.query('UPDATE organization_memberships SET role=$1 WHERE user_id=$2 AND organization_id=$3', [
      role,
      'u',
      'o1',
    ])
    const access = await resolveAnalyticsAccess(pool, ctx, {})
    expect(access.organizations[0].allProjects).toBe(['owner', 'admin', 'billing'].includes(role))
    expect(access.financialOrganizationId).toBe(['owner', 'admin', 'billing'].includes(role) ? 'o1' : null)
  }
  await pool.query("UPDATE organizations SET status='suspended' WHERE id='o1'")
  await expect(resolveAnalyticsAccess(pool, ctx, {})).rejects.toMatchObject({ status: 404 })
  await pool.query("UPDATE organizations SET status='active' WHERE id='o1'")
})
it('session context rejects corrupt tenant membership and inactive organizations', async () => {
  const corrupt = await createSession({ userId: 'corrupt' })
  expect(
    await resolveContext(
      new Request('http://localhost/api/billing', { headers: { cookie: `${SESSION_COOKIE}=${corrupt.token}` } }),
    ),
  ).toBeNull()
  const valid = await createSession({ userId: 'u' })
  const request = new Request('http://localhost/api/billing', {
    headers: { cookie: `${SESSION_COOKIE}=${valid.token}` },
  })
  expect((await resolveContext(request))?.organizationId).toBe('o1')
  await pool.query("UPDATE organizations SET status='suspended' WHERE id='o1'")
  expect(await resolveContext(request)).toBeNull()
  await pool.query("UPDATE organizations SET status='active' WHERE id='o1'")
})
it('removing membership or deleting a Project removes ordinary member access', async () => {
  await pool.query("DELETE FROM projects WHERE id='p1'")
  expect((await resolveAnalyticsAccess(pool, ctx, {})).organizations[0].projectIds).toEqual([])
  await pool.query("DELETE FROM organization_memberships WHERE organization_id='o1'")
  await expect(resolveAnalyticsAccess(pool, ctx, {})).rejects.toMatchObject({ status: 404 })
})
