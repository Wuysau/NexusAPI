'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { ApiError, apiGet, apiSend, errorMessage } from '@/components/lib/api'
import { count, localDate, WorkspaceNotice } from './Workspace'
import type { ConnectionAccountView } from '@/lib/subscriptions/codex/types'
import { quotaRefreshInterval } from '@/lib/subscriptions/codex/refresh'
import styles from './workspace.module.css'

export const accountStatusLabels: Record<string, string> = {
  connected: '已连接',
  logged_out: '账号已退出',
  app_server_unavailable: 'App Server 不可用',
  sync_error: '同步异常',
  unknown: '尚未同步',
}
function syncError(code: string) {
  if (code === 'account_changed') return '本机已切换 Codex 账户。请为新账户添加连接，当前连接仍保留原账户观测。'
  if (code === 'app_server_unavailable') return '无法连接本机 Codex App Server，请确认 Codex 已安装且可以运行。'
  if (code.includes('unsupported')) return '当前 App Server 不支持某项账户接口，请更新 Codex 后重试。'
  return '未能完成账户同步，请检查 Codex 登录和网络后重试。已成功读取的数据仍然保留。'
}
const tokens = (value: string | null | undefined) => (value == null ? '未知' : count(value))
const canPollQuota = (view: ConnectionAccountView) =>
  view.syncAvailable &&
  view.observation?.status !== 'logged_out' &&
  view.observation?.lastSyncError !== 'account_changed' &&
  (!view.observation?.account || view.observation.account.type === 'chatgpt')
const observationTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function CodexAccountPanel({
  connectionId,
  revoked,
  onSynced,
  refreshRevision = 0,
}: {
  connectionId: string
  revoked: boolean
  onSynced: () => void
  refreshRevision?: number
}) {
  const [data, setData] = useState<ConnectionAccountView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const synced = useRef(onSynced)
  const refresh = useRef<() => Promise<void>>(async () => {})
  const readSnapshot = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    synced.current = onSynced
  }, [onSynced])
  const endpoint = '/api/connections/' + encodeURIComponent(connectionId) + '/account'
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let readingStored = false
    let pendingRefresh: 'quota' | 'account' | undefined
    let interval = quotaRefreshInterval([])
    let polling = true
    async function update(mode: 'quota' | 'account' | 'stored' = 'quota') {
      if (controller.signal.aborted) return
      // Coalesce periodic/focus requests. Completion starts the next wait, even after failure.
      if (inFlight) {
        // A DB-only Observer read must not swallow a timer or explicit refresh.
        if (readingStored && mode !== 'stored' && pendingRefresh !== 'account') pendingRefresh = mode
        return
      }
      const live = mode !== 'stored'
      inFlight = true
      readingStored = !live
      if (live) {
        clearTimeout(timer)
        setBusy(true)
      }
      try {
        const snapshot = await apiGet<ConnectionAccountView>(endpoint, controller.signal)
        if (controller.signal.aborted) return
        setData(snapshot)
        interval = quotaRefreshInterval(snapshot.quotas)
        polling = canPollQuota(snapshot)
        if (live && !revoked && snapshot.syncAvailable && document.visibilityState === 'visible') {
          await apiSend(mode === 'quota' ? endpoint + '?refresh=quota' : endpoint, 'POST', undefined, controller.signal)
          const current = await apiGet<ConnectionAccountView>(endpoint, controller.signal)
          if (controller.signal.aborted) return
          setData(current)
          interval = quotaRefreshInterval(current.quotas)
          polling = canPollQuota(current)
          synced.current()
        }
        setError('')
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) polling = false
        if (!controller.signal.aborted) setError(errorMessage(e))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) {
          if (live) setBusy(false)
          if (live && polling && !revoked && document.visibilityState === 'visible') {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (polling) void update()
            }, interval)
          }
          if (pendingRefresh) {
            const next = pendingRefresh
            pendingRefresh = undefined
            if (!revoked && document.visibilityState === 'visible') void update(next)
          }
        }
      }
    }
    refresh.current = () => update('account')
    readSnapshot.current = () => update('stored')
    const foreground = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'visible' && !revoked) void update()
    }
    document.addEventListener('visibilitychange', foreground)
    window.addEventListener('focus', foreground)
    void update()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', foreground)
      window.removeEventListener('focus', foreground)
    }
  }, [endpoint, retry, revoked])
  useEffect(() => {
    if (refreshRevision > 0) void readSnapshot.current()
  }, [refreshRevision])
  const observation = data?.observation
  const account = observation?.account
  const usage = observation?.usage
  // Provider supplies calendar dates without a timezone. Display the lookup convention explicitly.
  const today = usage?.dailyUsageBuckets?.find((b) => b.startDate === new Date().toISOString().slice(0, 10))
  return (
    <div className={styles.accountPanel}>
      <section className={styles.accountSection} aria-label="官方 Codex 账户">
        <div className={styles.accountHeading}>
          <div>
            <h3>Codex 账户</h3>
            <p>官方账户信息</p>
          </div>
          {!revoked && (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || !data?.syncAvailable}
              onClick={() => void refresh.current()}
            >
              <RefreshCw size={14} />
              {busy ? '同步中…' : '刷新账户'}
            </button>
          )}
        </div>
        {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
        {!data ? (
          <p className={styles.hint}>
            {error ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  setError('')
                  setRetry(retry + 1)
                }}
              >
                重新读取
              </button>
            ) : (
              '正在读取账户…'
            )}
          </p>
        ) : (
          <>
            <span className={observation?.status === 'connected' ? styles.badge : styles.mutedBadge}>
              {revoked ? '连接已撤销 · 历史数据' : accountStatusLabels[observation?.status ?? 'unknown']}
            </span>
            <dl className={styles.details}>
              <dt>账户</dt>
              <dd>{account?.email ?? '未知'}</dd>
              <dt>套餐</dt>
              <dd>{account?.planType ?? '未知'}</dd>
              <dt>最后成功同步</dt>
              <dd>{localDate(observation?.lastSuccessfulSyncAt ?? null)}</dd>
            </dl>
            <HelpDetails label="账户同步详情">
              <dl className={styles.details}>
                <dt>登录方式</dt>
                <dd>{account?.type ?? '未知'}</dd>
                <dt>最近尝试</dt>
                <dd>{localDate(observation?.lastAttemptAt ?? null)}</dd>
                <dt>数据来源</dt>
                <dd>OpenAI Codex App Server · 官方提供</dd>
              </dl>
            </HelpDetails>
            {observation?.lastSyncError && (
              <WorkspaceNotice error>{syncError(observation.lastSyncError)}</WorkspaceNotice>
            )}
            {observation?.status === 'logged_out' && (
              <WorkspaceNotice>Codex 当前未登录。请在 Codex 中登录后刷新；下方保留的数据是历史观测。</WorkspaceNotice>
            )}
            {!revoked && !data.syncAvailable && (
              <p className={styles.hint}>账户刷新仅向本机 dev:local 工作空间的管理员开放。</p>
            )}
          </>
        )}
      </section>
      <section className={styles.accountSection} aria-label="Official Quota">
        <div className={styles.accountHeading}>
          <div>
            <h3>官方额度</h3>
            <p>同一账户的所有项目共享</p>
          </div>
        </div>
        <p className={styles.hint}>
          {!revoked && data && canPollQuota(data) ? '自动更新' : '历史数据'}
          {busy && ' · 更新中…'}
          <br />
          数据时间：{observationTime(observation?.quota?.observedAt)}
        </p>
        {!data?.quotas.length ? (
          <p className={styles.hint}>暂无额度数据，剩余未知。</p>
        ) : (
          data.quotas.map((quota) => (
            <div className={styles.quotaBucket} key={quota.id}>
              <div className={styles.accountHeading}>
                <strong>{quota.metadata?.limitName ?? quota.metadata?.limitId ?? quota.windowType}</strong>
                <span className={styles.hint}>{quota.freshness === 'fresh' ? '近期数据' : '历史 / 未知'}</span>
              </div>
              <div className={styles.quotaNumbers}>
                <span>
                  已用 <b>{quota.used === null ? '未知' : `${Number(quota.used)}%`}</b>
                </span>
                <span>
                  剩余 <b>{quota.remaining === null ? '未知' : `${Number(quota.remaining)}%`}</b>
                </span>
              </div>
              {quota.used !== null && (
                <progress
                  max={100}
                  value={Math.min(100, Number(quota.used))}
                  aria-label={`${quota.metadata?.limitId} ${quota.metadata?.window} 配额已用百分比`}
                />
              )}
              <p className={styles.hint}>
                窗口：
                {quota.metadata?.windowDurationMins == null ? '未知' : `${quota.metadata.windowDurationMins} 分钟`} ·
                重置：{localDate(quota.resetAt)}
              </p>
              <HelpDetails label="额度来源与详情">
                <dl className={styles.details}>
                  <dt>额度标识</dt>
                  <dd>
                    {quota.metadata?.limitId ?? '未知'} · {quota.metadata?.window ?? '未知窗口'}
                  </dd>
                  <dt>套餐</dt>
                  <dd>{quota.metadata?.planType ?? '未知'}</dd>
                  <dt>点数余额</dt>
                  <dd>
                    {quota.metadata?.credits?.unlimited ? '不限量' : (quota.metadata?.credits?.balance ?? '未知')}
                  </dd>
                  <dt>有可用点数</dt>
                  <dd>
                    {quota.metadata?.credits?.hasCredits == null
                      ? '未知'
                      : quota.metadata.credits.hasCredits
                        ? '是'
                        : '否'}
                  </dd>
                  <dt>观测 ID</dt>
                  <dd>{quota.observationId ?? '未知'}</dd>
                  <dt>来源</dt>
                  <dd>
                    {quota.source ?? '未知'} · {quota.confidence ?? '未知'}
                  </dd>
                  <dt>读取时间</dt>
                  <dd>{observationTime(quota.observedAt)}</dd>
                  <dt>失效时间</dt>
                  <dd>{observationTime(quota.staleAt)}</dd>
                </dl>
              </HelpDetails>
            </div>
          ))
        )}
      </section>
      <section className={styles.accountSection} aria-label="Official Account Usage">
        <div className={styles.accountHeading}>
          <div>
            <h3>官方账户用量</h3>
            <p>整个账户的 Token 用量</p>
          </div>
        </div>
        <div className={styles.accountMetrics}>
          <div>
            <span>今日（UTC）</span>
            <strong>{tokens(today?.tokens)}</strong>
          </div>
          <div>
            <span>累计 Token</span>
            <strong>{tokens(usage?.summary.lifetimeTokens)}</strong>
          </div>
          <div>
            <span>单日最高 Token</span>
            <strong>{tokens(usage?.summary.peakDailyTokens)}</strong>
          </div>
        </div>
        <p className={styles.hint}>数据时间：{localDate(usage?.observedAt ?? null)}</p>
        <HelpDetails label="用量来源与统计口径">
          <p>
            来源：OpenAI Codex App
            Server（codex_app_server），由官方提供。日期沿用官方每日记录；未返回的日期或指标显示未知。
          </p>
          {usage && (
            <dl className={styles.details}>
              <dt>最长运行回合（秒）</dt>
              <dd>{tokens(usage.summary.longestRunningTurnSec)}</dd>
              <dt>当前连续天数</dt>
              <dd>{tokens(usage.summary.currentStreakDays)}</dd>
              <dt>最长连续天数</dt>
              <dd>{tokens(usage.summary.longestStreakDays)}</dd>
            </dl>
          )}
        </HelpDetails>
        <details className={styles.accountActivity}>
          <summary>每日账户用量</summary>
          {!usage?.dailyUsageBuckets?.length ? (
            <p className={styles.hint}>暂无官方每日记录</p>
          ) : (
            <div className={styles.dailyUsage}>
              <table>
                <thead>
                  <tr>
                    <th>官方日期</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {[...usage.dailyUsageBuckets]
                    .sort((a, b) => b.startDate.localeCompare(a.startDate))
                    .map((b, i) => (
                      <tr key={`${b.startDate}:${i}`}>
                        <td>{b.startDate}</td>
                        <td>{tokens(b.tokens)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>
      <section className={styles.accountSection} aria-label="Observed Project Usage">
        <div className={styles.accountHeading}>
          <div>
            <h3>本机项目用量</h3>
            <p>本机记录 · 全部历史 · 不计入账单</p>
          </div>
        </div>
        <HelpDetails label="项目用量如何统计">
          <p>
            按本机工作目录匹配项目，与官方账户用量口径不同，不能计算官方用量占比。来源：codex_local · client_observed。
          </p>
        </HelpDetails>
        {!data?.activity.length ? (
          <p className={styles.hint}>暂无本机记录，请先配置自动同步。</p>
        ) : (
          data.activity.map((project) => (
            <details className={styles.accountActivity} key={project.projectId ?? 'unassigned'}>
              <summary>
                {project.projectName ?? '未归属项目'} <span>{tokens(project.total)} tokens</span>
              </summary>
              <div className={styles.accountMetrics}>
                {(
                  [
                    ['会话', project.sessions],
                    ['用量记录', project.events],
                    ['输入', project.input],
                    ['缓存输入', project.cached],
                    ['输出', project.output],
                    ['推理', project.reasoning],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{tokens(value)}</strong>
                  </div>
                ))}
              </div>
              <p className={styles.hint}>
                模型：{project.models.join(', ') || '未知'}
                <br />
                最近活动：{localDate(project.lastActivity)}
              </p>
              {project.projectId && (
                <Link
                  className={styles.link}
                  href={`/projects/${encodeURIComponent(project.projectId)}/analytics?usageSource=codex_local`}
                >
                  查看项目用量 →
                </Link>
              )}
            </details>
          ))
        )}
      </section>
    </div>
  )
}
