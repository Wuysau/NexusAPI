import { expect, it, vi } from 'vitest'
import { readRequestTrace } from './request-trace'
import type { AnalyticsAccess } from './analytics-access'

const access: AnalyticsAccess = {
  tenantId: 'tenant',
  organizations: [{ organizationId: 'org', allProjects: false, projectIds: ['frozen-project'] }],
  financialOrganizationId: null,
}
const unknown = {
  usage_source: null,
  schema_version: null,
  usage_event_id: null,
  input_tokens: null,
  output_tokens: null,
  cached_input_tokens: null,
  reasoning_tokens: null,
  total_tokens: null,
  estimated: null,
  usage_record_id: null,
  charge_micros: null,
  charge_currency: null,
  upstream_cost_micros: null,
  upstream_cost_currency: null,
}
const interval = {
  started_at: new Date('2026-10-04T00:00:00Z'),
  completed_at: null,
  policy_version_id: 'policy',
  catalog_version_id: 'catalog',
  price_version_id: 'price',
}
const request = {
  ...unknown,
  ...interval,
  id: 'request',
  trace_id: 'trace',
  organization_id: 'org',
  project_id: 'frozen-project',
  project_name: 'Original project',
  attribution_status: 'attributed',
  api_key_id: 'key',
  requested_model: 'alias',
  status: 'sent',
  error_code: null,
}
const attempt = {
  ...unknown,
  ...interval,
  id: 'attempt',
  attempt_number: 1,
  status: 'sent',
  provider_id: 'provider',
  resolved_model: 'actual-model',
  channel_id: 'channel',
  connection_id: 'connection',
  execution_mode: 'byok',
  upstream_request_id: 'provider-request',
  error_code: 'untrusted error body',
}
function client(entries: unknown[] = [attempt], total = String(entries.length)) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [request] })
    .mockResolvedValueOnce({ rows: [{ total, entries }] })
  return { query }
}

it('uses two bounded read queries with historical tenant/project scope and no live resource identity', async () => {
  const database = client()
  const result = await readRequestTrace(database, access, "request'OR'1'='1")
  expect(database.query).toHaveBeenCalledTimes(2)
  expect(database.query.mock.calls[0][1]).toEqual(['tenant', "request'OR'1'='1", 'org', ['frozen-project']])
  expect(database.query.mock.calls[1][1]).toEqual(['tenant', "request'OR'1'='1", 'org', 128])
  const sql = database.query.mock.calls.map(([statement]) => String(statement)).join('\n')
  expect(sql).not.toContain("request'OR")
  expect(sql).toContain('f.project_id=ANY($4::text[])')
  expect(sql).toContain('a.tenant_id=$1 AND a.request_id=$2')
  expect(sql).toContain('ue.tenant_id=r.tenant_id AND ue.request_id=r.id')
  expect(sql).toContain('ue.attempt_id=a.id')
  expect(sql).toContain("ue.payload->'event'->>'tenant_id'=r.tenant_id")
  expect(sql).toContain("ue.payload->'event'->>'request_id'=r.id")
  expect(sql).toContain('coalesce(u.authoritative,e.event)')
  for (const table of ['projects', 'owned_connections', 'provider_credentials', 'downstream_api_keys'])
    expect(sql).not.toMatch(new RegExp(`JOIN ${table}\\b`))
  for (const column of ['error_message', 'credential_ref', 'frozen_pricing', 'legacy_input'])
    expect(sql).not.toContain(column)
  expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|FOR UPDATE)\b/)
  expect(result?.attempts[0]).toMatchObject({
    errorCode: null,
    resolvedModel: 'actual-model',
    usage: { inputTokens: null },
    settlement: null,
  })
})
it('stops before child reads for hidden requests and malformed IDs', async () => {
  const database = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  expect(await readRequestTrace(database, access, 'hidden')).toBeNull()
  expect(database.query).toHaveBeenCalledTimes(1)
  database.query.mockClear()
  for (const value of ['', 'x'.repeat(129), 'with space'])
    expect(await readRequestTrace(database, access, value)).toBeNull()
  expect(database.query).not.toHaveBeenCalled()
})
it('constrains an empty access scope to false instead of widening visibility', async () => {
  const database = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  await readRequestTrace(database, { ...access, organizations: [] }, 'hidden')
  expect(database.query.mock.calls[0][0]).toContain('AND (false)')
})
it('binds every eligible tenant organization with its own historical project rule', async () => {
  const database = { query: vi.fn().mockResolvedValue({ rows: [] }) }
  await readRequestTrace(
    database,
    {
      ...access,
      organizations: [
        { organizationId: 'org-owner', allProjects: true, projectIds: [] },
        { organizationId: 'org-viewer', allProjects: false, projectIds: ['historical-a', 'historical-b'] },
      ],
    },
    'request',
  )
  expect(database.query.mock.calls[0][1]).toEqual([
    'tenant',
    'request',
    'org-owner',
    'org-viewer',
    ['historical-a', 'historical-b'],
  ])
  expect(database.query.mock.calls[0][0]).toContain(
    '(r.organization_id=$3) OR (r.organization_id=$4 AND f.project_id=ANY($5::text[]))',
  )
})
it('maps exact canonical values, known zero settlement and recorded intervals without copying request usage', async () => {
  const last = {
    ...attempt,
    id: 'attempt-final',
    attempt_number: 2,
    completed_at: new Date('2026-10-04T00:00:02.500Z'),
    usage_source: 'worker',
    schema_version: '2',
    usage_event_id: 'event',
    input_tokens: '9007199254740993',
    output_tokens: '0',
    total_tokens: '9007199254740993',
    estimated: false,
    usage_record_id: 'record',
    charge_micros: '0',
    charge_currency: 'USD',
    upstream_cost_micros: '0',
    upstream_cost_currency: 'CNY',
  }
  const database = client([attempt, last])
  const result = await readRequestTrace(database, access, 'request')
  expect(result?.attempts[0].usage.inputTokens).toBeNull()
  expect(result?.attempts[1]).toMatchObject({
    timing: { durationMs: 2500, ttftMs: null, streamDurationMs: null },
    usage: { source: 'worker', schemaVersion: 2, inputTokens: '9007199254740993', outputTokens: '0' },
    settlement: { usageRecordId: 'record', chargeMicros: '0' },
  })
  expect(result?.request.usage.inputTokens).toBeNull()
})
it('rejects unexpected projection fields rather than returning unsafe data', async () => {
  const database = client([
    { ...attempt, usage_source: 'worker', schema_version: '2', usage_event_id: 'event', input_tokens: '1.5' },
  ])
  await expect(readRequestTrace(database, access, 'request')).rejects.toThrow('Invalid recorded request trace')
})
