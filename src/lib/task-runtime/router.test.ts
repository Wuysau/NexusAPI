import { describe, expect, it } from 'vitest'
import {
  readResources,
  selectResource,
  validatePolicy,
  type Candidate,
  type Resource,
  type RoutingPolicy,
} from './router'

const now = new Date('2026-09-22T10:00:00Z')
const candidate = (connectionId = 'a', changes: Partial<Candidate> = {}): Candidate => ({
  connectionId,
  profileRef: `profile-${connectionId}`,
  priority: 1,
  enabled: true,
  switchThreshold: 90,
  capabilities: ['coding'],
  allowedModels: ['gpt-5'],
  allowedTools: ['codex'],
  costMode: 'subscription',
  ...changes,
})
const policy = (candidates = [candidate()]): RoutingPolicy => ({
  name: 'Coding',
  workload: 'coding',
  requiredCapabilities: ['coding'],
  tool: 'codex',
  model: 'gpt-5',
  autoFailover: true,
  autoReturn: false,
  candidates,
})
const resource = (connectionId = 'a', changes: Partial<Resource> = {}): Resource => ({
  ...candidate(connectionId),
  resourceType: 'official_subscription',
  provider: 'openai',
  product: 'codex',
  executionMode: 'subscription_interactive',
  availability: 'available',
  quotaState: 'available',
  resetAt: null,
  usedPercent: 10,
  ...changes,
})
const scope = { tenantId: 'tenant', organizationId: 'org', projectId: 'project' }
const connection = (changes = {}) => ({
  id: 'a',
  tenant_id: 'tenant',
  project_id: 'project',
  provider: 'openai',
  mode: 'subscription_interactive',
  status: 'active',
  revoked_at: null,
  capabilities: {},
  account_observation: null,
  ...changes,
})
const quota = (changes = {}) => ({
  id: 'q',
  connection_id: 'a',
  observation_id: 'q',
  window_type: 'daily',
  used: '25',
  remaining: '75',
  source: 'provider',
  source_kind: 'official',
  confidence: 'reported',
  scope: 'account',
  attribution_mode: 'shared',
  availability: 'available',
  provenance_version: 1,
  observed_at: new Date('2026-09-22T09:59:00Z'),
  stale_at: new Date('2026-09-22T10:04:00Z'),
  reset_at: new Date('2026-09-22T11:00:00Z'),
  metadata: { unit: 'percent' },
  ...changes,
})
function database(connections = [connection()], quotas = [quota()]) {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => ({
      rows: (sql.includes('FROM owned_connections') ? connections : quotas) as T[],
    }),
  }
}

describe('task routing policy', () => {
  it('validates bounded references and rejects unknown credential fields', () => {
    expect(validatePolicy(policy())).toEqual(policy())
    for (const value of [
      { ...policy(), token: 'secret' },
      policy([candidate('a', { profileRef: '../auth' })]),
      policy([candidate('a', { switchThreshold: 101 })]),
      policy([candidate('a', { priority: -1 })]),
      policy([candidate(), candidate()]),
      { ...policy(), autoFailover: 'true' },
    ])
      expect(() => validatePolicy(value)).toThrow()
  })
})

describe('capability-aware resource selection', () => {
  it('checks capabilities, tool and model before quota or priority', () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c'), candidate('d', { priority: 9 })]
    const result = selectResource(
      [
        resource('a', { capabilities: [], quotaState: 'unknown' }),
        resource('b', { allowedTools: [] }),
        resource('c', { allowedModels: ['other'] }),
        resource('d', { priority: 9 }),
      ],
      policy(candidates),
      { now },
    )
    expect(result.selected?.connectionId).toBe('d')
    expect(result.rejected.map((r) => r.reason)).toEqual(['capability', 'tool', 'model'])
  })
  it('honors candidate policy even when supplied resource has a forged priority or enabled flag', () => {
    const p = policy([
      candidate('a', { enabled: false }),
      candidate('b', { priority: 2 }),
      candidate('c', { priority: 1 }),
    ])
    expect(
      selectResource([resource(), resource('b', { priority: 0 }), resource('c')], p, { now }).selected?.connectionId,
    ).toBe('c')
  })
  it.each([
    'unknown',
    'exhausted',
    'temporarily_unavailable',
    'rate_limited',
    'authentication_required',
    'resetting',
  ] as const)('does not select %s quota', (quotaState) => {
    expect(selectResource([resource('a', { quotaState })], policy(), { now }).selected).toBeNull()
  })
  it('rejects invalid usage and expired resets without inventing capacity', () => {
    for (const changes of [{ usedPercent: null }, { usedPercent: NaN }, { resetAt: now.toISOString() }]) {
      expect(selectResource([resource('a', changes)], policy(), { now }).selected).toBeNull()
    }
  })
  it.each([80, 90, 99])('continues the current resource at %i percent usage', (usedPercent) => {
    const p = policy([candidate('a', { priority: 2 }), candidate('b', { priority: 1 })])
    expect(
      selectResource([resource('a', { usedPercent }), resource('b')], p, {
        currentConnectionId: 'a',
        now,
      }).selected?.connectionId,
    ).toBe('a')
  })
  it('keeps a near-limit resource eligible and pins it despite auto-return priority', () => {
    const p = { ...policy([candidate('a', { priority: 2 }), candidate('b', { priority: 1 })]), autoReturn: true }
    expect(
      selectResource([resource('a', { quotaState: 'near_limit', usedPercent: 99 }), resource('b')], p, {
        currentConnectionId: 'a',
        now,
      }).selected?.connectionId,
    ).toBe('a')
  })
  it('fails over from an exhausted current resource to a compatible candidate', () => {
    const p = policy([candidate('a'), candidate('b', { priority: 2 }), candidate('c', { priority: 3 })])
    const result = selectResource(
      [resource('a', { quotaState: 'exhausted' }), resource('b', { allowedTools: [] }), resource('c')],
      p,
      { currentConnectionId: 'a', now },
    )
    expect(result.selected?.connectionId).toBe('c')
  })
  it('honors exclusions and explicit manual target through the same filters', () => {
    const p = policy([candidate(), candidate('b')])
    expect(selectResource([resource(), resource('b')], p, { exclude: ['a'], now }).selected?.connectionId).toBe('b')
    expect(
      selectResource([resource(), resource('b', { quotaState: 'exhausted' })], p, { targetConnectionId: 'b', now })
        .selected,
    ).toBeNull()
    expect(selectResource([resource('unlisted')], p, { now }).selected).toBeNull()
  })
  it('returns only a future compatible candidate reset when the pool is exhausted', () => {
    const result = selectResource(
      [
        resource('a', { quotaState: 'exhausted', resetAt: '2026-09-22T11:00:00Z' }),
        resource('b', { capabilities: [], resetAt: '2026-09-22T10:30:00Z' }),
      ],
      policy([candidate(), candidate('b')]),
      { now },
    )
    expect(result).toMatchObject({ selected: null, nextResetAt: '2026-09-22T11:00:00.000Z' })
  })
  it('preserves known resets from excluded failed resources without making them selectable', () => {
    const result = selectResource(
      [
        resource('a', { quotaState: 'exhausted', resetAt: '2026-09-22T11:00:00Z' }),
        resource('b', { capabilities: [], quotaState: 'exhausted', resetAt: '2026-09-22T10:30:00Z' }),
      ],
      policy([candidate(), candidate('b')]),
      { exclude: ['a', 'b'], now },
    )
    expect(result.selected).toBeNull()
    expect(result.nextResetAt).toBe('2026-09-22T11:00:00.000Z')
  })
  it('does not assume the default model belongs to a restricted allowlist', () => {
    expect(selectResource([resource()], { ...policy(), model: null }, { now }).selected).toBeNull()
  })
})

describe('resource projection from owned connections and quota snapshots', () => {
  it.each(['rate_limited', 'exhausted', 'temporarily_unavailable'] as const)(
    'blocks a fresh structured runtime %s even when official quota is healthy',
    async (state) => {
      const result = await readResources(
        database([
          connection({
            runtime_observation: {
              source: 'tool_runtime',
              state,
              reason: 'provider_error',
              observedAt: '2026-09-22T09:59:50Z',
              staleAt: '2026-09-22T10:00:50Z',
            },
          }),
        ]),
        scope,
        policy(),
        now,
      )
      expect(result[0].quotaState).toBe(state)
      expect(selectResource(result, policy(), { now }).selected).toBeNull()
    },
  )
  it('does not infer recovered quota from an expired runtime cooldown', async () => {
    const rows = [
      connection({
        runtime_observation: {
          source: 'tool_runtime',
          state: 'rate_limited',
          observedAt: '2026-09-22T09:58:00Z',
          staleAt: '2026-09-22T09:59:00Z',
        },
      }),
    ]
    expect((await readResources(database(rows, []), scope, policy(), now))[0].quotaState).toBe('unknown')
    expect((await readResources(database(rows), scope, policy(), now))[0].quotaState).toBe('available')
    expect(
      (
        await readResources(
          database(rows, [quota({ observed_at: new Date('2026-09-22T09:57:00Z') })]),
          scope,
          policy(),
          now,
        )
      )[0].quotaState,
    ).toBe('unknown')
  })
  it('takes the product name from the existing subscription connection metadata', async () => {
    const result = await readResources(
      database([connection({ capabilities: { subscription_product: 'codex-pro' } })]),
      scope,
      policy(),
      now,
    )
    expect(result[0].product).toBe('codex-pro')
  })
  it('keeps an active API connection with no official quota unknown', async () => {
    const result = await readResources(database([connection({ mode: 'api' })], []), scope, policy(), now)
    expect(result[0]).toMatchObject({ resourceType: 'third_party_api', quotaState: 'unknown', usedPercent: null })
    expect(selectResource(result, policy(), { now }).selected).toBeNull()
  })
  it('uses percent metadata and denies the whole resource when any official window is exhausted', async () => {
    const result = await readResources(
      database(undefined, [quota(), quota({ id: 'week', window_type: 'weekly', used: '100', remaining: '0' })]),
      scope,
      policy(),
      now,
    )
    expect(result[0]).toMatchObject({ quotaState: 'exhausted', usedPercent: 100 })
  })
  it('prioritizes official quota over newer client estimates', async () => {
    const result = await readResources(
      database(undefined, [
        quota({ used: '100', remaining: '0' }),
        quota({ id: 'new', source_kind: 'estimated', observed_at: now, used: '0', remaining: '100' }),
      ]),
      scope,
      policy(),
      now,
    )
    expect(result[0].quotaState).toBe('exhausted')
  })
  it('accepts a newer provider quota observation as recovery after a runtime failure', async () => {
    const result = await readResources(
      database(
        [
          connection({
            runtime_observation: {
              source: 'tool_runtime',
              state: 'exhausted',
              observedAt: '2026-09-22T09:58:00Z',
              staleAt: '2026-09-22T10:03:00Z',
            },
          }),
        ],
        [quota({ observed_at: new Date('2026-09-22T09:59:00Z') })],
      ),
      scope,
      policy(),
      now,
    )
    expect(result[0].quotaState).toBe('available')
    expect(selectResource(result, policy(), { now }).selected?.connectionId).toBe('a')
  })
  it('projects a runtime authentication failure as a blocking resource state', async () => {
    const result = await readResources(
      database([
        connection({
          runtime_observation: {
            source: 'tool_runtime',
            state: 'authentication_required',
            observedAt: '2026-09-22T09:59:30Z',
            staleAt: '2026-09-22T10:03:00Z',
          },
        }),
      ]),
      scope,
      policy(),
      now,
    )
    expect(result[0].quotaState).toBe('authentication_required')
    expect(selectResource(result, policy(), { now }).selected).toBeNull()
  })
  it('preserves an account authentication requirement in resource availability', async () => {
    const result = await readResources(
      database([
        connection({
          account_observation: {
            organizationId: 'org',
            status: 'authentication_required',
          },
        }),
      ]),
      scope,
      policy(),
      now,
    )
    expect(result[0].availability).toBe('authentication_required')
    expect(selectResource(result, policy(), { now }).selected).toBeNull()
  })
  it.each([
    { stale_at: now },
    { observed_at: new Date('2026-09-22T10:01:00Z') },
    { provenance_version: null },
    { source_kind: 'estimated' },
    { scope: 'project-estimated' },
    { used: null, remaining: null },
  ])('keeps stale, unknown or untrusted observations ineligible: %j', async (changes) => {
    const result = await readResources(database(undefined, [quota(changes)]), scope, policy(), now)
    expect(result[0].quotaState).toBe('unknown')
  })
  it('requires refresh after reset instead of assuming an empty new window', async () => {
    const result = await readResources(database(undefined, [quota({ reset_at: now })]), scope, policy(), now)
    expect(result[0].quotaState).toBe('resetting')
  })
  it('uses latest official observation per window without discarding another exhausted window', async () => {
    const result = await readResources(
      database(undefined, [
        quota({ used: '100', remaining: '0', observed_at: new Date('2026-09-22T09:58:00Z') }),
        quota({ id: 'new', used: '20', remaining: '80' }),
      ]),
      scope,
      policy(),
      now,
    )
    expect(result[0]).toMatchObject({ quotaState: 'available', usedPercent: 20 })
  })
  it('pins Codex windows to the last provider batch and prevents cross-organization global reuse', async () => {
    const observations = { organizationId: 'org', status: 'connected', quota: { observationIds: ['current'] } }
    const result = await readResources(
      database(
        [connection({ account_observation: observations })],
        [
          quota({ source: 'codex_app_server', observation_id: 'old', used: '100', remaining: '0' }),
          quota({ source: 'codex_app_server', observation_id: 'current', used: '5', remaining: '95' }),
        ],
      ),
      scope,
      policy(),
      now,
    )
    expect(result[0].usedPercent).toBe(5)
    const foreign = await readResources(
      database([connection({ project_id: null, account_observation: { ...observations, organizationId: 'foreign' } })]),
      scope,
      policy(),
      now,
    )
    expect(foreign).toEqual([])
  })
})
