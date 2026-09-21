import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import type { AccountObservation } from './types'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  authorize: vi.fn(),
}))
vi.mock('@/db', () => ({ pool: { connect: mocks.connect } }))
vi.mock('@/lib/quota/access', () => ({ resolveQuotaConnection: mocks.authorize }))
vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  connectCodexAccount: async () => ({ read: mocks.read, close: mocks.close }),
}))
import { syncCodexAccountConnection } from './sync'

const ctx = { tenantId: 'tenant', organizationId: 'org' } as ControlPlaneContext
let previous: AccountObservation
let saved: AccountObservation | undefined
beforeEach(() => {
  vi.resetAllMocks()
  previous = {
    source: 'codex_app_server',
    authority: 'provider_reported',
    scope: 'account',
    organizationId: 'org',
    identity: createHash('sha256').update('chatgpt\0fixture@example.invalid').digest('hex'),
    account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus', observedAt: '2026-01-01' },
    status: 'connected',
    lastAttemptAt: '2026-01-01',
    lastSuccessfulSyncAt: '2026-01-01',
    lastSyncError: null,
    quota: { observationIds: ['old'], observedAt: '2026-01-01' },
    usage: {
      observedAt: '2026-01-01',
      summary: {
        lifetimeTokens: '99',
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    },
  }
  saved = undefined
  mocks.authorize.mockResolvedValue({ role: 'owner', mode: 'subscription_interactive', provider: 'openai' })
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string, args?: unknown[]) => {
    if (sql.startsWith('SELECT account_observation')) return { rows: [{ account_observation: previous }] }
    if (sql.startsWith('UPDATE owned_connections')) saved = JSON.parse(args![2] as string)
    return { rows: [] }
  })
  mocks.read.mockImplementation(async (method: string) => {
    if (method === 'account/read') return { account: previous.account }
    if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', primary: { usedPercent: 75 } } }
    return { summary: { lifetimeTokens: '100' }, dailyUsageBuckets: null }
  })
})

describe('independent official quota refresh', () => {
  it('checks identity and quota without fetching usage; preserves previous usage timestamp', async () => {
    await syncCodexAccountConnection(ctx, 'connection', 'quota')
    expect(mocks.read.mock.calls.map(([method]) => method)).toEqual(['account/read', 'account/rateLimits/read'])
    expect(saved?.usage).toEqual(previous.usage)
    expect(saved?.quota?.observedAt).not.toBe(previous.quota?.observedAt)
    expect(mocks.authorize).toHaveBeenCalledTimes(2)
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('retains existing full refresh compatibility', async () => {
    await syncCodexAccountConnection(ctx, 'connection')
    expect(mocks.read).toHaveBeenCalledWith('account/usage/read')
    expect(saved?.usage?.summary.lifetimeTokens).toBe('100')
  })
  it('does not request subscription quota for a non-ChatGPT account', async () => {
    previous.identity = null
    previous.account = null
    mocks.read.mockResolvedValueOnce({ account: { type: 'apiKey' } })
    await syncCodexAccountConnection(ctx, 'connection', 'quota')
    expect(mocks.read.mock.calls.map(([method]) => method)).toEqual(['account/read'])
    expect(saved?.lastSyncError).toBe('quota:unsupported')
    expect(saved?.quota).toEqual(previous.quota)
  })
  it('preserves the last quota and usage on provider failure', async () => {
    mocks.read.mockRejectedValueOnce(new Error('private provider diagnostic'))
    await syncCodexAccountConnection(ctx, 'connection', 'quota')
    expect(saved?.quota).toEqual(previous.quota)
    expect(saved?.usage).toEqual(previous.usage)
    expect(saved?.lastSyncError).toBe('sync_error')
    expect(JSON.stringify(saved)).not.toContain('private provider')
  })
  it('rejects changed identity without blending quota or usage', async () => {
    mocks.read.mockResolvedValueOnce({ account: { ...previous.account, email: 'other@example.invalid' } })
    await syncCodexAccountConnection(ctx, 'connection', 'quota')
    expect(saved?.lastSyncError).toBe('account_changed')
    expect(saved?.quota).toEqual(previous.quota)
    expect(saved?.usage).toEqual(previous.usage)
    expect(saved?.account).toEqual(previous.account)
  })
  it('rechecks current authorization before any observation write', async () => {
    mocks.authorize
      .mockResolvedValueOnce({ role: 'owner', mode: 'subscription_interactive', provider: 'openai' })
      .mockRejectedValueOnce(new Error('revoked'))
    await expect(syncCodexAccountConnection(ctx, 'connection', 'quota')).rejects.toThrow('revoked')
    expect(saved).toBeUndefined()
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
