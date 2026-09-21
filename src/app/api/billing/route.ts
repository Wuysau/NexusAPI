import { pool } from '@/db'
import { getWalletBalance } from '@/lib/db/ledger'
import { fromMicros } from '@/lib/money'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { queryUsageAnalytics } from '@/lib/billing/analytics'
import {
  AnalyticsQueryError,
  parseUsageAnalyticsQuery,
  validateUsageAnalyticsResponse,
  type BillingAnalyticsResponse,
} from '../../../../packages/contracts/usage-analytics'
import { apiError, jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'
const money = (value: string | null) => (value === null ? null : fromMicros(BigInt(value)))

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'billing:read')
    const query = parseUsageAnalyticsQuery(new URL(req.url).searchParams)
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await resolveAnalyticsAccess(client, ctx, query)
      const analytics = await queryUsageAnalytics(client, access, query)
      const byModel =
        query.groupBy === 'model'
          ? analytics
          : await queryUsageAnalytics(client, access, { ...query, groupBy: 'model' })
      let wallet: { id: string; status: string; currency: string } | null = null
      let balance: string | null = null
      let developmentCredit: string | null = null
      let ledger: unknown[] = []
      let orders: unknown[] = []
      if (access.financialOrganizationId) {
        wallet =
          (
            await client.query<{ id: string; status: string; currency: string }>(
              `SELECT w.id,w.status,w.currency FROM wallet_accounts w JOIN organizations o ON o.id=w.organization_id AND o.tenant_id=w.tenant_id
           WHERE w.tenant_id=$1 AND w.organization_id=$2 ORDER BY (w.currency=o.base_currency) DESC,w.created_at,w.id LIMIT 1`,
              [access.tenantId, access.financialOrganizationId],
            )
          ).rows[0] ?? null
        if (wallet) {
          const mismatched = await client.query(
            `SELECT 1 FROM ledger_accounts a LEFT JOIN ledger_postings lp ON lp.account_id=a.id
            WHERE a.tenant_id=$1 AND a.wallet_id=$2 AND (a.currency<>$3 OR lp.currency<>$3 OR lp.tenant_id<>$1) LIMIT 1`,
            [access.tenantId, wallet.id, wallet.currency],
          )
          if (mismatched.rows.length) throw new Error('Wallet currency provenance mismatch')
          balance = fromMicros(await getWalletBalance(access.tenantId, wallet.id, client))
          const seeded = await client.query<{ amount: string }>(
            `SELECT coalesce(sum(lp.amount),0)::text amount FROM ledger_postings lp
             JOIN ledger_accounts a ON a.id=lp.account_id AND a.tenant_id=lp.tenant_id
             JOIN ledger_transactions t ON t.id=lp.transaction_id AND t.tenant_id=lp.tenant_id
             WHERE lp.tenant_id=$1 AND a.wallet_id=$2 AND lp.currency=$3
               AND t.id='ltx-dev-recharge' AND t.idempotency_key='demo:recharge:1'`,
            [access.tenantId, wallet.id, wallet.currency],
          )
          developmentCredit = fromMicros(BigInt(seeded.rows[0].amount))
          ledger = (
            await client.query<{
              id: string
              type: string
              amount: string
              currency: string
              balance_after: string
              reference_type: string | null
              reference_id: string | null
              created_at: Date
              transaction_id: string
              development_seed: boolean
            }>(
              `SELECT lp.id,t.id transaction_id,(t.id='ltx-dev-recharge' AND t.idempotency_key='demo:recharge:1') development_seed,t.type,lp.amount::text,lp.currency,t.reference_type,t.reference_id,
             (sum(lp.amount) OVER (ORDER BY lp.created_at,lp.id ROWS UNBOUNDED PRECEDING))::text AS balance_after,lp.created_at
             FROM ledger_postings lp JOIN ledger_accounts a ON a.id=lp.account_id AND a.tenant_id=lp.tenant_id
             JOIN ledger_transactions t ON t.id=lp.transaction_id AND t.tenant_id=lp.tenant_id
             WHERE lp.tenant_id=$1 AND a.wallet_id=$2 AND lp.currency=$3
             ORDER BY lp.created_at DESC,lp.id DESC LIMIT 100`,
              [access.tenantId, wallet.id, wallet.currency],
            )
          ).rows.map((row) => ({
            id: row.id,
            transactionId: row.transaction_id,
            evidence: row.development_seed ? 'development_seed' : 'ledger_posting',
            type: row.type,
            amount: money(row.amount),
            balanceAfter: money(row.balance_after),
            currency: row.currency,
            direction: BigInt(row.amount) >= 0n ? 'credit' : 'debit',
            reference: row.reference_type ? { type: row.reference_type, id: row.reference_id } : null,
            createdAt: row.created_at.toISOString(),
          }))
        }
        orders = (
          await client.query<{
            id: string
            kind: string
            status: string
            amount: string
            currency: string
            payment_provider: string
            plan_version_id: string | null
            created_at: Date
            paid_at: Date | null
          }>(
            `SELECT id,kind,status,amount::text,currency,payment_provider,plan_version_id,created_at,paid_at FROM orders
           WHERE tenant_id=$1 AND organization_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`,
            [access.tenantId, access.financialOrganizationId],
          )
        ).rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          amount: money(row.amount),
          currency: row.currency,
          paymentProvider: row.payment_provider,
          planVersionId: row.plan_version_id,
          createdAt: row.created_at.toISOString(),
          paidAt: row.paid_at?.toISOString() ?? null,
        }))
      }
      if (!validateUsageAnalyticsResponse(analytics).ok || !validateUsageAnalyticsResponse(byModel).ok)
        throw new Error('Invalid analytics response')
      await client.query('COMMIT')
      const analyticsEnvelope: BillingAnalyticsResponse = { analytics }
      return jsonOk({
        ...analyticsEnvelope,
        wallet,
        balance,
        developmentCredit,
        moneyTotals: analytics.totals.money.map((bucket) => ({
          currency: bucket.currency,
          charge: money(bucket.charge.total),
          cost: money(bucket.upstreamCost.total),
          margin: money(bucket.margin.total),
        })),
        currency: wallet?.currency ?? null,
        ledger,
        orders,
        usagePagination: {
          asOf: byModel.asOf,
          totalGroups: byModel.totalGroups,
          limit: byModel.limit,
          offset: byModel.offset,
          nextOffset: byModel.nextOffset,
        },
        usage: byModel.groups.map((group) => {
          const bucket = group.metrics.money.length === 1 ? group.metrics.money[0] : null
          return {
            model: group.key,
            providerCode: null,
            requests: group.metrics.requests,
            inputTokens: group.metrics.tokens.input.total,
            outputTokens: group.metrics.tokens.output.total,
            cachedTokens: group.metrics.tokens.cached.total,
            reasoningTokens: group.metrics.tokens.reasoning.total,
            totalTokens: group.metrics.tokens.total.total,
            charge: money(bucket?.charge.total ?? null),
            cost: money(bucket?.upstreamCost.total ?? null),
            margin: money(bucket?.margin.total ?? null),
            currency: bucket?.currency ?? null,
          }
        }),
      })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (error instanceof AnalyticsQueryError) return apiError(400, error.code, error.message)
    return routeError(error)
  }
}
