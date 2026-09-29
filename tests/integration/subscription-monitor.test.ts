import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { collectorAccounts } from '@/lib/subscriptions/collector'
import { GET, POST } from '@/app/api/connections/[id]/monitor/route'

// This suite destroys only the explicitly selected disposable monitor database.
// Never load .env.local or fall back to the user's ordinary PostgreSQL port.
const database = new URL(process.env.DATABASE_URL ?? 'http://invalid')
if (
  !['postgresql:', 'postgres:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  !/(?:test|ci)/i.test(database.pathname)
)
  throw new Error('Monitor integration requires an explicit local disposable test/ci DATABASE_URL.')

const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const cookies: Record<string, string> = {}
let connectionId: string
const params = (id = connectionId) => ({ params: Promise.resolve({ id }) })
const request = (role = 'owner', body?: unknown) =>
  new Request('http://localhost/api/connections/monitor', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: `${cookies[role]}; nexus_csrf=monitor-fixture`, 'x-csrf-token': 'monitor-fixture' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
function importBody() {
  const now = new Date().toISOString()
  const snapshot = {
    schemaVersion: 1,
    generatedAt: now,
    staleAfterSeconds: 180,
    token: 'fixture-secret-never-persist',
    providers: [
      {
        id: 'claude',
        enabled: true,
        identity: { accountEmail: 'fixture@example.test', plan: 'Max' },
        windows: [
          {
            kind: 'session',
            label: 'fixture-secret-never-persist',
            usedPercent: 20,
            remainingPercent: 80,
            resetAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
        updatedAt: now,
        error: null,
        accessToken: 'fixture-secret-never-persist',
      },
    ],
  }
  return {
    action: 'import',
    providerId: 'claude',
    accountId: collectorAccounts(snapshot, 'claude')[0].accountId,
    snapshot,
  }
}
async function stored() {
  return (await pool.query('SELECT account_observation FROM owned_connections WHERE id=$1', [connectionId])).rows[0]
    .account_observation
}
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES
    ('monitor-org','monitor-tenant','Monitor','monitor-org'),('foreign-org','foreign-tenant','Foreign','foreign-org');
    INSERT INTO users(id,email,password_hash) VALUES
    ('monitor-owner','monitor-owner@example.test','fixture'),('monitor-developer','monitor-developer@example.test','fixture'),
    ('monitor-viewer','monitor-viewer@example.test','fixture'),('foreign-owner','foreign-owner@example.test','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES
    ('monitor-org','monitor-tenant','monitor-owner','owner'),('monitor-org','monitor-tenant','monitor-developer','developer'),
    ('monitor-org','monitor-tenant','monitor-viewer','viewer'),('foreign-org','foreign-tenant','foreign-owner','owner');`)
  for (const role of ['owner', 'developer', 'viewer', 'foreign'])
    cookies[role] =
      `${SESSION_COOKIE}=${(await createSession({ userId: role === 'foreign' ? 'foreign-owner' : `monitor-${role}` })).token}`
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('No HTTP calls allowed in monitor SQL tests')
  })
})
beforeEach(async () => {
  connectionId = randomUUID()
  await pool.query("UPDATE organization_memberships SET role='owner' WHERE user_id='monitor-owner'")
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,owner_user_id,provider,mode,capabilities)
    VALUES($1,'monitor-tenant','monitor-owner','anthropic','subscription_interactive',$2::jsonb)`,
    [
      connectionId,
      JSON.stringify({
        connection_type: 'subscription',
        execution_mode: 'interactive',
        routing: false,
        subscription_product: 'claude_code',
        provider_identifier: 'anthropic',
      }),
    ],
  )
})
afterAll(async () => {
  vi.restoreAllMocks()
  await pool.end()
})

it('executes real membership/connection locks and persists only sanitized monitoring fields', async () => {
  const body = importBody()
  const response = await POST(request('owner', body), params())
  expect(response.status).toBe(200)
  const observation = await stored()
  expect(observation).toEqual({
    schemaVersion: 1,
    source: 'codexbar',
    authority: 'collector_reported',
    scope: 'organization',
    organizationId: 'monitor-org',
    providerId: 'claude',
    accountId: body.accountId,
    binding: { providerId: 'claude', accountId: body.accountId },
    state: 'reported',
    observedAt: body.snapshot.generatedAt,
    receivedAt: expect.any(String),
    staleAfterSeconds: 180,
    windows: [
      {
        kind: 'session',
        label: 'session',
        usedPercent: 20,
        remainingPercent: 80,
        resetAt: body.snapshot.providers[0].windows[0].resetAt,
      },
    ],
  })
  expect(JSON.stringify(observation)).not.toMatch(/fixture-secret|fixture@example|accessToken|Max/)
  expect(
    (await pool.query('SELECT count(*)::int count FROM quota_snapshots WHERE connection_id=$1', [connectionId])).rows[0]
      .count,
  ).toBe(0)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int count FROM audit_events WHERE target_id=$1 AND action='connection.monitor_updated'",
        [connectionId],
      )
    ).rows[0].count,
  ).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})
it('re-reads persisted freshness without refreshing the collector', async () => {
  expect((await POST(request('owner', importBody()), params())).status).toBe(200)
  await pool.query(
    `UPDATE owned_connections SET account_observation=jsonb_set(account_observation,'{observedAt}',to_jsonb($2::text)) WHERE id=$1`,
    [connectionId, new Date(Date.now() - 600_000).toISOString()],
  )
  const response = await GET(request(), params())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await response.json()).observation.state).toBe('stale')
  expect(fetch).not.toHaveBeenCalled()
})
it('hides cross-tenant connections and observations belonging to another organization', async () => {
  expect((await GET(request('foreign'), params())).status).toBe(404)
  expect((await POST(request('foreign', importBody()), params())).status).toBe(404)
  expect((await POST(request('owner', importBody()), params())).status).toBe(200)
  await pool.query(
    `UPDATE owned_connections SET account_observation=jsonb_set(account_observation,'{organizationId}','"foreign-org"'::jsonb) WHERE id=$1`,
    [connectionId],
  )
  expect((await GET(request(), params())).status).toBe(404)
  expect((await POST(request('owner', importBody()), params())).status).toBe(404)
})
it('rejects revoked and native Codex connections without changing observations', async () => {
  await pool.query('UPDATE owned_connections SET revoked_at=now() WHERE id=$1', [connectionId])
  expect((await GET(request(), params())).status).toBe(404)
  expect((await POST(request('owner', importBody()), params())).status).toBe(404)
  await pool.query(
    `UPDATE owned_connections SET revoked_at=NULL,provider='openai',capabilities=jsonb_set(capabilities,'{subscription_product}','"openai_codex"'::jsonb) WHERE id=$1`,
    [connectionId],
  )
  expect((await POST(request('owner', importBody()), params())).status).toBe(400)
  expect(await stored()).toBeNull()
})
it('enforces real sessions, CSRF, project visibility and connection ownership', async () => {
  expect((await POST(request('viewer', importBody()), params())).status).toBe(403)
  expect((await POST(request('developer', importBody()), params())).status).toBe(404)
  const noCsrf = new Request('http://localhost/monitor', {
    method: 'POST',
    headers: { cookie: cookies.owner },
    body: JSON.stringify(importBody()),
  })
  expect((await POST(noCsrf, params())).status).toBe(403)
  await pool.query("UPDATE owned_connections SET owner_user_id='monitor-developer' WHERE id=$1", [connectionId])
  expect((await POST(request('developer', importBody()), params())).status).toBe(200)
  expect((await POST(request('developer', { action: 'refresh' }), params())).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})
it('revalidates a real membership downgrade between authorization and transaction commit', async () => {
  const body = Buffer.from(JSON.stringify(importBody()))
  // Backpressure keeps this callback idle until readCollectorJson, after initial authentication.
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await pool.query("UPDATE organization_memberships SET role='viewer' WHERE user_id='monitor-owner'")
        controller.enqueue(body)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const req = new Request('http://localhost/monitor', {
    method: 'POST',
    headers: { cookie: `${cookies.owner}; nexus_csrf=monitor-fixture`, 'x-csrf-token': 'monitor-fixture' },
    body: stream,
    duplex: 'half',
  } as RequestInit)
  const response = await POST(req, params())
  expect(response.status).toBe(403)
  expect((await response.json()).error.message).toContain('权限已变更')
  expect(await stored()).toBeNull()
})
it('requires live project membership even when a developer owns the connection', async () => {
  const projectId = randomUUID()
  await pool.query(
    "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,'monitor-tenant','monitor-org','Private monitor')",
    [projectId],
  )
  await pool.query("UPDATE owned_connections SET owner_user_id='monitor-developer',project_id=$2 WHERE id=$1", [
    connectionId,
    projectId,
  ])
  expect((await GET(request('developer'), params())).status).toBe(404)
  expect((await POST(request('developer', importBody()), params())).status).toBe(404)
  await pool.query(
    "INSERT INTO project_memberships(tenant_id,project_id,user_id,role) VALUES('monitor-tenant',$1,'monitor-developer','member')",
    [projectId],
  )
  expect((await POST(request('developer', importBody()), params())).status).toBe(200)
  await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id='monitor-developer'", [projectId])
  expect((await GET(request('developer'), params())).status).toBe(404)
})
