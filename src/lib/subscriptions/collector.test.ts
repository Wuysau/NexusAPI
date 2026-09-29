import { describe, expect, it } from 'vitest'
import { collectorAccounts, normalizeCollectorSnapshot, readCollectorObservation } from './collector'

const now = new Date('2026-07-16T12:00:00Z')
// Field names and cardinality match docs/dashboard-api.md's schema-v1 examples.
const snapshot = () => ({
  schemaVersion: 1,
  generatedAt: now.toISOString(),
  staleAfterSeconds: 180,
  host: { codexBarVersion: '0.37.2', refreshIntervalSeconds: 60 },
  providers: [
    {
      id: 'claude',
      name: 'Claude',
      enabled: true,
      source: 'oauth',
      identity: { accountEmail: 'user@example.com', plan: 'Max' },
      windows: [
        { kind: 'session', label: 'Session', usedPercent: 20, remainingPercent: 80, resetAt: '2026-07-16T17:00:00Z' },
      ],
      error: null,
      updatedAt: '2026-07-16T11:59:45Z',
    },
  ],
})
const bind = (value: unknown) => ({ providerId: 'claude', accountId: collectorAccounts(value, 'claude')[0].accountId })

describe('CodexBar dashboard-v1 monitor normalization', () => {
  it('reads the documented provider/window fields and preserves known zero without invented limits', () => {
    const input = snapshot()
    input.providers[0].windows[0].usedPercent = 0
    const result = normalizeCollectorSnapshot(input, bind(input), 'org-a', now)
    expect(result).toMatchObject({
      organizationId: 'org-a',
      source: 'codexbar',
      authority: 'collector_reported',
      state: 'reported',
      windows: [{ usedPercent: 0, remainingPercent: 80 }],
    })
    expect(result).not.toHaveProperty('limit')
  })
  it('selects only the explicitly bound multi-account row, never ambient data or active account', () => {
    const input = snapshot()
    const row = input.providers[0]
    const multi = {
      ...input,
      providers: [
        {
          ...row,
          accounts: [
            {
              id: 'claude-swap:2',
              active: true,
              identity: { accountEmail: 'personal@example.com' },
              windows: [{ kind: 'weekly', usedPercent: 60, remainingPercent: 40 }],
              error: null,
              updatedAt: now.toISOString(),
            },
            { id: 'claude-swap:1', active: false, windows: [], error: 'secret-token-provider-error', updatedAt: null },
          ],
        },
      ],
    }
    const accounts = collectorAccounts(multi, 'claude')
    expect(
      normalizeCollectorSnapshot(multi, { providerId: 'claude', accountId: accounts[0].accountId }, 'org-a', now)
        .windows[0].usedPercent,
    ).toBe(60)
    const failed = normalizeCollectorSnapshot(
      multi,
      { providerId: 'claude', accountId: accounts[1].accountId },
      'org-a',
      now,
    )
    expect(failed.state).toBe('error')
    expect(failed.windows).toEqual([])
    expect(JSON.stringify(failed)).not.toContain('secret-token')
    expect(() =>
      normalizeCollectorSnapshot(input, { providerId: 'claude', accountId: accounts[0].accountId }, 'org-a', now),
    ).toThrow('account_missing_or_ambiguous')
  })
  it('rejects a switched account and ambiguous, redacted, missing identities', () => {
    const first = snapshot()
    const binding = bind(first)
    first.providers[0].identity.accountEmail = 'different@example.com'
    expect(() => normalizeCollectorSnapshot(first, binding, 'org-a', now)).toThrow('account_missing_or_ambiguous')
    first.providers[0].identity.accountEmail = 'redacted@example.com'
    expect(collectorAccounts(first, 'claude')).toEqual([])
    expect(() =>
      collectorAccounts({ ...first, providers: [first.providers[0], first.providers[0]] }, 'claude'),
    ).toThrow('provider_missing_or_ambiguous')
    expect(() => normalizeCollectorSnapshot({ ...first, schemaVersion: 2 }, binding, 'org-a', now)).toThrow(
      'invalid_dashboard_snapshot',
    )
  })
  it('uses provider update time and recalculates staleness at read time', () => {
    const input = snapshot()
    const saved = normalizeCollectorSnapshot(input, bind(input), 'org-a', now)
    expect(readCollectorObservation(saved, 'org-a', new Date(now.getTime() + 200_000))?.state).toBe('stale')
    expect(readCollectorObservation(saved, 'org-b', now)).toBeNull()
    input.providers[0].updatedAt = '2026-07-16T11:00:00Z'
    expect(normalizeCollectorSnapshot(input, bind(input), 'org-a', now).state).toBe('stale')
  })
  it('does not persist raw errors, identities, credentials, extra fields, costs or free-form labels', () => {
    const input = snapshot()
    const noisy = {
      ...input,
      token: 'do-not-save',
      providers: [
        {
          ...input.providers[0],
          accessToken: 'do-not-save',
          credits: { remaining: 100 },
          cost: { todayUSD: 20 },
          debug: { cookie: 'do-not-save' },
          windows: [{ kind: 'session', label: 'do-not-save', usedPercent: -1, remainingPercent: 101 }],
        },
      ],
    }
    const saved = normalizeCollectorSnapshot(noisy, bind(noisy), 'org-a', now)
    expect(saved.windows[0]).toMatchObject({ usedPercent: null, remainingPercent: null })
    expect(saved.state).toBe('unknown')
    expect(JSON.stringify(saved)).not.toMatch(/do-not-save|user@example|credits|todayUSD/)
    expect(JSON.stringify(readCollectorObservation({ ...saved, token: 'do-not-save' }, 'org-a', now))).not.toContain(
      'do-not-save',
    )
  })
  it('missing update time and future timestamps cannot become fresh observations', () => {
    const input = snapshot()
    const binding = bind(input)
    expect(
      normalizeCollectorSnapshot(
        { ...input, providers: [{ ...input.providers[0], updatedAt: null }] },
        binding,
        'org-a',
        now,
      ).state,
    ).toBe('unknown')
    input.generatedAt = '2026-07-17T12:00:00Z'
    input.providers[0].updatedAt = input.generatedAt
    expect(normalizeCollectorSnapshot(input, binding, 'org-a', now).state).toBe('unknown')
  })
  it('marks a reset window stale even while the observation timestamp is within the TTL', () => {
    const input = snapshot()
    input.providers[0].windows[0].resetAt = '2026-07-16T12:00:30Z'
    const saved = normalizeCollectorSnapshot(input, bind(input), 'org-a', now)
    expect(saved.state).toBe('reported')
    expect(readCollectorObservation(saved, 'org-a', new Date('2026-07-16T12:00:30Z'))?.state).toBe('stale')
  })
  it('validates provider and snapshot future timestamps independently before taking the older timestamp', () => {
    const input = snapshot()
    const binding = bind(input)
    input.providers[0].updatedAt = '2026-07-17T12:00:00Z'
    expect(normalizeCollectorSnapshot(input, binding, 'org-a', now).state).toBe('unknown')
    input.providers[0].updatedAt = now.toISOString()
    input.generatedAt = '2026-07-17T12:00:00Z'
    expect(normalizeCollectorSnapshot(input, binding, 'org-a', now).state).toBe('unknown')
  })
  it('rejects reuse of a multi-account slot with a different known identity', () => {
    const input = snapshot()
    const account = { ...input.providers[0], id: 'claude-swap:2' }
    const multi = { ...input, providers: [{ ...input.providers[0], accounts: [account] }] }
    const binding = bind(multi)
    account.identity.accountEmail = 'changed@example.com'
    expect(() => normalizeCollectorSnapshot(multi, binding, 'org-a', now)).toThrow('account_missing_or_ambiguous')
  })
})
