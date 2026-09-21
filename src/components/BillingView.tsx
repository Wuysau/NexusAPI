'use client'

import { CreditCard, Receipt, ShieldCheck, Wallet } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { useApiData } from './lib/useApiData'
import { Badge, fullDate, money, num, type BadgeTone } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'

interface BillingResponse {
  wallet: { id: string; status: string; currency: string } | null
  balance: string | null
  currency: string | null
  developmentCredit: string | null
  moneyTotals: { currency: string | null; charge: string | null }[]
  ledger: {
    id: string
    transactionId: string
    evidence: 'development_seed' | 'ledger_posting'
    currency: string
    type: string
    amount: string
    balanceAfter: string
    direction: 'credit' | 'debit'
    reference: { type: string; id: string | null } | null
    createdAt: string
  }[]
  usage: {
    model: string
    providerCode: string | null
    requests: string
    inputTokens: string | null
    outputTokens: string | null
    charge: string | null
    cost: string | null
    margin: string | null
    currency: string | null
  }[]
  orders: {
    id: string
    kind: string
    status: string
    amount: string
    currency: string
    paymentProvider: string
    createdAt: string
    paidAt: string | null
  }[]
}

const ORDER_TONE: Record<string, BadgeTone> = {
  paid: 'good',
  pending: 'warn',
  failed: 'danger',
  refunded: 'info',
  cancelled: 'muted',
}

export function BillingView() {
  const state = useApiData<BillingResponse>('/api/billing')

  if (state.forbidden) return <PermissionDenied capability="billing:read" />

  if (state.loading) {
    return (
      <section className="panel">
        <SkeletonRows rows={5} />
      </section>
    )
  }
  if (state.error && !state.data) {
    return (
      <section className="panel">
        <ErrorState message={state.error} onRetry={state.reload} />
      </section>
    )
  }

  const data = state.data
  const developmentCredit = data?.developmentCredit != null && !/^0(?:\.0+)?$/.test(data.developmentCredit)

  return (
    <>
      <div className="billing-hero">
        <div>
          <span>账本余额 · {data?.currency ?? '币种未知'}</span>
          <h2>{money(data?.balance, 2, data?.currency ?? null)}</h2>
          {developmentCredit && <Badge tone="warn">含历史开发赠额 · 非真实付款</Badge>}
          <HelpDetails label="余额说明">
            <p>余额按账本分录累计；失败请求不计费，结果未知的请求进入对账。</p>
            {developmentCredit && (
              <p>
                历史开发赠额 {money(data?.developmentCredit, 2, data?.currency ?? null)}，不代表当前剩余赠额。
                原始记录可在下方账本分录查看。
              </p>
            )}
          </HelpDetails>
        </div>
        <div>
          <ShieldCheck size={38} />
          <span>账本记录</span>
        </div>
      </div>

      <div className="mini-stats">
        <div>
          <span>钱包状态</span>
          <strong>
            {data?.wallet
              ? (({ active: '正常', frozen: '已冻结', closed: '已关闭' } as Record<string, string>)[
                  data.wallet.status
                ] ?? data.wallet.status)
              : '未开通'}
          </strong>
          <Wallet size={24} />
        </div>
        <div>
          <span>账本分录</span>
          <strong>{num(data?.ledger.length ?? 0)}</strong>
          <Receipt size={24} />
        </div>
        <div>
          <span>累计消费（按币种）</span>
          <strong>
            {data?.moneyTotals.length
              ? data.moneyTotals.map((bucket) => money(bucket.charge, 4, bucket.currency)).join(' / ')
              : '暂无结算凭证'}
          </strong>
          <CreditCard size={24} />
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h3>模型用量与毛利</h3>
        </div>
        {(data?.usage ?? []).length === 0 ? (
          <EmptyState title="暂无用量记录" description="调用后可查看模型费用。" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>调用次数</th>
                  <th>输入 Tokens</th>
                  <th>输出 Tokens</th>
                  <th>收入 / 币种</th>
                  <th>上游成本 / 币种</th>
                  <th>毛利 / 币种</th>
                </tr>
              </thead>
              <tbody>
                {data!.usage.map((row) => (
                  <tr key={`${row.providerCode}-${row.model}`}>
                    <td>{row.model}</td>
                    <td>{num(row.requests)}</td>
                    <td>{num(row.inputTokens)}</td>
                    <td>{num(row.outputTokens)}</td>
                    <td className="tabular">{money(row.charge, 6, row.currency)}</td>
                    <td className="tabular muted">{money(row.cost, 6, row.currency)}</td>
                    <td className="tabular">{money(row.margin, 6, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>账单流水</h3>
        </div>
        {(data?.orders ?? []).length === 0 ? (
          <EmptyState title="暂无订单" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>订单</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>金额</th>
                  <th>支付渠道</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {data!.orders.map((order) => (
                  <tr key={order.id}>
                    <td className="tabular muted">
                      <details>
                        <summary>{order.id.slice(0, 12)}</summary>
                        <code>{order.id}</code>
                      </details>
                    </td>
                    <td>{order.kind === 'subscription' ? '订阅' : '托管额度'}</td>
                    <td>
                      <Badge tone={ORDER_TONE[order.status] ?? 'muted'}>{order.status}</Badge>
                    </td>
                    <td className="tabular">{money(order.amount, 2, order.currency)}</td>
                    <td className="muted">{order.paymentProvider}</td>
                    <td className="muted">{fullDate(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>账本分录（最近 100 条）</h3>
        </div>
        {(data?.ledger ?? []).length === 0 ? (
          <EmptyState title="暂无账本分录" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>方向</th>
                  <th>金额</th>
                  <th>分录后余额</th>
                  <th>关联</th>
                </tr>
              </thead>
              <tbody>
                {data!.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="muted">{fullDate(entry.createdAt)}</td>
                    <td>{entry.evidence === 'development_seed' ? '开发初始化赠额' : entry.type}</td>
                    <td>
                      <Badge tone={entry.direction === 'credit' ? 'good' : 'warn'}>
                        {entry.direction === 'credit' ? '入账' : '出账'}
                      </Badge>
                    </td>
                    <td className="tabular">{money(entry.amount, 6, entry.currency)}</td>
                    <td className="tabular muted">{money(entry.balanceAfter, 6, entry.currency)}</td>
                    <td className="muted">
                      <details>
                        <summary>查看凭证</summary>
                        <p>分录：{entry.id}</p>
                        <p>账务事务：{entry.transactionId}</p>
                        <p>业务关联：{entry.reference?.id ?? '无'}</p>
                        <p>来源：{entry.evidence === 'development_seed' ? '开发种子数据' : '账本分录'}</p>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
