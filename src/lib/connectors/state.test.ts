import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/db', () => ({ pool: { query: mocks.query } }))

import { connectorState } from './control'

const now = Date.UTC(2026, 8, 30)
const ctx = {
  tenantId: 'tenant-a',
  organizationId: 'org-a',
  session: { userId: 'user-a' },
  membership: { role: 'admin' },
} as ControlPlaneContext

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection-a',
    revoked_at: null,
    models: ['qwen:7b', 'llama:3b'],
    ready_models: ['llama:3b', 'qwen:7b', 'ready-only'],
    approved_model_lists: [
      ['qwen:7b', 'approved-only'],
      ['llama:3b', 'qwen:7b'],
    ],
    expires_at: new Date(now + 60_000),
    transport_seen_at: new Date(now - 1000),
    last_heartbeat_at: new Date(now - 2000),
    lease_revoked_at: null,
    identity_revoked_at: null,
    project_status: 'active',
    project_archived_at: null,
    organization_status: 'active',
    organization_deleted_at: null,
    ...overrides,
  }
}

function respond(overrides: Record<string, unknown> = {}) {
  mocks.query.mockResolvedValueOnce({ rows: [row(overrides)], rowCount: 1 })
}

beforeEach(() => {
  mocks.query.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => vi.restoreAllMocks())

describe('connector management readiness projection', () => {
  it('intersects local readiness with the union of eligible channel models without inference or heartbeat', async () => {
    respond()
    const state = await connectorState(ctx, 'connection-a')
    expect(state).toMatchObject({
      connectionId: 'connection-a',
      state: 'online',
      models: ['qwen:7b', 'llama:3b'],
      readyModels: ['llama:3b', 'qwen:7b'],
      lastHeartbeatAt: new Date(now - 2000),
    })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0][1]).toEqual(['tenant-a', 'org-a', 'user-a', true, 'connection-a', null])
    expect(mocks.query.mock.calls[0][0]).not.toMatch(/\b(?:UPDATE|INSERT|DELETE)\b/)
  })

  it('scopes a channel resource to its own approvals and preserves its existing connection identity', async () => {
    respond({ approved_model_lists: [['qwen:7b']] })
    expect(await connectorState(ctx, 'connection-a', 'channel-b')).toMatchObject({
      connectionId: 'connection-a',
      state: 'online',
      readyModels: ['qwen:7b'],
    })
    expect(mocks.query.mock.calls[0][1].at(-1)).toBe('channel-b')
  })

  it.each([null, [], [['not-installed']], [['invalid model']], [[null]], ['qwen:7b']])(
    'keeps transport online without callable models for approvals=%j',
    async (approved) => {
      respond({ approved_model_lists: approved })
      expect(await connectorState(ctx, 'connection-a')).toMatchObject({ state: 'online', readyModels: [] })
    },
  )

  it('skips a malformed channel rather than discarding a valid channel or granting partial invalid lists', async () => {
    respond({ approved_model_lists: [['llama:3b', 123], null, { model: 'llama:3b' }, ['qwen:7b', 'qwen:7b']] })
    expect((await connectorState(ctx, 'connection-a')).readyModels).toEqual(['qwen:7b'])
  })

  it.each([null, 'qwen:7b', { 'qwen:7b': true }, ['qwen:7b', 1], ['invalid model']])(
    'cannot derive readiness from malformed local reports=%j',
    async (reported) => {
      respond({ ready_models: reported })
      expect((await connectorState(ctx, 'connection-a')).readyModels).toEqual([])
    },
  )

  it.each([
    ['registered', { expires_at: null }],
    ['expired', { expires_at: new Date(now) }],
    ['expired', { lease_revoked_at: new Date(now - 1) }],
    ['expired', { identity_revoked_at: new Date(now - 1) }],
    ['offline', { transport_seen_at: new Date(now - 35_000) }],
    ['offline', { transport_seen_at: null }],
    ['revoked', { revoked_at: new Date(now - 1) }],
  ])('preserves %s transport state and excludes readiness', async (state, overrides) => {
    respond(overrides as Record<string, unknown>)
    expect(await connectorState(ctx, 'connection-a')).toMatchObject({ state, readyModels: [] })
  })

  it.each([
    { project_status: 'inactive' },
    { project_archived_at: new Date(now) },
    { organization_status: 'inactive' },
    { organization_deleted_at: new Date(now) },
  ])('keeps transport evidence separate from project/organization readiness: %j', async (overrides) => {
    respond(overrides)
    expect(await connectorState(ctx, 'connection-a')).toMatchObject({ state: 'online', readyModels: [] })
  })

  it('retains the management visibility boundary', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(connectorState(ctx, 'hidden-connection')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
