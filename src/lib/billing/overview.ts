import { fromMicros } from '@/lib/money'
import { buildAnalyticsFacts, queryUsageAnalytics, type AnalyticsDatabase } from './analytics'
import type { AnalyticsAccess } from './analytics-access'
import type { AnalyticsQuery } from '../../../packages/contracts/usage-analytics'

/** Same authorized, immutable facts as logs/billing; subscription activity stays separate. */
export async function readOverview(
  db: AnalyticsDatabase,
  access: AnalyticsAccess,
  query: AnalyticsQuery,
  days: number,
) {
  const gateway = await queryUsageAnalytics(db, access, { ...query, usageSource: 'gateway', groupBy: 'provider' })
  const subscription = await queryUsageAnalytics(db, access, {
    ...query,
    usageSource: 'codex_local',
    groupBy: 'project',
  })
  const facts = buildAnalyticsFacts(access, { ...query, usageSource: 'gateway' })
  const status = (
    await db.query<{ success: string; failed: string }>(
      `${facts.sql}
    SELECT count(*) FILTER (WHERE status IN ('completed','reconciled'))::text success,
      count(*) FILTER (WHERE status IN ('failed','unknown'))::text failed FROM scoped`,
      facts.values,
    )
  ).rows[0]
  const buckets = await db.query<{ bucket: number; requests: string; tokens: string | null }>(
    `${facts.sql}
    SELECT least(48,greatest(1,width_bucket(EXTRACT(EPOCH FROM (started_at-$2::timestamptz)),0,${days * 86400},48))) bucket,
      count(*)::text requests,
      CASE WHEN count(input+output)=count(*) THEN sum(input+output)::text END tokens
    FROM scoped GROUP BY bucket ORDER BY bucket`,
    facts.values,
  )
  const series = Array.from({ length: 48 }, (_, i) => ({ bucket: i + 1, requests: 0, tokens: 0 as number | null }))
  for (const row of buckets.rows)
    series[row.bucket - 1] = {
      bucket: row.bucket,
      requests: Number(row.requests),
      tokens: row.tokens === null ? null : Number(row.tokens),
    }
  const metrics = gateway.totals
  const distribution = await db.query<{ provider_code: string | null; requests: string }>(
    `${facts.sql}
    SELECT provider_code,count(*)::text requests FROM scoped GROUP BY provider_code ORDER BY count(*) DESC`,
    facts.values,
  )
  const charge = metrics.money.length === 1 ? metrics.money[0] : null
  return {
    rangeDays: days,
    from: query.from,
    asOf: query.asOf,
    totals: {
      requests: metrics.requests,
      inputTokens: metrics.tokens.input.total,
      outputTokens: metrics.tokens.output.total,
      charge:
        charge?.charge.total == null
          ? metrics.requests === '0'
            ? '0.000000'
            : null
          : fromMicros(BigInt(charge.charge.total)),
      currency: charge?.currency ?? null,
      successRate: metrics.requests === '0' ? null : Number(status.success) / Number(metrics.requests),
      failed: status.failed,
    },
    series,
    distribution: distribution.rows.map((group) => ({
      providerCode: group.provider_code,
      requests: Number(group.requests),
    })),
    subscription: {
      sessions: subscription.totals.sessions ?? '0',
      events: subscription.totals.observedEvents ?? '0',
      tokens: subscription.totals.tokens.total.total,
      lastActivity: subscription.totals.lastActivity,
    },
    provenance: { gateway: 'gateway', subscription: 'codex_local', excludesDevelopmentFixtures: true },
  }
}
