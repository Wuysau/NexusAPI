'use client'

import { useState } from 'react'
import { Activity, CircleDollarSign, Layers3, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { HelpDetails } from '@/components/HelpDetails'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { TrendChart } from '@/components/TrendChart'
import { useApiData } from '@/components/lib/useApiData'
import { useRefresh } from '@/components/RefreshProvider'
import { EmptyState, ErrorBanner, PermissionDenied, SkeletonRows } from '@/components/States'
import { ChannelTable } from '@/components/ChannelTable'
import { LogTable } from '@/components/LogTable'
import { money, num, providerName } from '@/components/ui'

interface Overview {
  rangeDays: number
  from: string
  asOf: string
  totals: {
    requests: string
    inputTokens: string | null
    outputTokens: string | null
    charge: string | null
    currency: string | null
    successRate: number | null
    failed: string
  }
  series: { bucket: number; requests: number; tokens: number | null }[]
  distribution: { providerCode: string | null; requests: number; charge: string }[]
  subscription: { sessions: string; events: string; tokens: string | null; lastActivity: string | null }
}

export default function OverviewPage() {
  const [range, setRange] = useState(7)
  const { tick } = useRefresh()
  const state = useApiData<Overview>(`/api/overview?days=${range}&_=${tick}`)

  if (state.forbidden) return <PermissionDenied capability="usage:read" />

  const totals = state.data?.totals
  const empty = !state.loading && totals?.requests === '0'
  const stale = Boolean(state.error && state.data)

  return (
    <>
      <PageHeader
        title="数据概览"
        description="查看调用表现、费用与订阅用量。"
        stale={stale}
        badge={
          <span className="live-badge">
            <i />
            {state.loading ? '读取中' : stale ? '历史数据' : '已更新'}
          </span>
        }
      >
        <select
          aria-label="统计时段"
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
          className="plain-select"
        >
          <option value={1}>近 24 小时</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </PageHeader>

      {state.error && <ErrorBanner message={state.error} onRetry={state.reload} />}

      {state.loading ? (
        <section className="panel">
          <SkeletonRows rows={3} />
        </section>
      ) : (
        <>
          <div className="stats-grid">
            <StatCard
              label="网关请求数"
              value={num(totals?.requests)}
              icon={<Activity size={17} />}
              color="#29ad8a"
              variant={0}
              note={empty ? undefined : `失败 ${num(totals?.failed ?? 0)} 次`}
              empty={empty}
            />
            <StatCard
              label="Token 消耗"
              value={
                totals?.inputTokens == null || totals.outputTokens == null
                  ? '未知'
                  : num((BigInt(totals.inputTokens) + BigInt(totals.outputTokens)).toString())
              }
              icon={<Layers3 size={17} />}
              color="#5d8ee7"
              variant={1}
              note={empty ? undefined : `输入 ${num(totals?.inputTokens)}`}
              empty={empty}
            />
            <StatCard
              label="累计费用"
              value={money(totals?.charge, 2, totals?.currency ?? null)}
              icon={<CircleDollarSign size={17} />}
              color="#a27ed9"
              variant={2}
              note={empty ? undefined : (totals?.currency ?? '币种未知 / 多币种')}
              empty={empty}
            />
            <StatCard
              label="请求成功率"
              value={
                totals?.successRate === null || totals?.successRate === undefined
                  ? '—'
                  : (totals.successRate * 100).toFixed(2) + '%'
              }
              icon={<ShieldCheck size={17} />}
              color="#dea35f"
              variant={3}
              note={empty ? undefined : '完成或已对账 / 全部请求'}
              empty={empty}
            />
          </div>

          <section className="panel" style={{ marginBottom: 14, padding: 20 }} aria-label="订阅使用凭证">
            <div className="panel-heading">
              <h3>Codex 本地用量</h3>
              <Link href="/billing">查看会话</Link>
            </div>
            <div className="mini-stats">
              <div>
                <span>运行会话</span>
                <strong>{num(state.data?.subscription.sessions)}</strong>
              </div>
              <div>
                <span>用量事件</span>
                <strong>{num(state.data?.subscription.events)}</strong>
              </div>
              <div>
                <span>Tokens</span>
                <strong>{num(state.data?.subscription.tokens)}</strong>
              </div>
            </div>
            <HelpDetails label="统计范围">
              本地订阅用量单独统计，不计入网关账单。已排除开发演示请求。 更新于{' '}
              {state.data?.asOf ? new Date(state.data.asOf).toLocaleString('zh-CN') : '未知'}。
            </HelpDetails>
          </section>

          <div className="dashboard-grid">
            <TrendChart series={state.data?.series ?? []} rangeDays={range} from={state.data?.from ?? ''} />
            <section className="panel distribution-panel">
              <div className="panel-heading">
                <h3>模型调用分布</h3>
              </div>
              {(state.data?.distribution ?? []).length === 0 ? (
                <EmptyState title="暂无调用分布" description="产生调用后按供应商汇总显示。" />
              ) : (
                <div className="distribution-content">
                  <div className="donut-wrap">
                    <svg viewBox="0 0 140 140" className="donut" aria-hidden="true">
                      <circle cx="70" cy="70" r="53" fill="none" stroke="#f0f3f5" strokeWidth="17" />
                      {(() => {
                        const total = state.data!.distribution.reduce((sum, d) => sum + d.requests, 0) || 1
                        const colors = ['#35b593', '#648ded', '#a18bdd', '#70c8d5', '#dbe0e8']
                        let offset = 0
                        return state.data!.distribution.map((entry, i) => {
                          const pct = (entry.requests / total) * 100
                          const el = (
                            <circle
                              key={entry.providerCode ?? i}
                              cx="70"
                              cy="70"
                              r="53"
                              fill="none"
                              stroke={colors[i % colors.length]}
                              strokeWidth="17"
                              strokeDasharray={`${Math.max(0, pct * 3.33 - 2)} ${333 - Math.max(0, pct * 3.33 - 2)}`}
                              strokeDashoffset={-offset * 3.33}
                              transform="rotate(-90 70 70)"
                            />
                          )
                          offset += pct
                          return el
                        })
                      })()}
                    </svg>
                    <div className="donut-label">
                      <span>总请求数</span>
                      <strong>{num(totals?.requests ?? 0)}</strong>
                      <small>次调用</small>
                    </div>
                  </div>
                  <div className="distribution-legend">
                    {state.data!.distribution.map((entry) => (
                      <div key={entry.providerCode ?? 'unknown'}>
                        <i />
                        <span>{providerName(entry.providerCode)}</span>
                        <strong>
                          {num(entry.requests)}
                          <small> 次</small>
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="distribution-footer">
                <Layers3 size={13} /> 活跃供应商：{state.data?.distribution.length ?? 0}
              </div>
            </section>
          </div>

          <ChannelTable compact />
          <div style={{ marginTop: 14 }}>
            <LogTable compact />
          </div>
        </>
      )}
    </>
  )
}
