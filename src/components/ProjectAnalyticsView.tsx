'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { SessionDetails } from './workspace/SessionDetails'
import { PageHeader } from './PageHeader'
import { ProjectQuotaPanel } from './workspace/ProjectQuotaPanel'
import { useCollection, count, type WorkspaceProject } from './workspace/Workspace'
import styles from './workspace/workspace.module.css'
import { useApiData } from './lib/useApiData'
import { useSession } from './SessionProvider'
import { analyticsDateQuery, defaultAnalyticsDates } from './lib/analytics-query'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'
import {
  ANALYTICS_GROUP_BY,
  isAnalyticsGroupBy,
  validateUsageAnalyticsResponse,
  type AnalyticsGroupBy,
  type AnalyticsMetrics,
  type BillingAnalyticsResponse,
} from '../../packages/contracts/usage-analytics'

const labels: Record<AnalyticsGroupBy, string> = {
  project: '项目',
  provider: '供应商',
  model: '模型',
  apiKey: 'API 密钥',
  connection: '连接',
  executionMode: '执行模式',
  usageSource: '用量来源',
  subscription: '订阅',
  day: '每日趋势 (UTC)',
}
// Format exact integer micros; never pass financial facts through Number.
function exactMoney(value: string | null) {
  if (value === null) return '未知'
  const negative = value.startsWith('-')
  const digits = (negative ? value.slice(1) : value).padStart(7, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`
}
function MetricRow({
  label,
  metrics,
  showMoney,
  query,
  groupKey,
  asOf,
}: {
  label: string
  metrics: AnalyticsMetrics
  showMoney: boolean
  query: string
  groupKey: string | null
  asOf: string
}) {
  const [expanded, setExpanded] = useState(false)
  const hasSessions = BigInt(metrics.sessions ?? '0') > 0n
  return (
    <Fragment>
      <tr>
        <td>{label}</td>
        <td>{metrics.requests}</td>
        <td>
          {hasSessions ? (
            <button
              className={styles.sessionToggle}
              aria-expanded={expanded}
              aria-label={`${expanded ? '折叠' : '展开'}${label}的运行会话`}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {metrics.sessions}
            </button>
          ) : (
            (metrics.sessions ?? '0')
          )}
        </td>
        <td>{metrics.observedEvents ?? '0'}</td>
        {(['input', 'cached', 'reasoning', 'output', 'total'] as const).map((name) => (
          <td key={name}>{metrics.tokens[name].total ?? '未知'}</td>
        ))}
        {showMoney &&
          (['charge', 'upstreamCost', 'margin'] as const).map((name) => (
            <td key={name}>
              {metrics.money.length
                ? metrics.money.map((item, index) => (
                    <div key={`${item.currency}-${index}`}>
                      {exactMoney(item[name].total)} {item.currency ?? '币种未知'}
                    </div>
                  ))
                : '—'}
            </td>
          ))}
        <td>{metrics.lastActivity ? new Date(metrics.lastActivity).toLocaleString() : '—'}</td>
      </tr>
      {expanded && (
        <tr className={styles.sessionExpanded}>
          <td colSpan={showMoney ? 13 : 10}>
            <SessionDetails key={`${query}:${groupKey}:${asOf}`} query={query} groupKey={groupKey} asOf={asOf} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}
function AnalyticsResults({ query }: { query: string }) {
  const [page, setPage] = useState(query)
  const state = useApiData<BillingAnalyticsResponse>(page)
  if (state.forbidden) return <PermissionDenied capability="billing:read" />
  if (state.loading) return <SkeletonRows rows={4} />
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />
  const data = state.data?.analytics
  if (!data || !validateUsageAnalyticsResponse(data).ok)
    return <ErrorState message="用量数据格式异常，请重试。" onRetry={state.reload} />
  const showMoney = data.totals.money.length > 0
  return (
    <>
      <div className={styles.overview}>
        <div>
          <span>运行会话</span>
          <strong>{count(data.totals.sessions ?? '0')}</strong>
        </div>
        <div>
          <span>观测事件</span>
          <strong>{count(data.totals.observedEvents ?? '0')}</strong>
          <small>客户端观测</small>
        </div>
        <div>
          <span>Token 总量</span>
          <strong>{data.totals.tokens.total.total === null ? '未知' : count(data.totals.tokens.total.total)}</strong>
        </div>
      </div>
      <div className={styles.analyticsProvenance} aria-label="用量来源">
        {data.totals.provenance
          ?.filter((item) => item.events !== '0')
          .map((item) => (
            <span className={styles.mutedBadge} key={item.source}>
              {item.source === 'gateway' ? 'NexusAPI 网关 · 权威记录' : 'Codex 本地 · 客户端观测'} · {item.events}{' '}
              {item.source === 'gateway' ? '次请求' : '条事件'}
            </span>
          ))}
      </div>
      <HelpDetails label="统计口径">
        <p>会话按 ID 去重，包含桌面对话、子代理和命令行运行。同一会话可跨模型，各分组会话数不能直接相加。</p>
        <p>客户端观测与网关请求分别统计；缺失数据标为未知。</p>
      </HelpDetails>
      <div className={styles.analyticsTable}>
        <table>
          <thead>
            <tr>
              {[
                '维度',
                'API 请求',
                '运行会话',
                '观测事件',
                '输入',
                '缓存',
                '推理',
                '输出',
                '总计',
                ...(showMoney ? ['收入', '上游成本', '毛利'] : []),
                '最近活动',
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <MetricRow
              label="合计"
              metrics={data.totals}
              showMoney={showMoney}
              query={query}
              groupKey={null}
              asOf={data.asOf}
            />
            {data.groups.map((row) => (
              <MetricRow
                key={row.key ?? '__null__'}
                label={
                  row.key === '__unattributed__' || row.label === '__unattributed__'
                    ? '未归属'
                    : (row.label ?? row.key ?? '未知')
                }
                metrics={row.metrics}
                showMoney={showMoney}
                query={query}
                groupKey={row.key}
                asOf={data.asOf}
              />
            ))}
          </tbody>
        </table>
      </div>
      {data.groups.length === 0 && <EmptyState title="所选范围暂无项目用量" description="试试调整日期或筛选条件。" />}
      <div className={styles.toolbarActions}>
        <button className={styles.secondary} disabled={data.offset === 0} onClick={() => setPage(query)}>
          首页
        </button>
        <button
          className={styles.secondary}
          disabled={data.nextOffset === null}
          onClick={() => {
            const params = new URLSearchParams(query.split('?')[1])
            params.set('offset', String(data.nextOffset))
            params.set('asOf', data.asOf)
            setPage(`/api/billing?${params}`)
          }}
        >
          下一页
        </button>
      </div>
    </>
  )
}
export function ProjectAnalyticsView({
  initialProjectId = '',
  initialUsageSource = 'all',
  initialFrom = '',
}: { initialProjectId?: string; initialUsageSource?: string; initialFrom?: string } = {}) {
  const { session } = useSession()
  const projects = useCollection<WorkspaceProject>('/api/projects', 'projects')
  const [revision, setRevision] = useState(0)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>(
    initialUsageSource === 'codex_local' && initialProjectId ? 'model' : 'project',
  )
  const [usageSource, setUsageSource] = useState(initialUsageSource)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [dates, setDates] = useState(() => {
    const defaults = defaultAnalyticsDates()
    return initialFrom ? { ...defaults, from: initialFrom } : defaults
  })
  const organizationId = session?.organization.id
  const request = useMemo(() => {
    try {
      return {
        query: `/api/billing?${analyticsDateQuery({ ...dates, projectId, groupBy, organizationId, usageSource, provider, model })}`,
        error: null,
      }
    } catch (error) {
      return { query: null, error: error instanceof Error ? error.message : '无效日期' }
    }
  }, [dates, projectId, groupBy, organizationId, usageSource, provider, model])
  return (
    <section className={styles.shell} aria-label="项目用量分析">
      {initialProjectId && (
        <PageHeader
          title={projects.items.find((p) => p.id === initialProjectId)?.name ?? '项目分析'}
          description="用量记录与关联额度"
        >
          <Link className={styles.secondary} href="/projects">
            返回项目
          </Link>
        </PageHeader>
      )}
      <div className={styles.analyticsPanel}>
        <div className={styles.accountHeading}>
          <div>
            <h3>项目用量分析</h3>
          </div>
          <SlidersHorizontal size={17} />
        </div>
        <div className={styles.analyticsFilters}>
          <label className={styles.field}>
            用量来源
            <select aria-label="用量来源" value={usageSource} onChange={(e) => setUsageSource(e.target.value)}>
              <option value="all">全部来源</option>
              <option value="gateway">网关请求</option>
              <option value="codex_local">订阅 · 本地观测</option>
            </select>
          </label>
          <label className={styles.field}>
            项目
            <select aria-label="项目" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">全部项目</option>
              <option value="__unattributed__">未归属</option>
              {projectId && projectId !== '__unattributed__' && !projects.items.some((p) => p.id === projectId) && (
                <option value={projectId}>{projectId}</option>
              )}
              {projects.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            供应商
            <input
              aria-label="供应商"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="全部供应商"
            />
          </label>
          <label className={styles.field}>
            模型{' '}
            <input aria-label="模型" value={model} onChange={(e) => setModel(e.target.value)} placeholder="全部模型" />
          </label>
          <label className={styles.field}>
            分组
            <select
              aria-label="分组"
              value={groupBy}
              onChange={(e) => {
                if (isAnalyticsGroupBy(e.target.value)) setGroupBy(e.target.value)
              }}
            >
              {ANALYTICS_GROUP_BY.map((group) => (
                <option key={group} value={group}>
                  {labels[group]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            开始日期{' '}
            <input
              aria-label="开始日期"
              type="date"
              value={dates.from}
              onChange={(e) => setDates({ ...dates, from: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            结束日期{' '}
            <input
              aria-label="结束日期"
              type="date"
              value={dates.to}
              onChange={(e) => setDates({ ...dates, to: e.target.value })}
            />
          </label>
          <button className={styles.secondary} onClick={() => setRevision(revision + 1)}>
            <RefreshCw size={14} />
            刷新用量
          </button>
        </div>
        {projects.error && <p role="alert">项目列表加载失败；当前项目查询仍可使用。</p>}
        <HelpDetails label="日期范围说明">
          <p>按浏览器本地时区，包含结束日期；今天统计至查询时刻。</p>
        </HelpDetails>
      </div>
      <div className={styles.analyticsResults}>
        {request.query ? (
          <AnalyticsResults key={`${request.query}:${revision}`} query={request.query} />
        ) : (
          <p role="alert">{request.error}</p>
        )}
      </div>
      {projectId && projectId !== '__unattributed__' && <ProjectQuotaPanel key={projectId} projectId={projectId} />}
    </section>
  )
}
