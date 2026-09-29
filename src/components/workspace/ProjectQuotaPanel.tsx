'use client'
import Link from 'next/link'
import { RefreshCw, ArrowUpRight } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { useApiData } from '@/components/lib/useApiData'
import { localDate, WorkspaceNotice } from './Workspace'
import type { AccountQuota } from '@/lib/subscriptions/codex/types'
import { connectionSubscriptionProduct } from '@/lib/subscriptions/catalog'
import styles from './workspace.module.css'

interface Quota extends AccountQuota {
  source: string
  sourceKind: string
  scope: string
  attributionMode: string
}
interface ProjectQuotas {
  connections: {
    id: string
    provider: string
    mode: string
    subscriptionProduct?: string | null
    accountStatus?: string | null
    quotas: Quota[]
  }[]
}
export function ProjectQuotaPanel({ projectId }: { projectId: string }) {
  const state = useApiData<ProjectQuotas>('/api/projects/' + encodeURIComponent(projectId) + '/quota')
  return (
    <section className={styles.analyticsPanel} aria-label="官方共享额度">
      <div className={styles.accountHeading}>
        <div>
          <h3>官方共享额度</h3>
          <p>同一账户的所有项目共享</p>
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.secondary} onClick={state.reload} disabled={state.loading}>
            <RefreshCw size={14} />
            刷新数据
          </button>
          <Link href="/connections" className={styles.link}>
            前往连接同步
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>
      <HelpDetails label="额度与项目用量的关系">
        <p>
          此处显示最近读取的官方额度，不受用量查询日期影响。已用比例包含其他项目；供应商未提供项目归属，因此无法计算本项目占比。
        </p>
      </HelpDetails>
      {state.error && (
        <WorkspaceNotice error>
          {state.error}
          {state.data ? '；以下保留上次读取结果。' : ''}
        </WorkspaceNotice>
      )}
      {state.loading && !state.data ? (
        <p className={styles.hint}>正在读取额度…</p>
      ) : !state.data?.connections.length ? (
        <p className={styles.hint}>暂无关联额度。请在连接页同步账户和本机用量。</p>
      ) : (
        <div className={styles.quotaGrid}>
          {state.data.connections.map((connection) => {
            const product = connectionSubscriptionProduct({
              ...connection,
              subscription_product: connection.subscriptionProduct,
            })
            const isCodex = connection.provider === 'openai' && product?.id === 'openai_codex'
            return (
              <div key={connection.id} className={styles.quotaBucket}>
                <div className={styles.accountHeading}>
                  <strong>{product?.label ?? connection.provider}</strong>
                  <span className={styles.mutedBadge}>账户共享</span>
                </div>
                <HelpDetails label="连接详情">
                  <p>连接 ID：{connection.id}</p>
                </HelpDetails>
                {connection.accountStatus && connection.accountStatus !== 'connected' && (
                  <WorkspaceNotice>账户当前未成功连接，以下仅为历史观测。请前往连接详情查看状态。</WorkspaceNotice>
                )}
                {!connection.quotas.length ? (
                  <p className={styles.hint}>
                    {isCodex
                      ? '配额未知，请先在连接详情刷新。'
                      : connection.mode === 'subscription_interactive'
                        ? '尚无可用额度观测；请查看服务商账户或连接详情中的接入说明。'
                        : '该 API 连接未提供账户额度；请求用量请查看上方用量分析或服务商控制台。'}
                  </p>
                ) : (
                  connection.quotas.map((quota) => {
                    const percent =
                      quota.metadata?.unit === 'percent' && quota.used !== null ? Number(quota.used) : null
                    return (
                      <div className={styles.quotaWindow} key={quota.id}>
                        <div className={styles.accountHeading}>
                          <strong>{quota.metadata?.limitName ?? quota.metadata?.limitId ?? quota.windowType}</strong>
                          <span className={styles.hint}>
                            {quota.freshness === 'fresh' ? '近期数据' : '历史 / 未知'}
                          </span>
                        </div>
                        <div className={styles.quotaNumbers}>
                          <span>
                            {quota.scope === 'account' ? '共享额度已用' : '已用'}{' '}
                            <b>{percent === null ? (quota.used ?? '未知') : `${percent}%`}</b>
                          </span>
                          <span>
                            剩余{' '}
                            <b>
                              {quota.remaining === null
                                ? '未知'
                                : quota.metadata?.unit === 'percent'
                                  ? `${Number(quota.remaining)}%`
                                  : quota.remaining}
                            </b>
                          </span>
                        </div>
                        {percent !== null && (
                          <progress
                            max={100}
                            value={Math.min(100, Math.max(0, percent))}
                            aria-label={`${quota.metadata?.limitId} 共享额度已用百分比`}
                          />
                        )}
                        {quota.metadata?.unit !== 'percent' && (
                          <p className={styles.hint}>该观测未提供百分比单位，不推算额度比例。</p>
                        )}
                        <p className={styles.hint}>
                          窗口：
                          {quota.metadata?.windowDurationMins == null
                            ? quota.windowType
                            : `${quota.metadata.windowDurationMins} 分钟`}{' '}
                          · 重置：{localDate(quota.resetAt)}
                          <br />
                          数据时间：{localDate(quota.observedAt)}
                        </p>
                        <HelpDetails label="额度来源">
                          <p>
                            来源：{quota.source} · {quota.sourceKind === 'official' ? '官方提供' : quota.sourceKind} ·{' '}
                            {quota.scope}
                          </p>
                        </HelpDetails>
                      </div>
                    )
                  })
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
