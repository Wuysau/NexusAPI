'use client'
import Link from 'next/link'
import { useApiData } from '@/components/lib/useApiData'
import { LoadingState } from '@/components/States'
import { WorkspaceDialog, WorkspaceNotice, localDate, type WorkspaceProject } from './Workspace'
import styles from './workspace.module.css'

interface Details {
  project: { created_at: string; updated_at: string; workspaceRoots: string[] }
  members: { user_id: string; role: string; email: string }[]
  connections: { id: string; provider: string; mode: string; status: string }[]
}
export function ProjectDetails({ project, onClose }: { project: WorkspaceProject; onClose: () => void }) {
  const state = useApiData<Details>('/api/projects/' + encodeURIComponent(project.id))
  return (
    <WorkspaceDialog title={`项目详情 · ${project.name}`} onClose={onClose}>
      <div className={styles.form}>
        {state.error && (
          <WorkspaceNotice error>
            {state.error}
            <button className={styles.link} onClick={state.reload}>
              重试
            </button>
          </WorkspaceNotice>
        )}
        {state.loading ? (
          <LoadingState label="正在加载详情…" />
        ) : (
          state.data && (
            <>
              <dl className={styles.details}>
                <dt>项目 ID</dt>
                <dd>{project.id}</dd>
                <dt>状态</dt>
                <dd>{project.status === 'archived' ? '已归档' : '使用中'}</dd>
                <dt>创建时间</dt>
                <dd>{localDate(state.data.project.created_at)}</dd>
                <dt>更新时间</dt>
                <dd>{localDate(state.data.project.updated_at)}</dd>
                <dt>工作目录</dt>
                <dd>{state.data.project.workspaceRoots.join(' · ') || '尚未配置'}</dd>
              </dl>
              <h3>项目成员 · {state.data.members.length}</h3>
              {state.data.members.map((m) => (
                <div className={styles.managementRow} key={m.user_id}>
                  <span>{m.email}</span>
                  <span className={styles.mutedBadge}>{m.role}</span>
                </div>
              ))}
              {!state.data.members.length && <p className={styles.hint}>暂无项目成员</p>}
              <h3>绑定连接 · {state.data.connections.length}</h3>
              {state.data.connections.map((c) => (
                <div className={styles.managementRow} key={c.id}>
                  <span>
                    {c.provider} · {c.mode}
                    <small>{c.id}</small>
                  </span>
                  <span className={styles.mutedBadge}>{c.status}</span>
                </div>
              ))}
              {!state.data.connections.length && (
                <p className={styles.hint}>暂无绑定连接；按目录归集的观测仍可出现在用量分析中。</p>
              )}
            </>
          )
        )}
        <div className={styles.dialogActions}>
          <button className={styles.secondary} onClick={onClose}>
            关闭
          </button>
          <Link className={styles.primary} href={`/projects/${encodeURIComponent(project.id)}/analytics`}>
            查看用量分析
          </Link>
        </div>
      </div>
    </WorkspaceDialog>
  )
}
