import { Pool } from 'pg'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { GET as projects, POST as createProject } from '@/app/api/projects/route'
import { PATCH as updateProject } from '@/app/api/projects/[id]/route'
import { GET as connections, POST as createConnection } from '@/app/api/connections/route'
import { DELETE as revokeConnection } from '@/app/api/connections/[id]/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scanCodex } from '@/lib/observer/importer'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const cookies: Record<string, string> = {}
const req = (role = 'owner', method = 'GET', body?: unknown) =>
  new Request('http://localhost/api/workspace', {
    method,
    headers: {
      cookie: cookies[role] + '; nexus_csrf=workspace-test',
      'x-csrf-token': 'workspace-test',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
let projectId: string
let connectionId: string
beforeAll(async () => {
  await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(db)
  await db.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org','tenant','Org','workspace-org'),('other','other','Other','workspace-other'),('foreign','foreign','Foreign','workspace-foreign');
    INSERT INTO users(id,email,password_hash) VALUES ('owner','workspace-owner@example.invalid','fixture'),('developer','workspace-dev@example.invalid','fixture'),('viewer','workspace-viewer@example.invalid','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('org','tenant','owner','owner'),('org','tenant','developer','developer'),('org','tenant','viewer','viewer');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('private','tenant','org','Private'),('other','other','other','Hidden org'),('foreign','foreign','foreign','Hidden tenant');`)
  for (const role of ['owner', 'developer', 'viewer'])
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
})
afterAll(async () => {
  await db.end()
})
it('creates a project with normalized roots, creator membership and reloadable data', async () => {
  const res = await createProject(
    req('owner', 'POST', { name: 'Real project', workspaceRoots: ['D:\\Projects\\Demo\\'] }),
  )
  expect(res.status).toBe(201)
  projectId = (await res.json()).project.id
  const body = await (await projects(req())).json()
  expect(body.projects.find((p: { id: string }) => p.id === projectId)).toMatchObject({
    name: 'Real project',
    memberCount: 1,
    workspaceRoots: ['d:/projects/demo'],
    observedEvents: '0',
    observedSessions: '0',
  })
})
it('limits project lists and mutations to the current organization and membership', async () => {
  expect((await (await projects(req())).json()).projects.map((p: { id: string }) => p.id)).not.toContain('other')
  expect((await (await projects(req('developer'))).json()).projects).toEqual([])
  for (const id of ['private', 'other', 'foreign', 'missing'])
    expect((await updateProject(req('developer', 'PATCH', { name: 'Leak' }), params(id))).status).toBe(404)
})
it('rejects malformed roots and rolls back conflicting project creation', async () => {
  for (const roots of [['relative/path'], 'bad', [12]])
    expect((await createProject(req('owner', 'POST', { name: 'Invalid', workspaceRoots: roots }))).status).toBe(400)
  expect(
    (await createProject(req('owner', 'POST', { name: 'Conflict', workspaceRoots: ['D:/Projects/Demo'] }))).status,
  ).toBe(409)
  expect((await db.query("SELECT id FROM projects WHERE name IN ('Conflict','Invalid')")).rowCount).toBe(0)
})
it('creates a credential-free pending subscription mapping and rejects fabricated capabilities', async () => {
  const res = await createConnection(
    req('owner', 'POST', {
      provider: 'openai',
      mode: 'subscription_interactive',
      providerIdentifier: 'openai',
      projectId,
    }),
  )
  expect(res.status).toBe(201)
  connectionId = (await res.json()).connection.id
  const row = (await db.query('SELECT * FROM owned_connections WHERE id=$1', [connectionId])).rows[0]
  expect(row).toMatchObject({
    status: 'pending',
    credential_ref: null,
    credential_fingerprint: null,
    capabilities: {
      routing: false,
      connection_type: 'subscription',
      execution_mode: 'interactive',
      subscription_product: 'openai_codex',
    },
  })
  for (const body of [
    { capabilities: { routing: true } },
    { credentialFingerprint: 'fake' },
    { providerIdentifier: 'bad\nidentifier' },
    { token: 'not-accepted' },
  ])
    expect(
      (await createConnection(req('owner', 'POST', { provider: 'openai', mode: 'subscription_interactive', ...body })))
        .status,
    ).toBe(400)
})
it('does not permit cross-tenant/org or unauthorized project connection bindings', async () => {
  for (const id of ['other', 'foreign', 'missing'])
    expect(
      (await createConnection(req('owner', 'POST', { provider: 'openai', mode: 'direct_api', projectId: id }))).status,
    ).toBe(404)
  expect(
    (await createConnection(req('developer', 'POST', { provider: 'openai', mode: 'direct_api', projectId }))).status,
  ).toBe(404)
  expect((await revokeConnection(req('developer', 'DELETE'), params(connectionId))).status).toBe(404)
})
it('denies read-only mutations and missing CSRF', async () => {
  expect((await createProject(req('viewer', 'POST', { name: 'Denied' }))).status).toBe(403)
  expect((await createConnection(req('viewer', 'POST', { provider: 'openai' }))).status).toBe(403)
  expect(
    (
      await createConnection(
        new Request('http://localhost/api/connections', {
          method: 'POST',
          headers: { cookie: cookies.owner },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(403)
})
it('reports observed evidence independently of binding and never leaks hidden project events', async () => {
  await db.query(
    `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,occurred_at,connection_id,project_id,project_name,matched_root,attributed_at,parser_version)
    VALUES ('tenant','org','codex_local','client_observed','session','event',now(),$1,$2,'Real project','d:/projects/demo',now(),'codex-rollout-v1'),
    ('tenant','org','codex_local','client_observed','hidden-session','hidden-event',now(),$1,'private','Private','/private',now(),'codex-rollout-v1')`,
    [connectionId, projectId],
  )
  expect(
    (await (await connections(req())).json()).connections.find((c: { id: string }) => c.id === connectionId),
  ).toMatchObject({ observedEvents: '2', observedSessions: '2', project_name: 'Real project' })
  await db.query(
    "INSERT INTO project_memberships(tenant_id,project_id,user_id,role) VALUES('tenant',$1,'viewer','viewer')",
    [projectId],
  )
  const visible = (await (await connections(req('viewer'))).json()).connections
  expect(visible).toHaveLength(1)
  expect(visible[0]).toMatchObject({ observedEvents: '1', observedSessions: '1' })
  expect((await (await projects(req())).json()).projects.find((p: { id: string }) => p.id === projectId)).toMatchObject(
    { observedEvents: '1', observedSessions: '1', connectionCount: 1 },
  )
})
it('validates project edits, detects stale versions and atomically replaces roots', async () => {
  await db.query(
    "INSERT INTO project_workspace_roots(tenant_id,organization_id,project_id,root) VALUES('tenant','org','private','/taken')",
  )
  expect(
    (
      await updateProject(
        req('owner', 'PATCH', { name: 'Must roll back', workspaceRoots: ['/temporary', '/taken'], expectedVersion: 1 }),
        params(projectId),
      )
    ).status,
  ).toBe(409)
  expect((await (await projects(req())).json()).projects.find((p: { id: string }) => p.id === projectId)).toMatchObject(
    { name: 'Real project', workspaceRoots: ['d:/projects/demo'], policyVersion: 1 },
  )
  for (const body of [
    { name: '' },
    { name: 'x'.repeat(121) },
    { expectedVersion: 'bad', name: 'Bad' },
    { expectedVersion: 2147483648, name: 'Bad' },
  ])
    expect((await updateProject(req('owner', 'PATCH', body), params(projectId))).status).toBe(400)
  expect(
    (
      await updateProject(
        req('owner', 'PATCH', { name: 'Renamed', workspaceRoots: ['/new-root'], expectedVersion: 1 }),
        params(projectId),
      )
    ).status,
  ).toBe(200)
  expect(
    (await updateProject(req('owner', 'PATCH', { name: 'Stale', expectedVersion: 1 }), params(projectId))).status,
  ).toBe(409)
  const row = (await (await projects(req())).json()).projects.find((p: { id: string }) => p.id === projectId)
  expect(row).toMatchObject({ name: 'Renamed', workspaceRoots: ['/new-root'], policyVersion: 2 })
})
it('revokes a mapping without deleting historical evidence and archives projects explicitly', async () => {
  expect((await revokeConnection(req('owner', 'DELETE'), params(connectionId))).status).toBe(200)
  expect(
    (await (await connections(req())).json()).connections.find((c: { id: string }) => c.id === connectionId),
  ).toMatchObject({ status: 'revoked', observedEvents: '2' })
  expect(
    (await updateProject(req('owner', 'PATCH', { archived: true, expectedVersion: 2 }), params(projectId))).status,
  ).toBe(200)
  expect((await (await projects(req())).json()).projects.map((p: { id: string }) => p.id)).not.toContain(projectId)
  expect((await db.query('SELECT count(*) FROM external_observed_usage')).rows[0].count).toBe('2')
  expect(
    (await createProject(req('owner', 'POST', { name: 'Reuse archived directory', workspaceRoots: ['/new-root'] })))
      .status,
  ).toBe(201)
})

it('an API-created pending mapping can associate real parsed telemetry without fabricating activity on creation', async () => {
  const response = await createConnection(
    req('owner', 'POST', { provider: 'openai', mode: 'subscription_interactive' }),
  )
  expect(response.status).toBe(201)
  const id = (await response.json()).connection.id
  const dir = await mkdtemp(path.join(tmpdir(), 'workspace-observer-'))
  try {
    const file = path.join(dir, 'rollout.jsonl')
    await writeFile(
      file,
      [
        { type: 'session_meta', payload: { id: 'new-ui-session', cwd: '/no-project', model_provider: 'openai' } },
        {
          type: 'event_msg',
          timestamp: '2026-09-18T08:00:00Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    )
    const config = {
      tenantId: 'tenant',
      organizationId: 'org',
      sources: [file],
      roots: [],
      providers: [{ identifier: 'openai', provider: 'openai', product: 'openai_codex', connectionId: id }],
    }
    expect((await scanCodex(db, config, { dryRun: true })).newEvents).toBe(1)
    expect((await db.query('SELECT id FROM external_observed_usage WHERE connection_id=$1', [id])).rowCount).toBe(0)
    expect((await scanCodex(db, config)).newEvents).toBe(1)
    expect((await scanCodex(db, config)).newEvents).toBe(0)
    const row = (await (await connections(req())).json()).connections.find((c: { id: string }) => c.id === id)
    expect(row).toMatchObject({ status: 'pending', observedEvents: '1', observedSessions: '1' })
    expect((await db.query('SELECT id FROM usage_records')).rowCount).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
