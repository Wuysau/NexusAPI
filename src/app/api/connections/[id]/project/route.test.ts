import { beforeEach, expect, it, vi } from 'vitest'

const { query, release, resolveQuotaProject, auditControlPlane, context } = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  resolveQuotaProject: vi.fn(),
  auditControlPlane: vi.fn(),
  context: {
    tenantId: 'tenant-a',
    organizationId: 'org-a',
    session: { userId: 'user-a' },
    membership: { role: 'owner' },
  },
}))

vi.mock('@/db', () => ({ pool: { connect: async () => ({ query, release }) } }))
vi.mock('@/lib/quota/access', () => ({ resolveQuotaProject }))
vi.mock('@/app/api/_lib/control-plane', () => ({
  requireContext: async () => context,
  readJsonBody: (req: Request) => req.json(),
  apiError: (status: number, code: string, message: string) => Response.json({ code, message }, { status }),
  routeError: (error: { status?: number; message?: string }) =>
    Response.json({ message: error.message }, { status: error.status ?? 500 }),
  jsonOk: (value: unknown) => Response.json(value),
  auditControlPlane,
}))

import { PATCH } from './route'

const request = (projectId: unknown) =>
  new Request('http://localhost/api/connections/connection-a/project', {
    method: 'PATCH',
    body: JSON.stringify({ projectId }),
  })
const params = { params: Promise.resolve({ id: 'connection-a' }) }

beforeEach(() => {
  context.membership.role = 'owner'
  query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT c.id,c.owner_user_id,c.project_id')
      ? [{ id: 'connection-a', owner_user_id: 'user-a', project_id: null }]
      : [],
  }))
  release.mockReset()
  resolveQuotaProject.mockReset().mockResolvedValue({ id: 'project-b' })
  auditControlPlane.mockReset()
})

it('binds only the selected connection to another existing project', async () => {
  const response = await PATCH(request('project-b'), params)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ connection: { id: 'connection-a', projectId: 'project-b' } })
  expect(resolveQuotaProject).toHaveBeenCalledWith(expect.anything(), context, 'project-b', {
    write: true,
    lock: true,
  })
  expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE owned_connections'))?.[1]).toEqual([
    'project-b',
    'connection-a',
    'tenant-a',
  ])
  expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
})

it('rejects a project that is unavailable without changing the connection', async () => {
  resolveQuotaProject.mockRejectedValue({ status: 404, message: '项目不存在' })
  expect((await PATCH(request('other-project'), params)).status).toBe(404)
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE owned_connections'))).toBe(false)
  expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
})

it('rejects a different developer who does not own the connection', async () => {
  context.membership.role = 'developer'
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('SELECT c.id,c.owner_user_id,c.project_id')
      ? [{ id: 'connection-a', owner_user_id: 'another-user', project_id: null }]
      : [],
  }))
  expect((await PATCH(request('project-b'), params)).status).toBe(404)
  expect(resolveQuotaProject).not.toHaveBeenCalled()
})

it('can remove a project binding without deleting historical observations', async () => {
  const response = await PATCH(request(null), params)
  expect(response.status).toBe(200)
  expect(resolveQuotaProject).not.toHaveBeenCalled()
  expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE owned_connections'))?.[1][0]).toBeNull()
  expect(query.mock.calls.some(([sql]) => sql.includes('external_observed_usage'))).toBe(false)
})
