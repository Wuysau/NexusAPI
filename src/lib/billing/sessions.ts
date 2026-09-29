import { analyticsGrouping, buildAnalyticsFacts, type AnalyticsDatabase } from './analytics'
import type { AnalyticsAccess } from './analytics-access'
import { MAX_ANALYTICS_OFFSET, type AnalyticsQuery } from '../../../packages/contracts/usage-analytics'
import type { SessionDetail, SessionDetailsResponse, SessionTokens } from './session-types'

const names = ['input', 'cached', 'reasoning', 'output', 'total']
const totals = (alias: string, subscriptionOnly = false) =>
  `jsonb_build_object(${names
    .map((name) => {
      const condition = subscriptionOnly ? `${alias}.subscription_product IS NOT NULL` : 'true'
      return `'${name}',CASE WHEN count(*) FILTER (WHERE ${condition} AND ${alias}.${name} IS NULL)>0 THEN NULL ELSE coalesce(sum(${alias}.${name}) FILTER (WHERE ${condition}),0)::text END`
    })
    .join(',')})`

export async function readSessionDetails(
  client: AnalyticsDatabase,
  access: AnalyticsAccess,
  query: AnalyticsQuery,
  groupKey: string | null,
): Promise<SessionDetailsResponse> {
  const facts = buildAnalyticsFacts(access, query, true),
    grouping = analyticsGrouping(query)
  const values = [...facts.values, groupKey, query.limit, query.offset]
  const n = values.length
  const result = await client.query<{
    sessions: SessionDetail[]
    subscription_totals: SessionTokens
    total_sessions: string
  }>(
    `${facts.sql}, keyed AS (SELECT *,${grouping.key} drilldown_key FROM scoped),
     grouped AS (
       SELECT k.external_session_id id,max(k.usage_source) "usageSource",
       array_remove(array_agg(DISTINCT k.connection_id),NULL) "connectionIds",
       max(e.session_kind) kind,max(e.parent_session_id) "parentId",
       min(k.started_at) "firstActivity",max(k.started_at) "lastActivity",count(*)::text events,
       array_remove(array_agg(DISTINCT k.model),NULL) models,${totals('k')} tokens,${totals('k', true)} "subscriptionTokens"
       FROM keyed k JOIN external_observed_usage e ON e.id=k.id AND e.tenant_id=k.tenant_id AND e.organization_id=k.organization_id
       WHERE k.authority='client_observed' AND ($${n - 2}::text IS NULL OR k.drilldown_key=$${n - 2})
       GROUP BY k.usage_source,k.external_session_id
     ), page AS (SELECT * FROM grouped ORDER BY "firstActivity",id,"usageSource" LIMIT $${n - 1} OFFSET $${n}),
     denominator AS (SELECT ${totals('s')} tokens FROM scoped s WHERE s.authority='client_observed' AND s.subscription_product IS NOT NULL)
     SELECT coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "firstActivity",id,"usageSource") FROM page),'[]'::jsonb) sessions,
       (SELECT tokens FROM denominator) subscription_totals,(SELECT count(*)::text FROM grouped) total_sessions`,
    values,
  )
  const row = result.rows[0]
  return {
    sessions: row.sessions,
    subscriptionTotals: row.subscription_totals,
    totalSessions: row.total_sessions,
    nextOffset:
      query.offset + row.sessions.length <= MAX_ANALYTICS_OFFSET &&
      BigInt(query.offset + row.sessions.length) < BigInt(row.total_sessions)
        ? query.offset + row.sessions.length
        : null,
    asOf: query.asOf,
  }
}
