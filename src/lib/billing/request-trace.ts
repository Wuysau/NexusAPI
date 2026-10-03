import type { AnalyticsAccess } from './analytics-access'
import { realGatewayRequest } from './evidence'
import {
  MAX_REQUEST_TRACE_ATTEMPTS,
  REQUEST_TRACE_VERSION,
  isRequestTraceId,
  traceErrorCode,
  validateRequestTrace,
  type RequestTrace,
  type RequestTraceAttempt,
  type TracePins,
  type TraceSettlement,
  type TraceTiming,
  type TraceUsage,
} from '../../../packages/contracts/request-trace'

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
interface MeteringRow {
  usage_source: TraceUsage['source']
  schema_version: '1' | '2' | null
  usage_event_id: string | null
  input_tokens: string | null
  output_tokens: string | null
  cached_input_tokens: string | null
  reasoning_tokens: string | null
  total_tokens: string | null
  estimated: boolean | null
  usage_record_id: string | null
  charge_micros: string | null
  charge_currency: string | null
  upstream_cost_micros: string | null
  upstream_cost_currency: string | null
}
interface TimedRow {
  started_at: Date | string
  completed_at: Date | string | null
}
interface PinnedRow {
  policy_version_id: string | null
  catalog_version_id: string | null
  price_version_id: string | null
}
interface RequestRow extends MeteringRow, TimedRow, PinnedRow {
  id: string
  trace_id: string | null
  organization_id: string
  project_id: string | null
  project_name: string | null
  attribution_status: RequestTrace['request']['project']['attributionStatus']
  api_key_id: string | null
  requested_model: string
  status: RequestTrace['request']['status']
  error_code: string | null
}
interface AttemptRow extends MeteringRow, TimedRow, PinnedRow {
  id: string
  attempt_number: number
  status: RequestTraceAttempt['status']
  provider_id: string | null
  resolved_model: string | null
  channel_id: string | null
  connection_id: string | null
  execution_mode: string | null
  upstream_request_id: string | null
  error_code: string | null
}

// Keep the existing analytics trust anchors: Worker metering first; the event
// row must match this tenant/request/attempt, its envelope tenant/request and
// supported schema must match, and observed v2 requires both frozen facts and
// a recorded attempt. A Worker v2 anchor also requires the frozen request fact.
// Never join current Keys, Connections, Projects or credential secret records.
const meteringJoins = `
  LEFT JOIN LATERAL (
    SELECT ur.id,ur.usage_event_id,ur.authoritative_metering authoritative,
      ur.charge_amount,ur.charge_currency,ur.upstream_cost_amount,ur.upstream_cost_currency
    FROM usage_records ur
    JOIN usage_events ue ON ue.id=ur.usage_event_id AND ue.tenant_id=ur.tenant_id AND ue.request_id=ur.request_id
    WHERE ur.tenant_id=r.tenant_id AND ur.request_id=r.id
      AND (ue.attempt_id=a.id OR (ue.attempt_id IS NULL AND a.id IS NULL))
      AND (ur.authoritative_metering->>'schema_version' IS DISTINCT FROM '2' OR f.request_id IS NOT NULL)
    ORDER BY ur.created_at DESC,ur.id DESC LIMIT 1
  ) u ON true
  LEFT JOIN LATERAL (
    SELECT ue.id,ue.payload->'event' event FROM usage_events ue
    WHERE ue.tenant_id=r.tenant_id AND ue.request_id=r.id
      AND (ue.attempt_id=a.id OR (ue.attempt_id IS NULL AND a.id IS NULL))
      AND ue.payload->'event'->>'tenant_id'=r.tenant_id
      AND ue.payload->'event'->>'request_id'=r.id
      AND ue.payload->'event'->>'schema_version' IN ('1','2')
      AND (ue.payload->'event'->>'schema_version'='1' OR (f.request_id IS NOT NULL AND a.id IS NOT NULL))
    ORDER BY ue.created_at DESC,ue.id DESC LIMIT 1
  ) e ON true
  CROSS JOIN LATERAL (SELECT coalesce(u.authoritative,e.event) value) c`

function tokenColumn(name: string, alias: string, v2Only = false) {
  const path = `c.value->'usage'->>'${name}'`
  // Extract only bounded exact integers. Malformed diagnostic payloads cannot
  // force numeric casts or escape as arbitrary content in a public field.
  return `CASE WHEN c.value->>'schema_version' ${v2Only ? "='2'" : "IN ('1','2')"}
    AND ${path} ~ '^(0|[1-9][0-9]{0,98})$' THEN ${path} END ${alias}`
}
const usageColumns = `
  CASE WHEN c.value->>'schema_version' IN ('1','2') THEN
    CASE WHEN u.authoritative IS NOT NULL THEN 'worker' ELSE 'event' END END usage_source,
  CASE WHEN c.value->>'schema_version' IN ('1','2') THEN c.value->>'schema_version' END schema_version,
  CASE WHEN c.value->>'schema_version' IN ('1','2') THEN
    CASE WHEN u.authoritative IS NOT NULL THEN u.usage_event_id ELSE e.id END END usage_event_id,
  ${tokenColumn('input_tokens', 'input_tokens')},${tokenColumn('output_tokens', 'output_tokens')},
  ${tokenColumn('cached_input_tokens', 'cached_input_tokens')},${tokenColumn('reasoning_tokens', 'reasoning_tokens')},
  ${tokenColumn('total_tokens', 'total_tokens', true)},
  CASE WHEN c.value->>'schema_version' IN ('1','2') AND c.value->'usage'->>'estimated' IN ('true','false')
    THEN (c.value->'usage'->>'estimated')::boolean END estimated,
  u.id usage_record_id,u.upstream_cost_amount::text upstream_cost_micros,
  u.upstream_cost_currency`

function timing(row: TimedRow): TraceTiming {
  const startedAt = new Date(row.started_at).toISOString()
  const completedAt = row.completed_at === null ? null : new Date(row.completed_at).toISOString()
  return {
    startedAt,
    completedAt,
    durationMs: completedAt === null ? null : Date.parse(completedAt) - Date.parse(startedAt),
    ttftMs: null,
    streamDurationMs: null,
  }
}
const pins = (row: PinnedRow): TracePins => ({
  policyVersionId: row.policy_version_id,
  catalogVersionId: row.catalog_version_id,
  priceVersionId: row.price_version_id,
})
const usage = (row: MeteringRow): TraceUsage => ({
  source: row.usage_source,
  schemaVersion: row.schema_version === null ? null : row.schema_version === '1' ? 1 : 2,
  usageEventId: row.usage_event_id,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedInputTokens: row.cached_input_tokens,
  reasoningTokens: row.reasoning_tokens,
  totalTokens: row.total_tokens,
  estimated: row.estimated,
})
const settlement = (row: MeteringRow): TraceSettlement | null =>
  row.usage_record_id === null
    ? null
    : {
        usageRecordId: row.usage_record_id,
        chargeMicros: row.charge_micros,
        chargeCurrency: row.charge_currency,
        upstreamCostMicros: row.upstream_cost_micros,
        upstreamCostCurrency: row.upstream_cost_currency,
      }

/** Caller owns a repeatable-read READ ONLY transaction. Two reads, no N+1. */
export async function readRequestTrace(
  client: Queryable,
  access: AnalyticsAccess,
  requestId: string,
): Promise<RequestTrace | null> {
  if (!isRequestTraceId(requestId)) return null
  const values: unknown[] = [access.tenantId, requestId]
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const scope =
    access.organizations
      .map(
        (org) =>
          `(r.organization_id=${bind(org.organizationId)}${org.allProjects ? '' : ` AND f.project_id=ANY(${bind(org.projectIds)}::text[])`})`,
      )
      .join(' OR ') || 'false'
  const request = (
    await client.query<RequestRow>(
      `
    SELECT r.id,r.trace_id,r.organization_id,r.status,r.error_code,r.started_at,r.completed_at,
      f.project_id,f.project_name,coalesce(f.attribution_status,'unknown') attribution_status,
      coalesce(f.api_key_id,r.downstream_key_id) api_key_id,coalesce(f.requested_model,r.request_model) requested_model,
      f.policy_version_id,f.catalog_version_id,f.price_version_id,
      ${usageColumns},CASE WHEN u.id IS NOT NULL THEN r.charge_amount::text END charge_micros,
      CASE WHEN u.id IS NOT NULL THEN r.charge_currency END charge_currency
    FROM request_records r
    LEFT JOIN request_project_facts f ON f.request_id=r.id AND f.tenant_id=r.tenant_id AND f.organization_id=r.organization_id
    LEFT JOIN LATERAL (
      SELECT aa.id FROM attempts aa WHERE aa.tenant_id=r.tenant_id AND aa.request_id=r.id
      ORDER BY aa.attempt_number DESC,aa.id DESC LIMIT 1
    ) a ON true
    ${meteringJoins}
    WHERE r.tenant_id=$1 AND r.id=$2 AND (${scope}) AND ${realGatewayRequest}
  `,
      values,
    )
  ).rows[0]
  if (!request) return null

  const page = (
    await client.query<{ total: string; entries: AttemptRow[] }>(
      `
    WITH recorded AS MATERIALIZED (
      SELECT a.id,a.attempt_number,a.status,a.provider_id,a.resolved_model,a.channel_id,a.connection_id,
        a.execution_mode,a.upstream_request_id,a.error_code,a.started_at,a.completed_at,
        a.policy_version_id,a.catalog_version_id,a.price_version_id
      FROM attempts a WHERE a.tenant_id=$1 AND a.request_id=$2
    ), page AS (SELECT * FROM recorded ORDER BY attempt_number,id COLLATE "C" LIMIT $4), details AS (
      SELECT a.*,${usageColumns},u.charge_amount::text charge_micros,u.charge_currency
      FROM page a JOIN request_records r ON r.id=$2 AND r.tenant_id=$1 AND r.organization_id=$3
      LEFT JOIN request_project_facts f ON f.request_id=r.id AND f.tenant_id=r.tenant_id AND f.organization_id=r.organization_id
      ${meteringJoins}
    ) SELECT (SELECT count(*)::text FROM recorded) total,
      coalesce((SELECT jsonb_agg(to_jsonb(details) ORDER BY attempt_number,id COLLATE "C") FROM details),'[]'::jsonb) entries
  `,
      [access.tenantId, requestId, request.organization_id, MAX_REQUEST_TRACE_ATTEMPTS],
    )
  ).rows[0]
  const result: RequestTrace = {
    version: REQUEST_TRACE_VERSION,
    coverage: 'recorded_gateway_attempts',
    request: {
      id: request.id,
      traceId: request.trace_id,
      organizationId: request.organization_id,
      project: { id: request.project_id, name: request.project_name, attributionStatus: request.attribution_status },
      apiKeyId: request.api_key_id,
      requestedModel: request.requested_model,
      status: request.status,
      errorCode: traceErrorCode(request.error_code),
      timing: timing(request),
      pins: pins(request),
      usage: usage(request),
      settlement: settlement(request),
      taskId: null,
      sessionId: null,
    },
    attempts: page.entries.map((row) => ({
      id: row.id,
      number: row.attempt_number,
      status: row.status,
      providerId: row.provider_id,
      resolvedModel: row.resolved_model,
      channelId: row.channel_id,
      connectionId: row.connection_id,
      executionMode: row.execution_mode === 'managed' || row.execution_mode === 'byok' ? row.execution_mode : 'unknown',
      providerRequestId: row.upstream_request_id,
      errorCode: traceErrorCode(row.error_code),
      timing: timing(row),
      pins: pins(row),
      usage: usage(row),
      settlement: settlement(row),
    })),
    attemptCount: page.total,
    attemptLimit: MAX_REQUEST_TRACE_ATTEMPTS,
    truncated: BigInt(page.total) > BigInt(MAX_REQUEST_TRACE_ATTEMPTS),
  }
  if (!validateRequestTrace(result)) throw new Error('Invalid recorded request trace')
  return result
}
