'use client'

import Link from 'next/link'
import type { ExecutionResourceView } from '@/lib/resources/catalog'
import { summarizeSubscriptionPools } from '@/lib/resources/pool'
import { getSubscriptionProduct } from '@/lib/subscriptions/catalog'
import styles from './workspace.module.css'

export function SubscriptionPools({ resources }: { resources: ExecutionResourceView[] }) {
  const pools = summarizeSubscriptionPools(resources)
  return (
    <section aria-label="订阅账号池监控">
      <div className={styles.toolbar}>
        <div>
          <h2>订阅账号池</h2>
          <p>
            按订阅产品汇总连接状态。可用表示额度和登录观测正常，不代表已加入网关路由；同一账号重复登记会计为多条连接。
          </p>
        </div>
        <Link className={styles.secondary} href="/connections">
          管理订阅连接
        </Link>
      </div>
      {pools.length ? (
        <div className={styles.grid}>
          {pools.map((pool) => (
            <article key={pool.key} className={styles.card}>
              <div className={styles.cardBody} style={{ paddingTop: 20 }}>
                <strong>{getSubscriptionProduct(pool.product)?.label ?? pool.product}</strong>
                <p>
                  {pool.provider} · {pool.total} 条连接
                </p>
                <dl className={styles.details}>
                  <dt>观测正常</dt>
                  <dd>{pool.available}</dd>
                  <dt>接近上限（≥90%）</dt>
                  <dd>{pool.nearLimit}</dd>
                  <dt>额度耗尽</dt>
                  <dd>{pool.exhausted}</dd>
                  <dt>异常 / 暂时不可用</dt>
                  <dd>{pool.blocked}</dd>
                  <dt>未知 / 待配置</dt>
                  <dd>{pool.unknown}</dd>
                  <dt>已停用</dt>
                  <dd>{pool.disabled}</dd>
                </dl>
                {pool.collectorReported + pool.collectorStale > 0 ? (
                  <p>
                    第三方监控：{pool.collectorReported} 个已报告，{pool.collectorStale}{' '}
                    个已过期。此数据单独展示，不计入上方“观测正常”。
                  </p>
                ) : null}
                {pool.nextResetAt ? (
                  <p>最早已知重置：{new Date(pool.nextResetAt).toLocaleString()}（重置后仍需重新观测）</p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p>尚未登记订阅账号。添加连接后，可查看支持的观测方式与接入说明。</p>
      )}
    </section>
  )
}

export function ResourceQuotaWindows({ resource }: { resource: ExecutionResourceView }) {
  const collector = resource.collectorObservation
  if (collector)
    return (
      <details>
        <summary>
          CodexBar · {{ reported: '已报告', stale: '已过期', unknown: '未知', error: '采集失败' }[collector.state]}
        </summary>
        <p>第三方采集数据，仅供监控。</p>
        <small>观测：{collector.observedAt ? new Date(collector.observedAt).toLocaleString() : '未知'}</small>
        {collector.windows.map((window, i) => (
          <div key={`${window.kind}:${i}`} style={{ margin: '12px 0' }}>
            <strong>{window.label}</strong>
            <div>
              已用 {window.usedPercent === null ? '未知' : `${window.usedPercent}%`} · 剩余{' '}
              {window.remainingPercent === null ? '未知' : `${window.remainingPercent}%`}
            </div>
            <small>重置：{window.resetAt ? new Date(window.resetAt).toLocaleString() : '未知'}</small>
          </div>
        ))}
      </details>
    )
  if (!resource.quotaWindows?.length) return null
  return (
    <details>
      <summary>查看 {resource.quotaWindows.length} 个额度窗口</summary>
      {resource.quotaWindows.map((window) => (
        <div key={window.window} style={{ margin: '12px 0', minWidth: 220 }}>
          <strong>{window.window}</strong> ·{' '}
          {window.freshness === 'fresh' ? '有效' : window.freshness === 'stale' ? '已过期' : '时间未知'}
          {window.usedPercent !== null ? (
            <div>
              <progress aria-label={`${window.window} 已使用`} max={100} value={window.usedPercent} />{' '}
              {window.usedPercent.toFixed(1)}%
            </div>
          ) : (
            <p>使用比例未知</p>
          )}
          <small>
            来源：{window.source}
            <br />
            观测：{window.observedAt ? new Date(window.observedAt).toLocaleString() : '未知'}
            <br />
            重置：{window.resetAt ? new Date(window.resetAt).toLocaleString() : '未知'}
          </small>
        </div>
      ))}
    </details>
  )
}
