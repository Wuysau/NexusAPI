import { describe, expect, it } from 'vitest'
import { summarizeSubscriptionPools, subscriptionPoolState } from './pool'
import type { ExecutionResourceView } from './catalog'

const resource = (overrides: Partial<ExecutionResourceView> = {}): ExecutionResourceView => ({
  id: 'connection:a',
  connectionId: 'a',
  accountId: 'a',
  channelId: null,
  projectId: null,
  provider: 'openai',
  product: 'openai_codex',
  resourceType: 'official_subscription',
  executionMode: 'local_tool',
  status: 'active',
  priority: null,
  capabilities: [],
  supportedModels: [],
  quotaState: 'available',
  usedPercent: 20,
  resetAt: null,
  health: 'healthy',
  temporaryBlock: null,
  routingStatus: 'not_configured',
  ...overrides,
})

describe('subscription pool monitoring', () => {
  it('never counts unknown health or disabled/exhausted accounts as ready', () => {
    expect(subscriptionPoolState(resource())).toBe('available')
    expect(subscriptionPoolState(resource({ health: 'unknown' }))).toBe('unknown')
    expect(subscriptionPoolState(resource({ status: 'disabled' }))).toBe('disabled')
    expect(subscriptionPoolState(resource({ quotaState: 'exhausted' }))).toBe('exhausted')
    expect(subscriptionPoolState(resource({ health: 'unhealthy' }))).toBe('blocked')
    expect(subscriptionPoolState(resource({ status: 'pending' }))).toBe('unknown')
  })
  it('keeps provider pools separate and excludes API channels', () => {
    const pools = summarizeSubscriptionPools([
      resource(),
      resource({ id: 'b', quotaState: 'near_limit' }),
      resource({ id: 'c', quotaState: 'unknown' }),
      resource({ id: 'd', provider: 'anthropic', product: 'claude_code' }),
      resource({ id: 'e', resourceType: 'api', executionMode: 'gateway' }),
    ])
    expect(pools).toHaveLength(2)
    expect(pools.find((p) => p.provider === 'openai')).toMatchObject({
      total: 3,
      available: 1,
      nearLimit: 1,
      unknown: 1,
    })
  })
  it('retains all blocking windows and cannot promise recovery for an unknown account', () => {
    const pools = summarizeSubscriptionPools([
      resource({ quotaState: 'exhausted', resetAt: '2026-09-30T00:00:00Z' }),
      resource({ id: 'b', quotaState: 'exhausted', resetAt: null }),
    ])
    expect(pools[0]).toMatchObject({ exhausted: 2, nextResetAt: '2026-09-30T00:00:00Z', unknown: 0 })
    expect(pools[0].total).toBe(2)
  })
})
