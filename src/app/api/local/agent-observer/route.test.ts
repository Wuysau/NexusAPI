import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { AuthzError } from '@/lib/auth/capabilities'
import { CsrfError } from '@/lib/auth/csrf'

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  requireContext: vi.fn(),
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
  discover: vi.fn(),
  exists: vi.fn(),
  host: vi.fn(),
  requestAllowed: vi.fn(),
  runtime: vi.fn(),
  sync: vi.fn(),
  audit: vi.fn(),
  context: {
    tenantId: 'tenant-a',
    organizationId: 'org-a',
    session: { userId: 'user-a' },
    membership: { role: 'owner' },
  },
  settings: {
    instanceId: 'local-instance',
    enabled: true,
    intervalSeconds: 60,
    configPath: 'C:/server-owned/config.json',
  },
}))
vi.mock('@/db', () => ({
  pool: { query: mock.query, connect: async () => ({ query: mock.query, release: mock.release }) },
}))
vi.mock('@/lib/observer/configuration', () => ({
  observerSettings: () => mock.settings,
  readActiveObserverConfig: mock.readConfig,
  saveActiveObserverConfig: mock.saveConfig,
}))
vi.mock('@/lib/observer/local-picker', () => ({
  desktopPickerHostAllowed: mock.host,
  desktopPickerRequestAllowed: mock.requestAllowed,
}))
vi.mock('@/lib/observer/agent-sources', async (original) => ({
  ...(await original<typeof import('@/lib/observer/agent-sources')>()),
  discoverAgentSources: mock.discover,
  sourceExists: mock.exists,
}))
vi.mock('@/lib/observer/service', () => ({ readObserverRuntime: mock.runtime, requestObserverSync: mock.sync }))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext: mock.requireContext,
  auditControlPlane: mock.audit,
  jsonOk: (value: unknown, status = 200) => Response.json(value, { status }),
  apiError: (status: number, code: string) => Response.json({ error: { code } }, { status }),
  routeError: (error: { status?: number; code?: string }) =>
    Response.json({ error: { code: error.code } }, { status: error.status ?? 500 }),
  readJsonBody: (req: Request) => req.json().catch(() => null),
}))
import { GET, POST } from './route'

const source = { tool: 'gemini_cli', format: 'native', path: path.resolve('records/gemini') }
const config = () => ({
  tenantId: 'tenant-a',
  organizationId: 'org-a',
  sources: ['C:/records/codex'],
  claudeSources: ['C:/records/claude'],
  providers: [{ identifier: 'preserved' }],
  roots: [{ root: 'C:/project', projectId: 'p' }],
  agentSources: [source],
  autoDiscover: true,
})
const request = (body?: unknown) =>
  new Request(
    'http://localhost/api/local/agent-observer',
    body === undefined
      ? undefined
      : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  )
beforeEach(() => {
  vi.clearAllMocks()
  mock.context.membership.role = 'owner'
  mock.requireContext.mockReset().mockResolvedValue(mock.context)
  mock.readConfig.mockReset().mockResolvedValue(config())
  mock.saveConfig.mockReset().mockResolvedValue(undefined)
  mock.discover.mockReset().mockResolvedValue([])
  mock.exists.mockReset().mockResolvedValue(false)
  mock.host.mockReturnValue(true)
  mock.requestAllowed.mockReturnValue(true)
  mock.runtime.mockReset().mockResolvedValue(null)
  mock.sync.mockReset().mockResolvedValue('queued')
  mock.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: [],
    rowCount: sql.includes('organization_memberships') ? 1 : 0,
  }))
})

describe('local Agent observer access', () => {
  it('rejects non-admins before reading paths or discovering sources', async () => {
    mock.context.membership.role = 'developer'
    expect((await GET(request())).status).toBe(403)
    expect((await POST(request({ action: 'discovery', enabled: true }))).status).toBe(403)
    expect(mock.readConfig).not.toHaveBeenCalled()
    expect(mock.discover).not.toHaveBeenCalled()
    expect(mock.query).not.toHaveBeenCalled()
  })
  it('enforces desktop host and mutation origin before local I/O', async () => {
    mock.host.mockReturnValue(false)
    mock.requestAllowed.mockReturnValue(false)
    const response = await GET(request())
    expect(await response.json()).toMatchObject({ available: false })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await POST(request({ action: 'sync' }))).status).toBe(403)
    expect(mock.readConfig).not.toHaveBeenCalled()
    expect(mock.query).not.toHaveBeenCalled()
  })
  it('delegates auth/CSRF to requireContext before any mutation side effects', async () => {
    mock.requireContext.mockRejectedValue(new CsrfError())
    expect((await POST(request({ action: 'sync' }))).status).toBe(403)
    expect(mock.requireContext).toHaveBeenCalledWith(expect.any(Request), 'credential:create')
    expect(mock.requestAllowed).not.toHaveBeenCalled()
    expect(mock.readConfig).not.toHaveBeenCalled()
    expect(mock.query).not.toHaveBeenCalled()
  })
  it('does not expose paths or read runtime/counts for another workspace configuration', async () => {
    mock.readConfig.mockResolvedValue({ ...config(), organizationId: 'other', sources: ['C:/PRIVATE_PATH'] })
    const response = await GET(request())
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('PRIVATE_PATH')
    expect(mock.discover).not.toHaveBeenCalled()
    expect(mock.query).not.toHaveBeenCalled()
    expect(mock.runtime).not.toHaveBeenCalled()
  })
  it('returns registry, unknown custom tools, missing paths and tenant-scoped historical counts', async () => {
    mock.query.mockResolvedValue({
      rows: [{ source: 'agent:custom_tool', events: '7', sessions: '2', lastObserved: '2026-09-29T00:00:00Z' }],
      rowCount: 1,
    })
    const response = await GET(request()),
      data = await response.json()
    expect(data.tools.length).toBeGreaterThanOrEqual(21)
    expect(data.tools.find((tool: { id: string }) => tool.id === 'custom_tool')).toMatchObject({
      events: '7',
      sessions: '2',
    })
    expect(data.sources.find((entry: { tool: string }) => entry.tool === 'gemini_cli')).toMatchObject({
      exists: false,
      removable: true,
    })
    expect(data.sources.find((entry: { tool: string }) => entry.tool === 'codex')).toMatchObject({ removable: false })
    expect(data.runtime).toBeNull()
    expect(mock.query.mock.calls[0][0]).toContain('tenant_id=$1 AND organization_id=$2')
    expect(mock.query.mock.calls[0][1]).toEqual(['tenant-a', 'org-a'])
    expect(mock.requireContext).toHaveBeenCalledWith(expect.any(Request), 'credential:read')
  })
})

describe('Agent observer tool aggregation and safe failures', () => {
  it('combines legacy and generic tool counters exactly and takes the newest observation', async () => {
    mock.query.mockResolvedValue({
      rows: [
        {
          source: 'codex_local',
          events: '9007199254740993',
          sessions: '9007199254740992',
          lastObserved: '2026-09-29T01:00:00Z',
        },
        { source: 'agent:codex', events: '2', sessions: '3', lastObserved: '2026-09-29T02:00:00Z' },
        { source: 'agent:claude_code', events: '7', sessions: '2', lastObserved: null },
        { source: 'claude_code_local', events: '5', sessions: '4', lastObserved: '2026-09-29T03:00:00Z' },
      ],
      rowCount: 4,
    })
    const data = await (await GET(request())).json()
    expect(data.tools.find((tool: { id: string }) => tool.id === 'codex')).toMatchObject({
      events: '9007199254740995',
      sessions: '9007199254740995',
      lastObserved: '2026-09-29T02:00:00.000Z',
    })
    expect(data.tools.find((tool: { id: string }) => tool.id === 'claude_code')).toMatchObject({
      events: '12',
      sessions: '6',
      lastObserved: '2026-09-29T03:00:00.000Z',
    })
  })
  it('preserves safe error categories while stripping raw error strings and invalid tool IDs', async () => {
    mock.runtime.mockResolvedValue({
      state: 'idle',
      last_result: {
        sourceErrors: [
          { tool: 'gemini_cli', code: 'source_unavailable' },
          { tool: 'qwen_code', code: 'capture_failed' },
          { tool: 'opencode', code: 'PRIVATE_PATH malformed record' },
          { tool: 'PRIVATE PATH', code: 'capture_failed' },
        ],
      },
    })
    const data = await (await GET(request())).json()
    expect(data.runtime.sourceErrors).toEqual([
      { tool: 'gemini_cli', code: 'source_unavailable' },
      { tool: 'qwen_code', code: 'capture_failed' },
      { tool: 'opencode', code: 'capture_failed' },
    ])
    expect(JSON.stringify(data.runtime)).not.toContain('PRIVATE')
  })
})

describe('local Agent observer mutations', () => {
  it('serializes configuration writes and rechecks scoped admin membership under the same lock', async () => {
    const response = await POST(request({ action: 'discovery', enabled: false }))
    expect(response.status).toBe(200)
    expect(mock.query.mock.calls[1]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['observer-config:local-instance'],
    ])
    expect(mock.query.mock.calls[2][0]).toContain('FOR SHARE')
    expect(mock.query.mock.calls[2][1]).toEqual(['tenant-a', 'org-a', 'user-a'])
    expect(mock.saveConfig).toHaveBeenCalledWith(mock.settings, { ...config(), autoDiscover: false })
    expect(mock.query.mock.calls.map(([sql]) => sql)).toContain('COMMIT')
    expect(JSON.stringify(mock.audit.mock.calls)).not.toContain('C:/records')
    expect(mock.release).toHaveBeenCalledOnce()
  })
  it('refuses writes when membership was revoked while waiting for the config lock', async () => {
    mock.query.mockResolvedValue({ rows: [], rowCount: 0 })
    expect((await POST(request({ action: 'discovery', enabled: true }))).status).toBe(403)
    expect(mock.readConfig).not.toHaveBeenCalled()
    expect(mock.saveConfig).not.toHaveBeenCalled()
    expect(mock.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK')
    expect(mock.release).toHaveBeenCalledOnce()
  })
  it('refuses scoped mutation and sync for another workspace', async () => {
    mock.readConfig.mockResolvedValue({ ...config(), tenantId: 'other' })
    expect((await POST(request({ action: 'sync' }))).status).toBe(409)
    expect(mock.sync).not.toHaveBeenCalled()
    expect(mock.saveConfig).not.toHaveBeenCalled()
  })
  it('preserves existing mappings while adding/updating/removing only manual agent sources', async () => {
    const added = {
      tool: 'custom_tool',
      format: 'telemetry',
      path: path.resolve('metadata/custom.jsonl'),
      workspace: path.resolve('project'),
    }
    expect((await POST(request({ action: 'addSource', source: added }))).status).toBe(200)
    expect(mock.saveConfig.mock.calls[0][1]).toEqual({ ...config(), agentSources: [source, added] })
    mock.readConfig.mockResolvedValue(config())
    expect((await POST(request({ action: 'removeSource', tool: source.tool, path: source.path }))).status).toBe(200)
    expect(mock.saveConfig.mock.calls[1][1]).toEqual({ ...config(), agentSources: [] })
  })
  it('initializes first discovery with scoped empty config and saves only to the server-owned settings', async () => {
    mock.readConfig.mockResolvedValue(null)
    expect((await POST(request({ action: 'discovery', enabled: true }))).status).toBe(200)
    expect(mock.saveConfig).toHaveBeenCalledWith(mock.settings, {
      tenantId: 'tenant-a',
      organizationId: 'org-a',
      sources: [],
      claudeSources: [],
      providers: [],
      roots: [],
      agentSources: [],
      autoDiscover: true,
    })
  })
  it.each([
    { action: 'discovery', enabled: 'yes' },
    { action: 'sync', configPath: 'C:/attacker' },
    { action: 'addSource', source: { ...source, path: 'relative' } },
    { action: 'addSource', source: { ...source, tool: 'unknown', format: 'native' } },
    { action: 'addSource', source: { ...source, credential: 'PRIVATE' } },
    { action: 'removeSource', tool: '../invalid', path: source.path },
    { action: '__proto__' },
    [],
    null,
  ])('rejects invalid request %j before opening a transaction', async (body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(mock.query).not.toHaveBeenCalled()
    expect(mock.saveConfig).not.toHaveBeenCalled()
  })
  it('queues sync on the worker and handles unavailable worker without starting scans', async () => {
    expect((await POST(request({ action: 'sync' }))).status).toBe(202)
    expect(mock.sync).toHaveBeenCalledWith(expect.any(Object), mock.context, mock.settings)
    expect(mock.saveConfig).not.toHaveBeenCalled()
    mock.sync.mockResolvedValue('worker_unavailable')
    expect((await POST(request({ action: 'sync' }))).status).toBe(409)
  })
  it('sanitizes filesystem and database error messages', async () => {
    mock.readConfig.mockRejectedValue(new Error('PRIVATE_PATH credential secret'))
    for (const response of [await GET(request()), await POST(request({ action: 'discovery', enabled: true }))]) {
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('PRIVATE')
    }
    mock.requireContext.mockRejectedValue(new AuthzError('forbidden', 'Forbidden'))
    expect((await GET(request())).status).toBe(403)
  })
})
