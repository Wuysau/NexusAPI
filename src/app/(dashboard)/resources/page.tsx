'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Layers3, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState, ErrorBanner, ErrorState, LoadingState, PermissionDenied } from '@/components/States'
import { useApiData } from '@/components/lib/useApiData'
import type { ExecutionResourceView } from '@/lib/resources/catalog'
import styles from '@/components/workspace/workspace.module.css'
import { SubscriptionPools, ResourceQuotaWindows } from '@/components/workspace/SubscriptionPools'

const kinds: Record<ExecutionResourceView['resourceType'], string> = {
  api: 'API',
  official_subscription: '官方订阅',
  coding_plan: 'Coding Plan',
  token_plan: 'Token Plan',
}
const quotaLabels: Record<ExecutionResourceView['quotaState'], string> = {
  available: '有额度',
  near_limit: '接近上限',
  exhausted: '已耗尽',
  unavailable: '不可用',
  unknown: '未知',
}
const healthLabels = { healthy: '正常', unhealthy: '异常', unknown: '未知' }

export default function ResourcesPage() {
  const [type, setType] = useState('all')
  const { data, loading, error, forbidden, reload, loadedAt } = useApiData<{ resources: ExecutionResourceView[] }>(
    '/api/resources',
  )
  const resources = (data?.resources ?? []).filter((resource) => type === 'all' || resource.resourceType === type)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [reload])
  return (
    <div className={styles.shell}>
      <PageHeader
        title="资源"
        description="统一查看 API 渠道与本地订阅资源。额度、健康和路由配置分别展示；未知信息不会被当成可用。"
        stale={Boolean(error && data)}
      >
        <button className="button" onClick={reload}>
          <RefreshCw size={15} /> 刷新
        </button>
      </PageHeader>
      {forbidden && !data ? <PermissionDenied capability="credential:read" /> : null}
      {error && !data && !forbidden ? <ErrorState message={error} onRetry={reload} /> : null}
      {error && data ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingState label="加载资源…" /> : null}
      {data ? (
        <>
          <SubscriptionPools resources={data.resources} />
          <div className={styles.toolbar}>
            <div>
              共 {resources.length} 个资源{' '}
              <small>· 页面可见时每 30 秒刷新 · 最近读取 {loadedAt ? new Date(loadedAt).toLocaleString() : '—'}</small>
            </div>
            <label>
              类型{' '}
              <select className={styles.filterSelect} value={type} onChange={(event) => setType(event.target.value)}>
                <option value="all">全部</option>
                <option value="api">API</option>
                <option value="official_subscription">官方订阅</option>
                <option value="coding_plan">Coding Plan</option>
                <option value="token_plan">Token Plan</option>
              </select>
            </label>
          </div>
          {resources.length ? (
            <div className={styles.tableScroll}>
              <table className={styles.comparisonTable}>
                <thead>
                  <tr>
                    <th>资源 / 供应商</th>
                    <th>类型 / 执行</th>
                    <th>账户</th>
                    <th>模型与能力</th>
                    <th>额度 / 重置</th>
                    <th>健康 / 配置</th>
                    <th>项目</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((resource) => (
                    <tr key={resource.id}>
                      <td>
                        <strong>{resource.product}</strong>
                        <br />
                        <small>
                          {resource.provider} ·{' '}
                          {resource.status === 'active'
                            ? '已启用'
                            : resource.status === 'disabled'
                              ? '已停用'
                              : '待配置'}
                        </small>
                      </td>
                      <td>
                        {kinds[resource.resourceType]}
                        <br />
                        <small>{resource.executionMode}</small>
                      </td>
                      <td>
                        {resource.accountId ? (
                          <span title={resource.accountId}>{resource.accountId.slice(0, 8)}…</span>
                        ) : (
                          '未绑定'
                        )}
                      </td>
                      <td>
                        {resource.supportedModels.join(', ') || '未声明'}
                        <br />
                        <small>{resource.capabilities.join(', ') || '能力未知'}</small>
                      </td>
                      <td>
                        {quotaLabels[resource.quotaState]}
                        {resource.usedPercent !== null ? ` · ${resource.usedPercent.toFixed(1)}%` : ''}
                        <br />
                        <small>{resource.resetAt ? new Date(resource.resetAt).toLocaleString() : '重置时间未知'}</small>
                        <ResourceQuotaWindows resource={resource} />
                      </td>
                      <td>
                        {resource.temporaryBlock ? '暂不可调度' : healthLabels[resource.health]}
                        <br />
                        <small>
                          {resource.temporaryBlock
                            ? `${resource.temporaryBlock.reason} · 待重新观测`
                            : resource.routingStatus === 'configured'
                              ? '已配置渠道'
                              : '未配置路由'}
                        </small>
                      </td>
                      <td>
                        {resource.projectId ? (
                          <Link href={`/projects/${encodeURIComponent(resource.projectId)}/analytics`}>查看项目</Link>
                        ) : (
                          '组织共享 / 未关联'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<Layers3 size={28} />}
              title="暂无此类资源"
              description="可在连接或渠道页面添加资源，再配置项目与路由策略。"
            />
          )}
        </>
      ) : null}
    </div>
  )
}
