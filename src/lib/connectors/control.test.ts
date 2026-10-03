import { beforeEach, describe, expect, it, vi } from 'vitest'
import modelIDCases from '../../../tests/fixtures/connector-model-ids.json'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/db', () => ({ pool: { query: mocks.query } }))

import { authorizeConnector, modelIDs, type ConnectorAuthorization } from './control'

const bindings: ConnectorAuthorization = {
  leaseToken: 'nxlease_fixture',
  tenantId: 'tenant-a',
  connectionId: 'connection-a',
  channelId: 'channel-a',
  projectId: 'project-a',
  organizationId: 'organization-a',
  keyId: 'key-a',
  scope: 'models:read',
}

const lease = {
  lease_id: 'lease-a',
  connector_id: 'connector-a',
  connection_id: 'connection-a',
  tenant_id: 'tenant-a',
  project_id: 'project-a',
  organization_id: 'organization-a',
  expires_at: new Date('2099-01-01'),
  ready_models: ['qwen:7b', 'llama:3b', 'ready-only'],
}

function liveRows(readyModels: unknown = lease.ready_models, approvedModels: unknown = ['qwen:7b', 'llama:3b']) {
  mocks.query
    .mockResolvedValueOnce({ rows: [{ ...lease, ready_models: readyModels }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: 'channel-a', approved_models: approvedModels }], rowCount: 1 })
}

beforeEach(() => mocks.query.mockReset())

describe('connector model policy shared with the CLI', () => {
  it.each(modelIDCases.valid)('accepts $name', ({ id }) => {
    expect(modelIDs([id])).toEqual([id])
  })

  it.each(modelIDCases.invalid)('rejects $name', ({ id }) => {
    expect(() => modelIDs([id])).toThrowError(expect.objectContaining({ code: 'invalid_models', status: 400 }))
    expect(mocks.query).not.toHaveBeenCalled()
  })
})

describe('connector model batch authorization', () => {
  it('authorizes one live batch and returns only requested, ready and approved models', async () => {
    liveRows(lease.ready_models, ['qwen:7b', 'llama:3b', 'approved-only'])
    const grant = await authorizeConnector({
      ...bindings,
      requestedModels: ['llama:3b', 'qwen:7b', 'llama:3b', 'ready-only', 'approved-only', 'unknown'],
    })
    expect(grant).toEqual({
      leaseId: lease.lease_id,
      connectorId: lease.connector_id,
      connectionId: lease.connection_id,
      tenantId: lease.tenant_id,
      expiresAt: lease.expires_at,
      models: ['llama:3b', 'qwen:7b'],
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false)
  })

  it('returns an empty intersection only after validating channel and key authorization', async () => {
    liveRows([])
    await expect(authorizeConnector({ ...bindings, requestedModels: ['qwen:7b'] })).resolves.toMatchObject({
      models: [],
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['chat scope', { scope: 'chat:write' }],
    ['transport heartbeat', { transport: true }],
    ['malformed transport', { transport: 'false' }],
    ['single model', { model: 'qwen:7b' }],
    ['null model', { model: null }],
    ...['tenantId', 'connectionId', 'channelId', 'projectId', 'organizationId', 'keyId'].map(
      (field): [string, Record<string, unknown>] => [`missing ${field}`, { [field]: undefined }],
    ),
  ])('rejects %s before any lookup or heartbeat', async (_name, change) => {
    const input = { ...bindings, requestedModels: ['qwen:7b'], ...(change as object) }
    await expect(authorizeConnector(input as ConnectorAuthorization)).rejects.toMatchObject({
      code: 'connector_unauthorized',
    })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it.each([null, {}, 'qwen:7b', [], ['bad model'], [1], Array.from({ length: 65 }, (_, i) => `model-${i}`)])(
    'rejects invalid requestedModels %#',
    async (requestedModels) => {
      await expect(authorizeConnector({ ...bindings, requestedModels } as ConnectorAuthorization)).rejects.toBeDefined()
      expect(mocks.query).not.toHaveBeenCalled()
    },
  )

  it.each(['tenantId', 'connectionId', 'projectId', 'organizationId'])('rejects cross-boundary %s', async (field) => {
    liveRows()
    await expect(
      authorizeConnector({ ...bindings, requestedModels: ['qwen:7b'], [field]: 'other' }),
    ).rejects.toMatchObject({ code: 'connector_unauthorized' })
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('requires the live lease and live channel/key grant', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(authorizeConnector({ ...bindings, requestedModels: ['qwen:7b'] })).rejects.toMatchObject({
      code: 'connector_unauthorized',
    })
    mocks.query.mockReset()
    mocks.query.mockResolvedValueOnce({ rows: [lease], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(authorizeConnector({ ...bindings, requestedModels: ['qwen:7b'] })).rejects.toMatchObject({
      code: 'connector_unauthorized',
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
})

describe('shared single and batch authorization', () => {
  it.each([false, true])('fails closed on malformed stored model lists, batch=%s', async (batch) => {
    const input = batch ? { ...bindings, requestedModels: ['qwen:7b'] } : { ...bindings, model: 'qwen:7b' }
    for (const malformed of [null, 'qwen:7b', { 'qwen:7b': true }, ['qwen:7b', 1], ['invalid model']]) {
      for (const location of ['ready', 'approved']) {
        mocks.query.mockReset()
        liveRows(
          location === 'ready' ? malformed : lease.ready_models,
          location === 'approved' ? malformed : ['qwen:7b'],
        )
        await expect(authorizeConnector(input)).rejects.toMatchObject({ code: 'connector_unauthorized' })
        expect(mocks.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false)
      }
    }
  })

  it.each(['chat:write', 'models:read'])('preserves the single-model %s response', async (scope) => {
    liveRows()
    await expect(authorizeConnector({ ...bindings, scope, model: 'qwen:7b' })).resolves.toMatchObject({
      models: lease.ready_models,
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('preserves authenticated transport heartbeats without channel authorization', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [lease], rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 })
    await expect(authorizeConnector({ leaseToken: bindings.leaseToken, transport: true })).resolves.toMatchObject({
      models: lease.ready_models,
    })
    expect(mocks.query.mock.calls[1][0]).toContain('UPDATE connector_leases SET transport_seen_at=now()')
  })
})
