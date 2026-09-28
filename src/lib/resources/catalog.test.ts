import { describe, expect, it } from 'vitest'
import { buildResourceCatalog } from './catalog'

describe('unified execution resource catalog', () => {
  it('projects an observed subscription without treating its credential as a gateway key', () => {
    const items = buildResourceCatalog(
      [
        {
          id: 'conn-a',
          provider: 'openai',
          mode: 'subscription_interactive',
          status: 'active',
          project_id: 'p',
          revoked_at: null,
          capabilities: { subscription_product: 'openai_codex' },
          account_observation: { status: 'connected', lastSuccessfulSyncAt: '2026-09-24T00:59:00Z' },
        },
      ],
      [],
      [
        {
          connection_id: 'conn-a',
          availability: 'available',
          used: '99',
          remaining: '1',
          observed_at: '2026-09-24T00:00:00Z',
          stale_at: '2026-09-25T00:00:00Z',
          reset_at: '2026-09-25T01:00:00Z',
          source_kind: 'official',
          confidence: 'reported',
          scope: 'account',
          metadata: { unit: 'percent' },
        },
      ],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(items).toMatchObject([
      {
        id: 'connection:conn-a',
        connectionId: 'conn-a',
        accountId: 'conn-a',
        resourceType: 'official_subscription',
        executionMode: 'local_tool',
        quotaState: 'near_limit',
        health: 'healthy',
        projectId: 'p',
        routingStatus: 'not_configured',
      },
    ])
    expect(JSON.stringify(items)).not.toContain('credentialRef')
  })

  it('keeps API channel identity separate from its linked connection and never fabricates quota', () => {
    const items = buildResourceCatalog(
      [
        {
          id: 'conn-api',
          provider: 'openai',
          mode: 'direct_api',
          status: 'active',
          project_id: null,
          revoked_at: null,
          capabilities: {},
          account_observation: null,
        },
      ],
      [
        {
          id: 'channel-a',
          name: 'Primary',
          provider: 'openai',
          provider_credential_id: 'cred-a',
          credential_enabled: true,
          enabled: true,
          priority: 2,
          capabilities: ['chat'],
          metadata: { connection_id: 'conn-api', model: 'gpt-x', models: ['gpt-x', 'gpt-y'] },
        },
      ],
      [],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(items).toMatchObject([
      {
        id: 'channel:channel-a',
        connectionId: 'conn-api',
        accountId: 'cred-a',
        resourceType: 'api',
        executionMode: 'gateway',
        quotaState: 'unknown',
        supportedModels: ['gpt-x', 'gpt-y'],
        routingStatus: 'configured',
      },
    ])
    expect(items).toHaveLength(1)
  })

  it('keeps an unbound direct provider connection visible as pending resource', () => {
    const items = buildResourceCatalog(
      [
        {
          id: 'direct',
          provider: 'custom',
          mode: 'direct_api',
          status: 'pending',
          project_id: 'p',
          revoked_at: null,
          capabilities: {},
          account_observation: null,
        },
      ],
      [],
      [],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(items).toMatchObject([
      {
        id: 'connection:direct',
        resourceType: 'api',
        executionMode: 'direct_provider',
        status: 'pending',
        quotaState: 'unknown',
      },
    ])
  })

  it('does not use expired or untrusted quota observations to claim capacity', () => {
    const connection = {
      id: 'a',
      provider: 'openai',
      mode: 'subscription_interactive',
      status: 'active',
      project_id: null,
      revoked_at: null,
      capabilities: {},
      account_observation: null,
    }
    const quota = {
      connection_id: 'a',
      availability: 'available',
      used: '10',
      remaining: '90',
      observed_at: '2026-09-24T00:00:00Z',
      stale_at: '2026-09-24T00:30:00Z',
      reset_at: null,
      source_kind: 'official',
      confidence: 'reported',
      scope: 'account',
      metadata: {},
    }
    expect(buildResourceCatalog([connection], [], [quota], new Date('2026-09-24T01:00:00Z'))[0].quotaState).toBe(
      'unknown',
    )
    expect(
      buildResourceCatalog(
        [connection],
        [],
        [{ ...quota, stale_at: '2026-09-25T00:00:00Z', source_kind: 'observed' }],
        new Date('2026-09-24T01:00:00Z'),
      )[0].quotaState,
    ).toBe('unknown')
  })

  it('does not advertise a reset time when another quota window is stale', () => {
    const connection = {
      id: 'a',
      provider: 'openai',
      mode: 'subscription_interactive',
      status: 'active',
      project_id: null,
      revoked_at: null,
      capabilities: {},
      account_observation: null,
    }
    const base = {
      connection_id: 'a',
      availability: 'available',
      used: '10',
      remaining: '90',
      observed_at: '2026-09-24T00:58:00Z',
      stale_at: '2026-09-24T01:03:00Z',
      reset_at: '2026-09-24T02:00:00Z',
      source_kind: 'official',
      confidence: 'reported',
      scope: 'account',
      metadata: { unit: 'percent' },
    }
    const result = buildResourceCatalog(
      [connection],
      [],
      [
        { ...base, window_type: 'daily' },
        { ...base, window_type: 'weekly', stale_at: '2026-09-24T00:59:00Z' },
      ],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(result[0]).toMatchObject({ quotaState: 'unknown', resetAt: null })
  })

  it('does not borrow a prior Codex account batch after the connected identity changes', () => {
    const connection = {
      id: 'a',
      provider: 'openai',
      mode: 'subscription_interactive',
      status: 'active',
      project_id: null,
      revoked_at: null,
      capabilities: {},
      account_observation: { status: 'connected', quota: { observationIds: ['new'] } },
    }
    const quota = {
      connection_id: 'a',
      observation_id: 'old',
      source: 'codex_app_server',
      availability: 'available',
      used: '30',
      remaining: '70',
      observed_at: '2026-09-24T00:00:00Z',
      stale_at: '2026-09-25T00:00:00Z',
      reset_at: null,
      source_kind: 'official',
      confidence: 'reported',
      scope: 'account',
      metadata: { unit: 'percent' },
    }
    expect(buildResourceCatalog([connection], [], [quota], new Date('2026-09-24T01:00:00Z'))[0].quotaState).toBe(
      'unknown',
    )
  })

  it('keeps stale account health and absent local priority unknown', () => {
    const resources = buildResourceCatalog(
      [
        {
          id: 'a',
          provider: 'openai',
          mode: 'subscription_interactive',
          status: 'active',
          project_id: null,
          revoked_at: null,
          capabilities: {},
          account_observation: { status: 'connected', lastSuccessfulSyncAt: '2026-09-23T00:00:00Z' },
        },
      ],
      [],
      [],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(resources[0]).toMatchObject({ health: 'unknown', priority: null, quotaState: 'unknown' })
  })

  it('shows runtime failure separately from an otherwise available official quota', () => {
    const resources = buildResourceCatalog(
      [
        {
          id: 'a',
          provider: 'openai',
          mode: 'subscription_interactive',
          status: 'active',
          project_id: null,
          revoked_at: null,
          capabilities: {},
          account_observation: null,
          runtime_observation: {
            source: 'tool_runtime',
            state: 'rate_limited',
            reason: 'rate_limit',
            observedAt: '2026-09-24T00:59:00Z',
            staleAt: '2026-09-24T01:02:00Z',
          },
        },
      ],
      [],
      [
        {
          connection_id: 'a',
          availability: 'available',
          used: '10',
          remaining: '90',
          observed_at: '2026-09-24T00:58:00Z',
          stale_at: '2026-09-24T01:03:00Z',
          reset_at: null,
          source_kind: 'official',
          confidence: 'reported',
          scope: 'account',
          metadata: { unit: 'percent' },
        },
      ],
      new Date('2026-09-24T01:00:00Z'),
    )
    expect(resources[0]).toMatchObject({
      quotaState: 'available',
      health: 'unhealthy',
      temporaryBlock: { reason: 'rate_limit', recheckAt: '2026-09-24T01:02:00.000Z' },
    })
  })
})
