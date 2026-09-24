'use client'

import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState, ErrorBanner, LoadingState } from '@/components/States'
import { useSession } from '@/components/SessionProvider'
import { useApiData } from '@/components/lib/useApiData'
import { selectResource, type Resource, type RoutingPolicy } from '@/lib/task-runtime/router'
import type { ExecutionResourceView } from '@/lib/resources/catalog'
import styles from '@/components/workspace/workspace.module.css'

interface Project {
  id: string
  name: string
}
interface Runtime {
  resources: Resource[]
  policy: RoutingPolicy | null
}

export default function RoutingPage() {
  const { can } = useSession()
  const [requestedProject, setRequestedProject] = useState('')
  const projects = useApiData<{ projects: Project[] }>('/api/projects')
  const projectId = requestedProject || projects.data?.projects[0]?.id || ''
  const runtime = useApiData<Runtime>(projectId ? `/api/task-runtime?projectId=${encodeURIComponent(projectId)}` : null)
  const catalog = useApiData<{ resources: ExecutionResourceView[] }>(can('credential:read') ? '/api/resources' : null)
  const preview = runtime.data?.policy ? selectResource(runtime.data.resources, runtime.data.policy) : null
  const apiResources = (catalog.data?.resources ?? []).filter(
    (resource) => resource.resourceType === 'api' && (resource.projectId === null || resource.projectId === projectId),
  )

  return (
    <div className={styles.shell}>
      <PageHeader
        title="路由"
        description="按项目查看本地任务候选与 API 渠道。候选预览依赖当前观测，实际网关选路以请求时签名快照为准。"
      />
      {projects.loading && !projects.data ? <LoadingState label="加载项目…" /> : null}
      {projects.error ? <ErrorBanner message={projects.error} onRetry={projects.reload} /> : null}
      {projects.data?.projects.length ? (
        <>
          <label>
            项目{' '}
            <select
              className={styles.filterSelect}
              value={projectId}
              onChange={(event) => setRequestedProject(event.target.value)}
            >
              {projects.data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <section>
            <div className={styles.sectionHeading}>
              <h3>本地工具任务</h3>
              <span>
                <Link href="/tasks">在任务页管理策略</Link>
              </span>
            </div>
            {runtime.loading && !runtime.data ? <LoadingState label="读取任务候选…" /> : null}
            {runtime.error ? <ErrorBanner message={runtime.error} onRetry={runtime.reload} /> : null}
            {runtime.data?.policy ? (
              <>
                <p>
                  策略：{runtime.data.policy.name} · 任务模型：{runtime.data.policy.model ?? '未限定'} ·
                  按当前观测预选：{preview?.selected?.product ?? '无可用候选'}
                </p>
                <div className={styles.tableScroll}>
                  <table className={styles.comparisonTable}>
                    <thead>
                      <tr>
                        <th>顺序</th>
                        <th>资源 / 账户连接</th>
                        <th>兼容模型</th>
                        <th>额度</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runtime.data.policy.candidates
                        .slice()
                        .sort((a, b) => a.priority - b.priority)
                        .map((candidate) => {
                          const resource = runtime.data!.resources.find(
                            (item) => item.connectionId === candidate.connectionId,
                          )
                          const rejection = preview?.rejected.find(
                            (item) => item.connectionId === candidate.connectionId,
                          )
                          return (
                            <tr key={candidate.connectionId}>
                              <td>{candidate.priority}</td>
                              <td>
                                {resource?.product ?? candidate.connectionId}
                                <br />
                                <small>{resource?.provider ?? '尚无可用观测'}</small>
                              </td>
                              <td>{candidate.allowedModels.join(', ') || '按策略未限定'}</td>
                              <td>
                                {resource?.quotaState ?? 'unknown'}
                                {resource?.usedPercent !== null && resource?.usedPercent !== undefined
                                  ? ` · ${resource.usedPercent.toFixed(1)}%`
                                  : ''}
                              </td>
                              <td>
                                {!candidate.enabled
                                  ? '已停用'
                                  : (rejection?.reason ??
                                    (preview?.selected?.connectionId === candidate.connectionId ? '当前预选' : '候选'))}
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : runtime.data ? (
              <EmptyState
                title="尚未配置本地任务路由策略"
                description={<Link href="/tasks">前往任务页配置候选资源</Link>}
              />
            ) : null}
          </section>
          {can('credential:read') ? (
            <section>
              <div className={styles.sectionHeading}>
                <h3>API 网关资源</h3>
                <span>
                  <Link href="/resources">查看资源目录</Link>
                </span>
              </div>
              {catalog.error ? <ErrorBanner message={catalog.error} onRetry={catalog.reload} /> : null}
              {catalog.loading && !catalog.data ? <LoadingState label="读取 API 渠道…" /> : null}
              {catalog.data &&
                (apiResources.length ? (
                  <div className={styles.tableScroll}>
                    <table className={styles.comparisonTable}>
                      <thead>
                        <tr>
                          <th>优先级</th>
                          <th>渠道</th>
                          <th>模型</th>
                          <th>配置</th>
                          <th>健康 / 额度</th>
                        </tr>
                      </thead>
                      <tbody>
                        {apiResources
                          .slice()
                          .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1))
                          .map((resource) => (
                            <tr key={resource.id}>
                              <td>{resource.priority ?? '未知'}</td>
                              <td>
                                {resource.product}
                                <br />
                                <small>{resource.provider}</small>
                              </td>
                              <td>{resource.supportedModels.join(', ') || '未声明'}</td>
                              <td>{resource.routingStatus === 'configured' ? '已配置，发布状态待确认' : '未配置'}</td>
                              <td>
                                {resource.health} / {resource.quotaState}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState title="此项目没有可见 API 资源" />
                ))}
            </section>
          ) : null}
        </>
      ) : projects.data ? (
        <EmptyState title="尚无可见项目" description={<Link href="/projects">前往项目页</Link>} />
      ) : null}
    </div>
  )
}
