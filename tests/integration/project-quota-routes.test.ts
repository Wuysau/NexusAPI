import { Pool } from 'pg'
import { beforeAll, afterAll, expect, it } from 'vitest'
import * as connectionQuota from '@/app/api/connections/[id]/quota/route'
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/lib/auth/csrf'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const csrf = issueCsrfToken()
const cookies: Record<string, string> = {}
const observedAt = new Date(Date.now() - 60_000).toISOString()
const staleAt = new Date(Date.now() + 3_600_000).toISOString()
function observation(observationId: string, extra: Record<string, unknown> = {}) {
  return {
    observationId,
    windowType: 'monthly',
    used: '70.000000000001',
    remaining: '29.999999999999',
    source: 'manual',
    sourceKind: 'reported',
    confidence: 'reported',
    scope: 'account',
    attributionMode: 'shared',
    observedAt,
    staleAt,
    resetAt: null,
    availability: 'available',
    ...extra,
  }
}
function request(role: string, method = 'GET', body?: unknown) {
  return new Request('http://localhost/api/quota', {
    method,
    headers: {
      cookie: `${cookies[role]}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (role: string, id: string, body: unknown) => connectionQuota.POST(request(role, 'POST', body), params(id))
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org','tenant','Org','quota21-org'),('foreign','foreign','Foreign','quota21-foreign');
    INSERT INTO users(id,email,name,password_hash) VALUES ('owner','quota21-owner@example.invalid','Owner','synthetic-hash'),('viewer','quota21-viewer@example.invalid','Viewer','synthetic-hash'),('developer','quota21-developer@example.invalid','Developer','synthetic-hash'),('billing','quota21-billing@example.invalid','Billing','synthetic-hash');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('org','tenant','owner','owner'),('org','tenant','viewer','viewer'),('org','tenant','developer','developer'),('org','tenant','billing','billing');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('a','tenant','org','A'),('b','tenant','org','B'),('foreign','foreign','foreign','Foreign');
    INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES ('tenant','a','viewer'),('tenant','a','developer');
    INSERT INTO owned_connections(id,tenant_id,owner_user_id,project_id,provider,mode,status) VALUES ('shared','tenant','owner','a','synthetic-provider','byok','active'),('private-b','tenant','owner','b','synthetic-provider','byok','active'),('foreign','foreign',NULL,'foreign','synthetic-provider','byok','active'),('missing-quota','tenant','owner','a','synthetic-provider','byok','active'),('revoked','tenant','owner','a','synthetic-provider','byok','revoked');
    UPDATE owned_connections SET revoked_at=now() WHERE id='revoked';
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,input_tokens,output_tokens,started_at) VALUES ('history','tenant','org','quota-history','byok','completed',10,5,'2026-01-01');
    INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,connection_id,execution_mode,attribution_status) VALUES ('history','tenant','org','a','Original A','shared','unknown','attributed')`)
  for (const role of ['owner', 'viewer', 'developer', 'billing'])
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
}, 30000)
afterAll(async () => {
  await pool.end()
})
it('usage-read viewer and billing roles cannot write quota observations', async () => {
  for (const role of ['viewer', 'billing'])
    expect((await post(role, 'shared', observation(`readonly-${role}`))).status).toBe(403)
})
it('write capability does not bypass current Project object scope or tenant isolation', async () => {
  for (const id of ['private-b', 'foreign', 'does-not-exist', 'revoked'])
    expect((await post('developer', id, observation(`denied-${id}`))).status).toBe(404)
})
it('rejects browser claims of trusted provenance and malformed exact values', async () => {
  for (const extra of [
    { sourceKind: 'official' },
    { sourceKind: 'derived' },
    { confidence: 'authoritative' },
    { attributionMode: 'exclusive' },
    { scope: 'project-estimated' },
    { used: 1.2 },
    { used: '-1' },
    { observedAt: '2026-02-30T00:00:00Z' },
  ])
    expect((await post('owner', 'shared', observation('forged-observation', extra))).status).toBe(400)
})
type QuotaRoute = (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
async function getConnection(role: string, id: string) {
  const route = (connectionQuota as unknown as { GET: QuotaRoute }).GET
  expect(route).toBeTypeOf('function')
  return route(request(role), params(id))
}
async function getProject(role: string, id: string) {
  const modulePath = '../../src/app/api/projects/[id]/quota/route'
  const route = (await import(modulePath)).GET as QuotaRoute
  return route(
    new Request('http://localhost/api/projects/quota?from=2020-01-01T00:00:00Z', {
      headers: { cookie: cookies[role] },
    }),
    params(id),
  )
}
it('a permitted developer can report quota but unbound ordinary access requires connection ownership', async () => {
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,provider,mode,status) VALUES ('developer-unbound','tenant','developer','synthetic-provider','byok','active'),('owner-unbound','tenant','owner','synthetic-provider','byok','active')`,
  )
  expect(
    (await post('developer', 'developer-unbound', observation('developer-allowed', { scope: 'connection' }))).status,
  ).toBe(201)
  expect((await getConnection('developer', 'developer-unbound')).status).toBe(200)
  expect((await getConnection('viewer', 'developer-unbound')).status).toBe(404)
  expect((await getConnection('developer', 'owner-unbound')).status).toBe(404)
  expect((await post('developer', 'owner-unbound', observation('unbound-denied'))).status).toBe(404)
})
it('owner reports exact manual observations and identical replay returns the original without a second row', async () => {
  const body = observation('owner-observation')
  const response = await post('owner', 'shared', body)
  expect(response.status).toBe(201)
  const first = await response.json()
  expect(first.quota).toMatchObject({
    used: body.used,
    remaining: body.remaining,
    source: 'manual',
    sourceKind: 'reported',
    scope: 'account',
    attributionMode: 'shared',
    freshness: 'fresh',
    observationId: body.observationId,
  })
  const replay = await post('owner', 'shared', body)
  expect(replay.status).toBe(200)
  expect((await replay.json()).quota.id).toBe(first.quota.id)
  expect((await post('owner', 'shared', { ...body, used: '71' })).status).toBe(409)
  expect((await pool.query("SELECT count(*) FROM quota_snapshots WHERE connection_id='shared'")).rows[0].count).toBe(
    '1',
  )
  const read = await getConnection('owner', 'shared')
  expect(read.status).toBe(200)
  expect((await read.json()).quotas).toEqual([
    expect.objectContaining({
      id: first.quota.id,
      used: body.used,
      remaining: body.remaining,
      freshness: 'fresh',
      observedAt,
      staleAt,
    }),
  ])
})
it('GET uses current object authorization and hides absent, revoked and foreign connections uniformly', async () => {
  const bodies: unknown[] = []
  for (const id of ['private-b', 'foreign', 'does-not-exist', 'revoked']) {
    const response = await getConnection('viewer', id)
    expect(response.status).toBe(404)
    bodies.push(await response.json())
  }
  for (const body of bodies) expect(body).toEqual(bodies[0])
  expect((await getConnection('viewer', 'shared')).status).toBe(200)
  for (const id of ['b', 'foreign', 'does-not-exist']) expect((await getProject('viewer', id)).status).toBe(404)
})
it('shared account quota remains separate from immutable Project API usage with no allocated percentage', async () => {
  const response = await getProject('owner', 'a')
  expect(response.status).toBe(200)
  const body = await response.json()
  const bound = body.connections.find((c: { id: string }) => c.id === 'shared')
  expect(bound.quotas).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'account', attributionMode: 'shared', used: '70.000000000001' }),
    ]),
  )
  for (const field of ['projectPercentage', 'projectUsedPercentage', 'allocatedPercentage', 'subscriptionPercentage']) {
    expect(body).not.toHaveProperty(field)
    expect(bound).not.toHaveProperty(field)
    for (const quota of bound.quotas) expect(quota).not.toHaveProperty(field)
  }
  expect(body.apiUsage.totals.requests).toBe('1')
  expect(body.apiUsage.totals.tokens.input.knownSum).toBe('10')
})
it('missing, legacy, stale and unavailable quota never becomes fresh zero', async () => {
  expect(await (await getConnection('owner', 'missing-quota')).json()).toMatchObject({
    quotas: [],
    freshness: 'unknown',
  })
  await pool.query(
    "INSERT INTO quota_snapshots(tenant_id,connection_id,window_type,used,remaining,source,confidence) VALUES ('tenant','missing-quota','legacy',70,30,'official','authoritative')",
  )
  const legacy = (await (await getConnection('owner', 'missing-quota')).json()).quotas[0]
  expect(legacy).toMatchObject({
    sourceKind: 'unknown',
    scope: 'unknown',
    attributionMode: 'unknown',
    freshness: 'unknown',
  })
  const stale = observation('stale-observation', {
    windowType: 'stale',
    observedAt: new Date(Date.now() - 7200000).toISOString(),
    staleAt: new Date(Date.now() - 3600000).toISOString(),
  })
  expect((await post('owner', 'shared', stale)).status).toBe(201)
  const unavailable = observation('unavailable-observation', {
    windowType: 'unavailable',
    used: null,
    remaining: null,
    availability: 'unavailable',
    sourceKind: 'unknown',
    confidence: 'unknown',
  })
  expect((await post('owner', 'shared', unavailable)).status).toBe(201)
  const quotas = (await (await getConnection('owner', 'shared')).json()).quotas
  expect(quotas.find((q: { windowType: string }) => q.windowType === 'stale')).toMatchObject({
    freshness: 'stale',
    used: stale.used,
  })
  expect(quotas.find((q: { windowType: string }) => q.windowType === 'unavailable')).toMatchObject({
    freshness: 'unavailable',
    used: null,
    remaining: null,
    availability: 'unavailable',
  })
})
it('rebinding changes current quota access without moving historical Project usage, then revocation removes it', async () => {
  await pool.query("UPDATE owned_connections SET project_id='b' WHERE id='shared'")
  const oldProject = await (await getProject('owner', 'a')).json()
  expect(oldProject.connections.some((c: { id: string }) => c.id === 'shared')).toBe(false)
  expect(oldProject.apiUsage.totals.requests).toBe('1')
  const newProject = await (await getProject('owner', 'b')).json()
  expect(newProject.connections.some((c: { id: string }) => c.id === 'shared')).toBe(true)
  expect(newProject.apiUsage.totals.requests).toBe('0')
  expect((await getConnection('viewer', 'shared')).status).toBe(404)
  expect((await post('developer', 'shared', observation('after-rebind'))).status).toBe(404)
  await pool.query("UPDATE owned_connections SET revoked_at=now(),status='revoked' WHERE id='shared'")
  expect((await getConnection('owner', 'shared')).status).toBe(404)
  expect((await post('owner', 'shared', observation('after-revoke'))).status).toBe(404)
  expect(
    (await (await getProject('owner', 'b')).json()).connections.some((c: { id: string }) => c.id === 'shared'),
  ).toBe(false)
})
it('quota activity never posts a money ledger transaction', async () => {
  expect((await pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count).toBe('0')
})
