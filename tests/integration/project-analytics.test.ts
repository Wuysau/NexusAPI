import { writeFileSync, mkdirSync } from 'node:fs'
import { Pool } from 'pg'
import { processOutboxEvent } from '../../services/worker/processor'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { queryUsageAnalytics, queryUsageLogs, type AnalyticsDatabase } from '@/lib/billing/analytics'
import type { AnalyticsAccess } from '@/lib/billing/analytics-access'
import {
  AnalyticsQueryError,
  parseUsageAnalyticsQuery,
  type AnalyticsQuery,
} from '../../packages/contracts/usage-analytics'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const access: AnalyticsAccess = {
  tenantId: 'analytics',
  organizations: [{ organizationId: 'analytics-org', allProjects: true, projectIds: [] }],
  financialOrganizationId: 'analytics-org',
}
const query: AnalyticsQuery = {
  scope: 'organization',
  groupBy: 'project',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  asOf: '2026-02-01T00:00:00.000Z',
  limit: 100,
  offset: 0,
  status: 'all',
}
async function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row)
  await pool.query(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  )
}
const usage = (input: string | null = '10') => ({
  input_tokens: input === null ? null : Number(input),
  output_tokens: 5,
  cached_input_tokens: 3,
  reasoning_tokens: 2,
  total_tokens: input === null ? null : Number(BigInt(input) + 5n),
  estimated: false,
})
async function event(
  id: string,
  request: string,
  counts = usage(),
  attempt: string | null = null,
  settled = true,
  currency = 'USD',
  cost = '2',
) {
  const canonical = { schema_version: 2, tenant_id: 'analytics', request_id: request, usage: counts }
  await insert('usage_events', {
    id,
    tenant_id: 'analytics',
    request_id: request,
    attempt_id: attempt,
    event_id: id,
    event_type: 'usage',
    payload: JSON.stringify({ event: canonical }),
  })
  if (settled)
    await insert('usage_records', {
      id: `record-${id}`,
      tenant_id: 'analytics',
      request_id: request,
      usage_event_id: id,
      authoritative_metering: JSON.stringify(canonical),
      upstream_cost_amount: cost,
      upstream_cost_currency: currency,
    })
}
async function request(
  id: string,
  project: string | null,
  overrides: Record<string, unknown> = {},
  status = project ? 'attributed' : 'unattributed',
) {
  await insert('request_records', {
    id,
    tenant_id: 'analytics',
    organization_id: 'analytics-org',
    request_model: 'model',
    channel_kind: 'platform',
    execution_mode: 'managed',
    status: 'completed',
    started_at: '2026-01-15T00:00:00Z',
    created_at: '2026-01-15T00:00:00Z',
    charge_amount: '7',
    gross_margin_amount: '5',
    ...overrides,
  })
  if (status !== 'unknown')
    await insert('request_project_facts', {
      request_id: id,
      tenant_id: 'analytics',
      organization_id: 'analytics-org',
      project_id: project,
      project_name: project ? `Original ${project}` : null,
      api_key_id: overrides.downstream_key_id ?? null,
      execution_mode: overrides.execution_mode ?? 'managed',
      attribution_status: status,
      catalog_version_id: 'catalog',
    })
}
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await insert('organizations', { id: 'analytics-org', tenant_id: 'analytics', name: 'Analytics', slug: 'analytics' })
  for (let i = 0; i < 105; i++) {
    const project = `p${String(i).padStart(3, '0')}`
    await insert('projects', { id: project, tenant_id: 'analytics', organization_id: 'analytics-org', name: project })
    await request(`r${String(i).padStart(3, '0')}`, project)
    await event(`e${i}`, `r${String(i).padStart(3, '0')}`)
  }
  await request('unattributed', null)
  await event('unattributed-event', 'unattributed', usage(null), null, false)
  await request('unknown', null, {}, 'unknown')
}, 30000)
afterAll(async () => {
  await pool.end()
})
it('aggregates beyond 100 project groups and reconciles every known sum including unknown buckets', async () => {
  const first = await queryUsageAnalytics(pool, access, query)
  const second = await queryUsageAnalytics(pool, access, { ...query, offset: 100 })
  expect(first.totalGroups).toBe('107')
  expect(first.totals.requests).toBe('107')
  expect(first.groups).toHaveLength(100)
  expect(second.groups).toHaveLength(7)
  expect(second.totals).toEqual(first.totals)
  const groups = [...first.groups, ...second.groups]
  for (const name of ['input', 'output', 'cached', 'reasoning', 'total'] as const) {
    expect(groups.reduce((sum, g) => sum + BigInt(g.metrics.tokens[name].knownSum), 0n).toString()).toBe(
      first.totals.tokens[name].knownSum,
    )
    expect(first.totals.tokens[name].total).toBeNull()
  }
  for (const bucket of first.totals.money) {
    for (const name of ['charge', 'upstreamCost', 'margin'] as const) {
      const matching = groups.flatMap((g) => g.metrics.money.filter((m) => m.currency === bucket.currency))
      expect(matching.reduce((sum, m) => sum + BigInt(m[name].knownSum), 0n).toString()).toBe(bucket[name].knownSum)
    }
  }
  expect(first.totals.tokens.input).toEqual({ knownSum: '1050', unknownRequests: '2', total: null })
  expect(first.totals.tokens.total.knownSum).toBe('1575') // Cached/reasoning are subsets, not extra tokens.
  expect(groups.find((g) => g.key === '__unattributed__')?.metrics.tokens.input.total).toBeNull()
})
it('retains exact bigint money and token aggregates with independent currencies', async () => {
  await request('large-usd', 'p000', { charge_amount: '9007199254740993' })
  await event('large-usd-event', 'large-usd', usage('4503599627370496'))
  await request('large-eur', 'p000', { charge_amount: '9007199254740995', charge_currency: 'EUR' })
  await event('large-eur-event', 'large-eur', usage('4503599627370496'), null, true, 'EUR')
  const result = await queryUsageAnalytics(pool, access, { ...query, q: 'large-' })
  expect(result.totals.tokens.input).toEqual({
    knownSum: '9007199254740992',
    unknownRequests: '0',
    total: '9007199254740992',
  })
  expect(result.totals.tokens.total.total).toBe('9007199254741002')
  expect(result.totals.money.map((m) => [m.currency, m.charge.total])).toEqual([
    ['EUR', '9007199254740995'],
    ['USD', '9007199254740993'],
  ])
})
it('preserves historical attribution after same-organization key move and project rename', async () => {
  await insert('downstream_api_keys', {
    id: 'analytics-key',
    tenant_id: 'analytics',
    organization_id: 'analytics-org',
    project_id: 'p000',
    name: 'Key',
    hash: 'synthetic-hash',
    prefix: 'test',
  })
  await request('key-history', 'p000', { downstream_key_id: 'analytics-key' })
  await event('key-history-event', 'key-history')
  await pool.query(
    "UPDATE downstream_api_keys SET project_id='p001',name='Renamed key' WHERE id='analytics-key'; UPDATE projects SET name='Renamed project' WHERE id='p000'",
  )
  const result = await queryUsageAnalytics(pool, access, { ...query, apiKeyId: 'analytics-key' })
  expect(result.groups.map((g) => [g.key, g.label])).toEqual([['p000', 'Original p000']])
})
it('does not multiply or select superseded attempt usage even when that event arrives later', async () => {
  await request('retry', 'p001')
  for (const attempt_number of [1, 2])
    await insert('attempts', {
      id: `retry-${attempt_number}`,
      tenant_id: 'analytics',
      request_id: 'retry',
      attempt_number,
    })
  await event('retry-final', 'retry', usage('4'), 'retry-2')
  await event('retry-superseded', 'retry', usage('99999'), 'retry-1')
  const result = await queryUsageAnalytics(pool, access, { ...query, q: 'retry' })
  expect(result.totals.requests).toBe('1')
  expect(result.totals.tokens.input.total).toBe('4')
  expect(result.totals.money[0].charge.total).toBe('7')
})
it('applies every filter before all six grouping dimensions and preserves filtered totals', async () => {
  await pool.query(`INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('matrix-provider','matrix-code','Matrix','https://example.invalid','bearer');
    INSERT INTO provider_credentials(id,provider_id,name,encrypted_secret,is_platform_managed) VALUES ('matrix-credential','matrix-provider','Matrix','synthetic-envelope',true);
    INSERT INTO channels(id,provider_id,provider_credential_id,name) VALUES ('matrix-channel','matrix-provider','matrix-credential','Matrix');
    INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES ('matrix-connection','analytics','matrix-code','byok');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix) VALUES ('matrix-key','analytics','analytics-org','p002','Matrix','synthetic-matrix-hash','test')`)
  await request('matrix-request', 'p002', { downstream_key_id: 'matrix-key', started_at: '2026-01-20T00:00:00Z' })
  await insert('attempts', {
    id: 'matrix-attempt',
    request_id: 'matrix-request',
    tenant_id: 'analytics',
    provider_id: 'matrix-provider',
    provider_credential_id: 'matrix-credential',
    channel_id: 'matrix-channel',
    connection_id: 'matrix-connection',
    attempt_number: 1,
    resolved_model: 'matrix-model',
    execution_mode: 'managed',
    price_version_id: 'matrix-price',
    catalog_version_id: 'catalog',
  })
  await event('matrix-event', 'matrix-request', usage(), 'matrix-attempt')
  const filters = {
    projectId: 'p002',
    providerId: 'matrix-provider',
    provider: 'matrix-code',
    model: 'matrix-model',
    apiKeyId: 'matrix-key',
    connectionId: 'matrix-connection',
    executionMode: 'managed' as const,
    from: '2026-01-19T00:00:00Z',
    to: '2026-01-21T00:00:00Z',
  }
  for (const groupBy of ['project', 'provider', 'model', 'apiKey', 'connection', 'executionMode'] as const) {
    const result = await queryUsageAnalytics(pool, access, { ...query, ...filters, groupBy })
    expect(result.totals.requests).toBe('1')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].metrics).toEqual(result.totals)
  }
  for (const [field, value] of Object.entries({
    ...filters,
    executionMode: 'byok',
    from: '2026-01-21T00:00:00Z',
    to: '2026-01-19T00:00:00Z',
  })) {
    const miss = field === 'from' || field === 'to' || field === 'executionMode' ? value : 'nonmatching'
    expect((await queryUsageAnalytics(pool, access, { ...query, ...filters, [field]: miss })).totals.requests).toBe('0')
  }
})
it('paginates equal startedAt values by descending id and freezes late inserts with asOf', async () => {
  await request('a-newer', 'p001', { started_at: '2026-01-25T00:00:00Z' })
  await request('zzz-earlier', 'p001', { started_at: '2026-01-02T00:00:00Z' })
  const first = await queryUsageLogs(pool, access, { ...query, limit: 11 })
  await request('zz-late', 'p001', { created_at: '2026-02-02T00:00:00Z' })
  let page = first
  const ids: unknown[] = []
  do {
    ids.push(...page.entries.map((e) => e.id))
    if (!page.nextCursor) break
    page = await queryUsageLogs(pool, access, { ...query, limit: 11, cursor: page.nextCursor })
  } while (true)
  expect(ids).toHaveLength(Number(first.total))
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids[0]).toBe('a-newer')
  expect(ids.at(-1)).toBe('zzz-earlier')
  const middle = ids.filter((id) => !['a-newer', 'zzz-earlier', 'matrix-request'].includes(String(id)))
  expect(middle).toEqual([...middle].sort().reverse())
  expect(ids).not.toContain('zz-late')
})
it('resumes a default-asOf URL query with explicit timestamps and reordered parameters', async () => {
  const now = new Date(query.asOf)
  const firstQuery = parseUsageAnalyticsQuery(
    new URLSearchParams(`limit=3&from=${encodeURIComponent(query.from)}`),
    now,
  )
  const first = await queryUsageLogs(pool, access, firstQuery)
  expect(first.nextCursor).not.toBeNull()
  const reordered = new URLSearchParams({
    asOf: first.asOf,
    to: first.to,
    cursor: first.nextCursor!,
    from: first.from,
    limit: '3',
  })
  const second = await queryUsageLogs(pool, access, parseUsageAnalyticsQuery(reordered, now))
  expect(second.total).toBe(first.total)
  expect(second.entries).toHaveLength(3)
  expect(second.entries.map((e) => e.id).some((id) => first.entries.some((e) => e.id === id))).toBe(false)
})
it('rejects malformed and query-mismatched cursors with the analytics 400 error', async () => {
  const first = await queryUsageLogs(pool, access, { ...query, limit: 1 })
  for (const cursor of ['not-json', Buffer.from('null').toString('base64url'), first.nextCursor!]) {
    await expect(queryUsageLogs(pool, access, { ...query, providerId: 'different', cursor })).rejects.toBeInstanceOf(
      AnalyticsQueryError,
    )
  }
})
it('preserves v1 present zero and absent metrics without treating them as complete v2 usage', async () => {
  await request('legacy-presence', null, { execution_mode: null }, 'unknown')
  await insert('usage_events', {
    id: 'legacy-presence-event',
    tenant_id: 'analytics',
    request_id: 'legacy-presence',
    event_id: 'legacy-presence-event',
    event_type: 'usage',
    payload: JSON.stringify({
      event: {
        schema_version: 1,
        tenant_id: 'analytics',
        request_id: 'legacy-presence',
        usage: { input_tokens: 0, output_tokens: 5 },
      },
    }),
  })
  const result = await queryUsageAnalytics(pool, access, { ...query, q: 'legacy-presence' })
  expect(result.totals.tokens.input).toEqual({ knownSum: '0', unknownRequests: '0', total: '0' })
  expect(result.totals.tokens.output.total).toBe('5')
  for (const name of ['cached', 'reasoning', 'total'] as const)
    expect(result.totals.tokens[name]).toEqual({ knownSum: '0', unknownRequests: '1', total: null })
})
it('does not promote a canonical reconciliation anchor without the frozen request fact', async () => {
  await request('missing-frozen-anchor', null, {}, 'unknown')
  const canonical = {
    schema_version: 2,
    event_id: 'missing-frozen-event',
    occurred_at: '2026-01-15T00:00:00Z',
    tenant_id: 'analytics',
    organization_id: 'analytics-org',
    request_id: 'missing-frozen-anchor',
    attempt_id: 'missing-attempt',
    model_id: 'model',
    provider_id: 'provider',
    requested_model: 'model',
    resolved_model: 'model',
    streaming: false,
    status: 'completed',
    price_version_id: 'price',
    catalog_version_id: 'catalog',
    policy_version_id: null,
    usage: usage('999'),
    attribution: {
      project_id: null,
      project_name: null,
      api_key_id: null,
      key_kind: 'unknown',
      principal_id: null,
      connection_id: null,
      credential_id: null,
      channel_id: null,
      execution_mode: 'managed',
      attribution_status: 'unattributed',
    },
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    expect(
      await processOutboxEvent(client, {
        id: 'missing-frozen-outbox',
        tenant_id: 'analytics',
        aggregate_type: 'usage',
        aggregate_id: 'missing-frozen-anchor',
        event_type: 'usage.v2.completed',
        payload: canonical,
        idempotency_key: 'missing-frozen-event',
        attempts: 0,
      }),
    ).toMatchObject({ disposition: 'reconciled', detail: 'missing_attribution' })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  expect(
    (await pool.query("SELECT count(*) FROM usage_records WHERE request_id='missing-frozen-anchor'")).rows[0].count,
  ).toBe('0')
  const result = await queryUsageAnalytics(pool, access, { ...query, q: 'missing-frozen-anchor' })
  expect(result.totals.requests).toBe('1')
  expect(result.totals.tokens.input).toEqual({ knownSum: '0', unknownRequests: '1', total: null })
  expect(result.groups[0].key).toBe('__unknown__')
})
it('aggregates 10000 request facts and can record the actual execution plan', async () => {
  await pool.query(
    `INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,started_at,created_at) SELECT 'plan-'||i,'analytics','analytics-org','plan-model','byok','2026-01-16'::timestamptz,'2026-01-16'::timestamptz FROM generate_series(1,10000) i`,
  )
  await pool.query(`INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status) SELECT 'plan-'||i,'analytics','analytics-org','p'||lpad((i%105)::text,3,'0'),'Plan project','byok','attributed' FROM generate_series(1,10000) i;
    INSERT INTO attempts(id,tenant_id,request_id,attempt_number) SELECT 'plan-attempt-'||i,'analytics','plan-'||i,1 FROM generate_series(1,10000) i;
    INSERT INTO usage_events(id,tenant_id,request_id,attempt_id,event_id,event_type,payload) SELECT 'plan-event-'||i,'analytics','plan-'||i,'plan-attempt-'||i,'plan-event-'||i,'usage',jsonb_build_object('event',jsonb_build_object('schema_version',2,'tenant_id','analytics','request_id','plan-'||i,'usage',jsonb_build_object('input_tokens',10,'output_tokens',5,'cached_input_tokens',3,'reasoning_tokens',2,'total_tokens',15))) FROM generate_series(1,10000) i`)
  await pool.query(
    'ANALYZE request_records; ANALYZE attempts; ANALYZE usage_events; ANALYZE usage_records; ANALYZE request_project_facts',
  )
  let plan: unknown
  let statement: { sql: string; values?: unknown[] } | undefined
  const measured: AnalyticsDatabase = {
    async query<T>(sql: string, values?: unknown[]) {
      statement = { sql, values }
      if (process.env.ANALYTICS_EXPLAIN_ARTIFACT)
        plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN']
      return { rows: (await pool.query(sql, values)).rows as T[] }
    },
  }
  const result = await queryUsageAnalytics(measured, access, { ...query, model: 'plan-model' })
  expect(result.totals.requests).toBe('10000')
  expect(result.totals.tokens.total.total).toBe('150000')
  if (!process.env.ANALYTICS_EXPLAIN_ARTIFACT) return
  mkdirSync(process.env.ANALYTICS_EXPLAIN_ARTIFACT, { recursive: true })
  writeFileSync(
    `${process.env.ANALYTICS_EXPLAIN_ARTIFACT}/analytics-explain-final.json`,
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        requests: 10000,
        query: 'queryUsageAnalytics model=plan-model groupBy=project',
        statement,
        indexes: (
          await pool.query(
            "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('request_records','attempts','usage_events','usage_records','request_project_facts') ORDER BY indexname",
          )
        ).rows,
        plan,
      },
      null,
      2,
    ) + '\n',
  )
}, 120000)
it('keeps absent currency dimensions and BYOK margin distinct from reported zero and unknown prices', async () => {
  for (const id of ['absent-money-dimension', 'absent-money-dimension-unsettled'])
    await request(id, 'p000', {
      channel_kind: 'byok',
      execution_mode: 'byok',
      charge_currency: 'USD',
      charge_amount: '0',
      gross_margin_amount: '0',
    })
  await event('absent-money-event', 'absent-money-dimension', usage(), null, true, 'CNY', '0')
  const result = await queryUsageAnalytics(pool, access, { ...query, q: 'absent-money-dimension' })
  const absent = { knownSum: '0', unknownRequests: '0', total: null, hasFacts: false }
  const expected = [
    {
      currency: null,
      charge: absent,
      upstreamCost: { knownSum: '0', unknownRequests: '1', total: null },
      margin: absent,
    },
    {
      currency: 'CNY',
      charge: absent,
      upstreamCost: { knownSum: '0', unknownRequests: '0', total: '0' },
      margin: absent,
    },
    {
      currency: 'USD',
      charge: { knownSum: '0', unknownRequests: '1', total: null },
      upstreamCost: absent,
      margin: absent,
    },
  ]
  expect(result.totals.money).toEqual(expected)
  expect(result.groups[0].metrics.money).toEqual(expected)
})
