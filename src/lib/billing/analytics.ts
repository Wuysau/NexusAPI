import { createHash } from 'node:crypto'
import type {
  AnalyticsQuery,
  AnalyticsMetrics,
  ExactMetric,
  UsageAnalyticsResponse,
  AnalyticsCurrencyMetrics,
} from '../../../packages/contracts/usage-analytics'
import {
  AnalyticsQueryError,
  MAX_ANALYTICS_OFFSET,
  parseUsageAnalyticsQuery,
} from '../../../packages/contracts/usage-analytics'
import type { AnalyticsAccess } from './analytics-access'
import { realGatewayRequest } from './evidence'

export interface AnalyticsDatabase {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const emptyMetric = (): ExactMetric => ({ knownSum: '0', unknownRequests: '0', total: '0' })
const tokenNames = ['input', 'output', 'cached', 'reasoning', 'total'] as const

/** One request is one row. Neither retries nor multiple usage anchors multiply it. */
export function buildAnalyticsFacts(access: AnalyticsAccess, q: AnalyticsQuery, includeObserved = false) {
  const values: unknown[] = [access.tenantId, q.from, q.to, q.asOf]
  const bind = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }
  const scope =
    access.organizations
      .map(
        (org) =>
          `(r.organization_id=${bind(org.organizationId)}${org.allProjects ? '' : ` AND f.project_id=ANY(${bind(org.projectIds)}::text[])`})`,
      )
      .join(' OR ') || 'false'
  const filters = [
    realGatewayRequest,
    `r.tenant_id=$1`,
    `r.started_at>=$2::timestamptz`,
    `r.started_at<$3::timestamptz`,
    `r.created_at<=$4::timestamptz`,
    `(${scope})`,
  ]
  if (q.projectId === '__unknown__') filters.push("coalesce(f.attribution_status,'unknown')='unknown'")
  else if (q.projectId === '__unattributed__') filters.push("f.attribution_status='unattributed'")
  else if (q.projectId) filters.push(`f.project_id=${bind(q.projectId)}`)
  const post: string[] = []
  for (const [field, column] of [
    ['providerId', 'provider_id'],
    ['model', 'model'],
    ['apiKeyId', 'api_key_id'],
    ['connectionId', 'connection_id'],
    ['executionMode', 'execution_mode'],
  ] as const) {
    if (q[field]) post.push(`${column}=${bind(q[field])}`)
  }
  if (q.provider) post.push(`provider_code=${bind(q.provider)}`)
  if (!includeObserved || !q.usageSource || q.usageSource === 'gateway') post.push("usage_source='gateway'")
  else if (q.usageSource !== 'all') post.push(`usage_source=${bind(q.usageSource)}`)
  if (q.authority) post.push(`authority=${bind(q.authority)}`)
  const externalFilters = [
    `e.tenant_id=$1`,
    `e.occurred_at>=$2::timestamptz`,
    `e.occurred_at<$3::timestamptz`,
    `e.created_at<=$4::timestamptz`,
    `(${scope.replaceAll('r.organization_id', 'e.organization_id').replaceAll('f.project_id', 'e.project_id')})`,
  ]
  if (!includeObserved || q.status === 'error') externalFilters.push('false')
  if (q.projectId === '__unknown__') externalFilters.push('false')
  else if (q.projectId === '__unattributed__') externalFilters.push('e.project_id IS NULL')
  else if (q.projectId) externalFilters.push(`e.project_id=${bind(q.projectId)}`)
  if (q.status === 'success') filters.push("r.status IN ('completed','reconciled')")
  if (q.status === 'error') filters.push("r.status IN ('failed','unknown')")
  if (q.q) {
    const pattern = bind(`%${q.q.replace(/[\\%_]/g, '\\$&').toLowerCase()}%`)
    post.push(
      `(lower(requested_model) LIKE ${pattern} ESCAPE '\\' OR lower(coalesce(api_key_id,'')) LIKE ${pattern} ESCAPE '\\' OR lower(id) LIKE ${pattern} ESCAPE '\\')`,
    )
  }
  // Worker persists settlement metering only after frozen-authority validation.
  // Its non-settled anchors also include missing-attribution cases: those must
  // have both captured facts before being usable as observed v2 usage here.
  const raw = `WITH raw_facts AS (
    SELECT r.id,r.tenant_id,r.organization_id,r.started_at,r.completed_at,r.status,r.error_code,
      coalesce(f.requested_model,r.request_model) requested_model,
      coalesce(a.resolved_model,r.resolved_upstream_model_id,r.request_model) model,
      coalesce(a.provider_id,r.resolved_provider_id) provider_id,
      f.project_id,f.project_name,coalesce(f.attribution_status,'unknown') attribution_status,
      coalesce(f.api_key_id,r.downstream_key_id) api_key_id,a.connection_id,
      coalesce(a.execution_mode,f.execution_mode,CASE WHEN r.channel_kind='platform' THEN 'managed' ELSE 'byok' END) execution_mode,
      r.input_tokens legacy_input,r.output_tokens legacy_output,r.cached_tokens legacy_cached,r.reasoning_tokens legacy_reasoning,
      (coalesce(to_jsonb(r)->>'execution_mode','unknown') IN ('managed','byok')) captured_v2,
      coalesce(u.authoritative,e.event) canonical,
      r.charge_currency,u.upstream_cost_currency,
      CASE WHEN u.id IS NOT NULL THEN r.charge_amount::numeric END charge,
      CASE WHEN u.id IS NOT NULL THEN u.upstream_cost_amount::numeric END upstream_cost,
      CASE WHEN u.id IS NOT NULL THEN r.gross_margin_amount::numeric END margin,
      (coalesce(u.authoritative,e.event)->'usage'->>'estimated')::boolean estimated
    FROM request_records r
    LEFT JOIN request_project_facts f ON f.request_id=r.id AND f.tenant_id=r.tenant_id AND f.organization_id=r.organization_id
    LEFT JOIN LATERAL (SELECT * FROM attempts aa WHERE aa.tenant_id=r.tenant_id AND aa.request_id=r.id ORDER BY attempt_number DESC,id DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (
      SELECT ur.id,to_jsonb(ur)->'authoritative_metering' authoritative,ur.upstream_cost_amount,ur.upstream_cost_currency
      FROM usage_records ur JOIN usage_events ue ON ue.id=ur.usage_event_id AND ue.tenant_id=ur.tenant_id AND ue.request_id=ur.request_id
      WHERE ur.tenant_id=r.tenant_id AND ur.request_id=r.id AND (ue.attempt_id=a.id OR (ue.attempt_id IS NULL AND a.id IS NULL))
        AND (to_jsonb(ur)->'authoritative_metering'->>'schema_version' IS DISTINCT FROM '2' OR f.request_id IS NOT NULL)
      ORDER BY ur.created_at DESC,ur.id DESC LIMIT 1
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT ue.payload->'event' event FROM usage_events ue
      WHERE ue.tenant_id=r.tenant_id AND ue.request_id=r.id AND (ue.attempt_id=a.id OR (ue.attempt_id IS NULL AND a.id IS NULL))
        AND ue.payload->'event'->>'tenant_id'=r.tenant_id AND ue.payload->'event'->>'request_id'=r.id
        AND ue.payload->'event'->>'schema_version' IN ('1','2')
        AND (ue.payload->'event'->>'schema_version'='1' OR (f.request_id IS NOT NULL AND a.id IS NOT NULL))
      ORDER BY ue.created_at DESC,ue.id DESC LIMIT 1
    ) e ON true
    WHERE ${filters.join(' AND ')}
  ), observed AS (
    SELECT *,
      CASE WHEN canonical->>'schema_version' IN ('1','2') THEN (canonical->'usage'->>'input_tokens')::numeric WHEN NOT captured_v2 THEN nullif(legacy_input,0)::numeric END input,
      CASE WHEN canonical->>'schema_version' IN ('1','2') THEN (canonical->'usage'->>'output_tokens')::numeric WHEN NOT captured_v2 THEN nullif(legacy_output,0)::numeric END output,
      CASE WHEN canonical->>'schema_version' IN ('1','2') THEN (canonical->'usage'->>'cached_input_tokens')::numeric WHEN NOT captured_v2 THEN nullif(legacy_cached,0)::numeric END cached,
      CASE WHEN canonical->>'schema_version' IN ('1','2') THEN (canonical->'usage'->>'reasoning_tokens')::numeric WHEN NOT captured_v2 THEN nullif(legacy_reasoning,0)::numeric END reasoning,
      CASE WHEN canonical->>'schema_version'='2' THEN (canonical->'usage'->>'total_tokens')::numeric END total
    FROM raw_facts
  ), activity AS (
    SELECT id,tenant_id,organization_id,started_at,completed_at,status::text status,error_code,requested_model,model,provider_id,
      (SELECT code FROM providers WHERE id=observed.provider_id) provider_code,
      project_id,project_name,attribution_status,api_key_id,connection_id,execution_mode,input,output,cached,reasoning,total,
      charge_currency,upstream_cost_currency,charge,upstream_cost,margin,estimated,
      'gateway'::text usage_source,'authoritative'::text authority,NULL::text external_session_id,NULL::text subscription_product
    FROM observed
    UNION ALL
    SELECT e.id,e.tenant_id,e.organization_id,e.occurred_at,e.occurred_at,'observed',NULL,e.model,e.model,e.provider,e.provider,
      e.project_id,e.project_name,CASE WHEN e.project_id IS NULL THEN 'unattributed' ELSE 'attributed' END,NULL,e.connection_id,'interactive',
      e.input_tokens,e.output_tokens,e.cached_input_tokens,e.reasoning_tokens,e.total_tokens,
      NULL,NULL,NULL::numeric,NULL::numeric,NULL::numeric,false,
      e.usage_source,e.authority,e.external_session_id,e.subscription_product
    FROM external_observed_usage e WHERE ${externalFilters.join(' AND ')}
  ), scoped AS MATERIALIZED (SELECT * FROM activity ${post.length ? 'WHERE ' + post.join(' AND ') : ''})`
  return { sql: raw, values }
}

function metricSQL(column: string) {
  return `jsonb_build_object('knownSum',coalesce(sum(${column}),0)::text,'unknownRequests',count(*) FILTER(WHERE ${column} IS NULL)::text,'total',CASE WHEN count(*) FILTER(WHERE ${column} IS NULL)=0 THEN coalesce(sum(${column}),0)::text ELSE NULL END)`
}
const tokenSQL = () => `jsonb_build_object(${tokenNames.map((name) => `'${name}',${metricSQL(name)}`).join(',')})`
const activityColumns = () => `count(*) FILTER(WHERE usage_source='gateway')::text requests,
  count(DISTINCT (usage_source,external_session_id)) FILTER(WHERE external_session_id IS NOT NULL)::text sessions,
  count(*) FILTER(WHERE authority='client_observed')::text "observedEvents",
  max(started_at) "lastActivity"`
export function analyticsGrouping(q: AnalyticsQuery) {
  switch (q.groupBy) {
    case 'project':
      return {
        key: "coalesce(project_id,CASE WHEN attribution_status='unattributed' THEN '__unattributed__' ELSE '__unknown__' END)",
        label: 'project_name',
      }
    case 'provider':
      return { key: "coalesce(provider_id,'__unknown__')", label: 'provider_id' }
    case 'model':
      return { key: "coalesce(model,'__unknown__')", label: 'model' }
    case 'apiKey':
      return { key: "coalesce(api_key_id,'__unknown__')", label: 'api_key_id' }
    case 'connection':
      return { key: "coalesce(connection_id,'__unknown__')", label: 'connection_id' }
    case 'executionMode':
      return { key: "coalesce(execution_mode,'unknown')", label: 'execution_mode' }
    case 'usageSource':
      return { key: 'usage_source', label: 'usage_source' }
    case 'subscription':
      return { key: "coalesce(subscription_product,'__unknown__')", label: 'subscription_product' }
    case 'day':
      return {
        key: "to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD')",
        label: "to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD')",
      }
  }
}

export async function queryUsageAnalytics(
  client: AnalyticsDatabase,
  access: AnalyticsAccess,
  q: AnalyticsQuery,
): Promise<UsageAnalyticsResponse> {
  const facts = buildAnalyticsFacts(access, q, true),
    group = analyticsGrouping(q)
  const values = [...facts.values, q.limit, q.offset]
  const sql = `${facts.sql}, keyed AS (SELECT *,${group.key} group_key,${group.label} group_label FROM scoped),
    grouped AS (SELECT group_key key,max(group_label) label,${activityColumns()},${tokenSQL()} tokens FROM keyed GROUP BY group_key),
    page AS (SELECT * FROM grouped ORDER BY key LIMIT $${values.length - 1} OFFSET $${values.length}),
    money_rows AS (
      SELECT group_key,charge_currency currency,'charge' kind,charge amount FROM keyed WHERE usage_source='gateway'
      UNION ALL SELECT group_key,upstream_cost_currency,'upstreamCost',upstream_cost FROM keyed WHERE usage_source='gateway'
      UNION ALL SELECT group_key,charge_currency,'margin',margin FROM keyed WHERE execution_mode='managed' AND usage_source='gateway'
    ), money AS (
      SELECT group_key key,currency,kind,grouping(group_key)=1 is_total,${metricSQL('amount')} metric
      FROM money_rows GROUP BY GROUPING SETS((group_key,currency,kind),(currency,kind))
      HAVING grouping(group_key)=1 OR group_key IN (SELECT key FROM page)
    ), source_counts AS (
      SELECT group_key key,usage_source source,max(authority) authority,count(*)::text events,grouping(group_key)=1 is_total
      FROM keyed GROUP BY GROUPING SETS((group_key,usage_source),(usage_source))
      HAVING grouping(group_key)=1 OR group_key IN (SELECT key FROM page)
    ), total_activity AS (SELECT ${activityColumns()},${tokenSQL()} tokens FROM scoped)
    SELECT (SELECT to_jsonb(total_activity) FROM total_activity) totals,
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY key) FROM page),'[]'::jsonb) groups,
      (SELECT count(*)::text FROM grouped) total_groups,coalesce((SELECT jsonb_agg(to_jsonb(money)) FROM money),'[]'::jsonb) money,
      coalesce((SELECT jsonb_agg(to_jsonb(source_counts)) FROM source_counts),'[]'::jsonb) sources`
  const row = (
    await client.query<{
      totals: Omit<AnalyticsMetrics, 'money'>
      groups: Array<{ key: string; label: string | null } & Omit<AnalyticsMetrics, 'money'>>
      total_groups: string
      sources: Array<{ key: string | null; source: string; authority: string; events: string; is_total: boolean }>
      money: Array<{
        key: string | null
        currency: string | null
        kind: 'charge' | 'upstreamCost' | 'margin'
        is_total: boolean
        metric: ExactMetric
      }>
    }>(sql, values)
  ).rows[0]
  const sourceFor = (key: string | null, total: boolean) =>
    (row.sources ?? [])
      .filter((s) => s.is_total === total && (total || s.key === key))
      .map(({ source, authority, events }) => ({ source, authority, events }))
      .sort((a, b) => a.source.localeCompare(b.source))
  const moneyFor = (key: string | null, total: boolean) => {
    const buckets = new Map<string | null, AnalyticsCurrencyMetrics>()
    for (const item of row.money) {
      if (item.is_total !== total || (!total && item.key !== key)) continue
      let bucket = buckets.get(item.currency)
      if (!bucket) {
        bucket = { currency: item.currency, charge: emptyMetric(), upstreamCost: emptyMetric(), margin: emptyMetric() }
        buckets.set(item.currency, bucket)
      }
      bucket[item.kind] = item.metric
    }
    return [...buckets.values()].sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? ''))
  }
  return {
    asOf: q.asOf,
    from: q.from,
    to: q.to,
    groupBy: q.groupBy,
    totals: { ...row.totals, provenance: sourceFor(null, true), money: moneyFor(null, true) },
    groups: row.groups.map((g) => ({
      key: g.key,
      label: g.label,
      metrics: {
        requests: g.requests,
        sessions: g.sessions,
        observedEvents: g.observedEvents,
        lastActivity: g.lastActivity,
        provenance: sourceFor(g.key, false),
        tokens: g.tokens,
        money: moneyFor(g.key, false),
      },
    })),
    totalGroups: row.total_groups,
    limit: q.limit,
    offset: q.offset,
    nextOffset:
      q.offset + row.groups.length <= MAX_ANALYTICS_OFFSET &&
      BigInt(q.offset + row.groups.length) < BigInt(row.total_groups)
        ? q.offset + row.groups.length
        : null,
  }
}

const queryDigest = (q: AnalyticsQuery) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(q)
            .filter(([key]) => !['cursor', 'offset', 'limit'].includes(key))
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
    .digest('hex')
export async function queryUsageLogs(client: AnalyticsDatabase, access: AnalyticsAccess, q: AnalyticsQuery) {
  const facts = buildAnalyticsFacts(access, q),
    values = [...facts.values]
  let cursorFilter = ''
  if (q.cursor) {
    let cursor: Record<string, unknown>
    try {
      const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid cursor')
      cursor = parsed
    } catch {
      throw new AnalyticsQueryError('Invalid cursor')
    }
    if (
      q.offset !== 0 ||
      cursor.digest !== queryDigest(q) ||
      typeof cursor.id !== 'string' ||
      !cursor.id ||
      cursor.id.length > 128 ||
      /[\s\x00-\x1f]/.test(cursor.id) ||
      typeof cursor.startedAt !== 'string' ||
      Object.keys(cursor).sort().join(',') !== 'digest,id,startedAt'
    )
      throw new AnalyticsQueryError('Invalid cursor')
    parseUsageAnalyticsQuery(new URLSearchParams({ from: cursor.startedAt, to: q.to, asOf: q.asOf }), new Date(q.asOf))
    values.push(cursor.startedAt, cursor.id)
    cursorFilter = `WHERE (started_at,id)<($${values.length - 1}::timestamptz,$${values.length})`
  }
  values.push(q.limit + 1, q.offset)
  const sql = `${facts.sql}, page AS (SELECT id,requested_model,model,provider_id,provider_code,project_id,project_name,attribution_status,api_key_id,connection_id,execution_mode,status,error_code,started_at,completed_at,input::text,output::text,cached::text,reasoning::text,total::text,charge::text,charge_currency,upstream_cost::text,upstream_cost_currency,margin::text,estimated FROM scoped ${cursorFilter} ORDER BY started_at DESC,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}) SELECT (SELECT count(*)::text FROM scoped) total,coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY started_at DESC,id DESC) FROM page),'[]'::jsonb) entries`
  const row = (await client.query<{ total: string; entries: Array<Record<string, unknown>> }>(sql, values)).rows[0]
  const more = row.entries.length > q.limit,
    entries = row.entries.slice(0, q.limit),
    last = entries.at(-1)
  return {
    asOf: q.asOf,
    from: q.from,
    to: q.to,
    total: row.total,
    limit: q.limit,
    offset: q.offset,
    entries,
    nextCursor:
      more && last
        ? Buffer.from(JSON.stringify({ startedAt: last.started_at, id: last.id, digest: queryDigest(q) })).toString(
            'base64url',
          )
        : null,
  }
}
