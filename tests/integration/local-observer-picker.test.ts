import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
const picker = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observer/local-picker', async () => {
  const actual = await vi.importActual<typeof import('@/lib/observer/local-picker')>('@/lib/observer/local-picker')
  return {
    ...actual,
    pickObserverPath: picker,
    desktopPickerHostAllowed: (req: Request) => actual.desktopPickerHostAllowed(req, process.env, 'win32'),
    desktopPickerRequestAllowed: (req: Request) => actual.desktopPickerRequestAllowed(req, process.env, 'win32'),
  }
})
import { GET, POST } from '@/app/api/local/observer-path/route'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const cookies: Record<string, string> = {}
const origin = 'http://127.0.0.1:3340'
function request(
  role = 'owner',
  body: unknown = { kind: 'file' },
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return new Request(origin + '/api/local/observer-path', {
    method,
    headers: {
      host: '127.0.0.1:3340',
      origin,
      cookie: (cookies[role] ?? '') + '; nexus_csrf=picker-fixture',
      'x-csrf-token': 'picker-fixture',
      'content-type': 'application/json',
      ...headers,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}
beforeAll(async () => {
  await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(db)
  await db.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org','tenant','Picker','picker-org');
    INSERT INTO users(id,email,password_hash) VALUES('owner','picker-owner@example.invalid','fixture'),('developer','picker-dev@example.invalid','fixture'),('viewer','picker-viewer@example.invalid','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES('org','tenant','owner','owner'),('org','tenant','developer','developer'),('org','tenant','viewer','viewer');`)
  for (const role of ['owner', 'developer', 'viewer'])
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
})
beforeEach(() => {
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', origin)
  picker.mockReset()
  picker.mockResolvedValue('D:\\Private fixture\\rollout.jsonl')
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await db.end()
})
it('reports authenticated capability, disabled mode and read-only role without launching a dialog', async () => {
  expect(await (await GET(request('owner', undefined, {}, 'GET'))).json()).toMatchObject({ available: true })
  expect(await (await GET(request('viewer', undefined, {}, 'GET'))).json()).toMatchObject({ available: false })
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', '')
  expect(await (await GET(request('owner', undefined, {}, 'GET'))).json()).toMatchObject({ available: false })
  expect(picker).not.toHaveBeenCalled()
})
it('rejects anonymous/nonadmin roles and CSRF before opening a native window', async () => {
  expect((await POST(request('anonymous'))).status).toBe(401)
  for (const role of ['developer', 'viewer']) expect((await POST(request(role))).status).toBe(403)
  expect((await POST(request('owner', { kind: 'file' }, { 'x-csrf-token': '' }))).status).toBe(403)
  expect(picker).not.toHaveBeenCalled()
})
it('rejects remote/missing origins, wrong hosts, disabled bridge and malformed body', async () => {
  for (const headers of [
    { origin: 'https://evil.test', host: '127.0.0.1:3340' },
    { origin: '', host: '127.0.0.1:3340' },
    { host: 'evil.test', origin },
  ])
    expect((await POST(request('owner', { kind: 'file' }, headers))).status).toBe(403)
  for (const body of [{ kind: 'command' }, { kind: 'file', path: 'C:/private' }, null, { kind: ['file'] }])
    expect((await POST(request('owner', body))).status).toBe(400)
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', '')
  expect((await POST(request())).status).toBe(403)
  expect(picker).not.toHaveBeenCalled()
})
it('returns only a selected path without caching, and audits outcome without path/content', async () => {
  const req = request()
  const response = await POST(req)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({ path: 'D:\\Private fixture\\rollout.jsonl' })
  expect(picker).toHaveBeenCalledWith('file', req.signal)
  const audits = await db.query(
    "SELECT metadata FROM audit_events WHERE tenant_id='tenant' AND action='observer.path_selected'",
  )
  expect(audits.rows).toHaveLength(1)
  expect(JSON.stringify(audits.rows)).not.toContain('Private fixture')
})
it('preserves cancellation as null and never persists a selection', async () => {
  picker.mockResolvedValue(null)
  expect(await (await POST(request('owner', { kind: 'directory' }))).json()).toEqual({ path: null })
  expect((await db.query('SELECT id FROM external_observed_usage')).rowCount).toBe(0)
  expect((await db.query('SELECT root FROM project_workspace_roots')).rowCount).toBe(0)
})
