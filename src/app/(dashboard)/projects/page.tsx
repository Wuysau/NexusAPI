'use client'
import { useEffect, useState, type FormEvent } from 'react'
import { FolderKanban, Plus, ArrowUpRight, Folder, Pencil, Archive, RotateCcw, Eye } from 'lucide-react'
import Link from 'next/link'
import { HelpDetails } from '@/components/HelpDetails'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState, LoadingState } from '@/components/States'
import { useSession } from '@/components/SessionProvider'
import { apiSend, errorMessage } from '@/components/lib/api'
import {
  useCollection,
  WorkspaceDialog,
  WorkspaceToolbar,
  WorkspaceNotice,
  localDate,
  count,
  type WorkspaceProject,
} from '@/components/workspace/Workspace'
import { ProjectDetails } from '@/components/workspace/ProjectDetails'
import { projectAnalyticsHref } from '@/components/workspace/project-analytics-link'
import styles from '@/components/workspace/workspace.module.css'

export default function ProjectsPage() {
  const { can } = useSession()
  const {
    items: projects,
    loading,
    error,
    reload,
  } = useCollection<WorkspaceProject>('/api/projects?status=all', 'projects')
  const [status, setStatus] = useState('active')
  const [detail, setDetail] = useState<WorkspaceProject | null>(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<WorkspaceProject | 'new' | null>(null)
  const [archiving, setArchiving] = useState<WorkspaceProject | null>(null)
  const [name, setName] = useState('')
  const [roots, setRoots] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 30_000)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(timer)
    }
  }, [reload])
  const filtered = projects.filter(
    (p) =>
      (status === 'all' || (status === 'archived' ? p.status === 'archived' : p.status !== 'archived')) &&
      [p.name, ...p.workspaceRoots].join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  function edit(project: WorkspaceProject | 'new') {
    setEditing(project)
    setName(project === 'new' ? '' : project.name)
    setRoots(project === 'new' ? '' : project.workspaceRoots.join('\n'))
    setFormError('')
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing || busy) return
    setBusy(true)
    setFormError('')
    try {
      const body = {
        name: name.trim(),
        workspaceRoots: roots
          .split('\n')
          .map((r) => r.trim())
          .filter(Boolean),
      }
      await apiSend(
        editing === 'new' ? '/api/projects' : '/api/projects/' + encodeURIComponent(editing.id),
        editing === 'new' ? 'POST' : 'PATCH',
        { ...body, ...(editing === 'new' ? {} : { expectedVersion: editing.policyVersion }) },
      )
      setNotice(
        editing === 'new'
          ? '项目已创建。配置工作目录并运行 Observer 后，会显示实际观测用量。'
          : '项目已更新，工作目录设置将用于后续观测。历史用量归属保持不变。',
      )
      setEditing(null)
      await reload()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function archive() {
    if (!archiving || busy) return
    setBusy(true)
    setFormError('')
    try {
      await apiSend('/api/projects/' + encodeURIComponent(archiving.id), 'PATCH', {
        archived: archiving.status !== 'archived',
        expectedVersion: archiving.policyVersion,
      })
      setNotice(
        archiving.status === 'archived' ? '项目已恢复，请在编辑中重新配置工作目录。' : '项目已归档，历史用量仍然保留。',
      )
      setArchiving(null)
      await reload()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.shell}>
      <PageHeader title="项目" description="按项目管理工作目录、成员与用量。">
        {can('project:create') && (
          <button className={styles.primary} onClick={() => edit('new')}>
            <Plus size={16} />
            创建项目
          </button>
        )}
      </PageHeader>
      <div className={styles.overview}>
        <div>
          <span>使用中项目</span>
          <strong>{loading && !projects.length ? '—' : projects.filter((p) => p.status !== 'archived').length}</strong>
        </div>
        <div>
          <span>已配置工作目录</span>
          <strong>{projects.filter((p) => p.workspaceRoots.length > 0).length}</strong>
        </div>
        <div>
          <span>有本地用量</span>
          <strong>{projects.filter((p) => BigInt(p.observedEvents) > 0n).length}</strong>
        </div>
      </div>
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {error && <WorkspaceNotice error>{error}。请点击刷新重试。</WorkspaceNotice>}
      <WorkspaceToolbar
        search={search}
        setSearch={setSearch}
        label="搜索项目或工作目录"
        loading={loading}
        reload={reload}
      >
        <select
          className={styles.filterSelect}
          aria-label="项目状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">使用中</option>
          <option value="archived">已归档</option>
          <option value="all">全部项目</option>
        </select>
        <span className={styles.hint}>{filtered.length} 个项目</span>
      </WorkspaceToolbar>
      {loading && !projects.length ? (
        <LoadingState label="正在加载项目…" />
      ) : !filtered.length ? (
        <EmptyState
          icon={<FolderKanban size={30} />}
          title={search ? '没有匹配的项目' : '还没有项目'}
          description={
            search
              ? '试试其他名称或目录。'
              : can('project:create')
                ? '点击右上角创建项目，开始归集用量。'
                : '请联系管理员创建项目并添加你的成员权限。'
          }
        />
      ) : (
        <div className={styles.grid}>
          {filtered.map((p) => (
            <article key={p.id} className={styles.card} aria-label={p.name}>
              <div className={styles.cardTop}>
                <div className={styles.identity}>
                  <span className={styles.icon}>
                    <FolderKanban size={21} />
                  </span>
                  <div>
                    <h2>{p.name}</h2>
                    <p>本地订阅用量</p>
                  </div>
                </div>
                <span className={p.status === 'archived' ? styles.mutedBadge : styles.badge}>
                  {p.status === 'archived' ? '已归档' : '使用中'}
                </span>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.metrics}>
                  <div>
                    <strong>{count(p.observedSessions)}</strong>
                    <span title="按遥测 session ID 去重，包含桌面对话、子代理和命令行会话">运行会话</span>
                  </div>
                  <div>
                    <strong>{count(p.observedEvents)}</strong>
                    <span>用量记录</span>
                  </div>
                </div>
                <dl className={styles.details}>
                  <dt>成员 / 绑定连接</dt>
                  <dd>
                    {p.memberCount} 位 / {p.connectionCount} 个
                  </dd>
                  <dt title="已导入的最新一条本地用量事件的发生时间">最近用量事件</dt>
                  <dd>{localDate(p.lastObservedAt)}</dd>
                </dl>
                <div className={styles.root}>
                  <Folder size={14} />
                  <span>{p.workspaceRoots.length ? p.workspaceRoots.join('\n') : '尚未配置工作目录'}</span>
                </div>
              </div>
              <div className={styles.footer}>
                <Link className={styles.link} href={projectAnalyticsHref(p.id, p.firstObservedAt)}>
                  用量分析
                  <ArrowUpRight size={14} />
                </Link>
                <div className={styles.footerActions}>
                  <button className={styles.link} onClick={() => setDetail(p)}>
                    <Eye size={12} />
                    详情
                  </button>
                  {can('project:update') && p.status !== 'archived' && (
                    <button className={styles.link} onClick={() => edit(p)}>
                      <Pencil size={12} />
                      编辑
                    </button>
                  )}
                  {can('project:archive') && (
                    <button
                      className={styles.dangerLink}
                      onClick={() => {
                        setArchiving(p)
                        setFormError('')
                      }}
                    >
                      {p.status === 'archived' ? <RotateCcw size={12} /> : <Archive size={12} />}
                      {p.status === 'archived' ? '恢复' : '归档'}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <HelpDetails label="项目用量如何归属">
        卡片展示全部历史 Codex
        本地用量，按工作目录匹配项目；进入用量分析时默认覆盖这些历史记录。最近用量事件取事件发生时间，Observer
        导入后页面会自动更新。网关请求与费用请查看「用量分析」。
      </HelpDetails>
      {detail && <ProjectDetails project={detail} onClose={() => setDetail(null)} />}
      {editing && (
        <WorkspaceDialog
          title={editing === 'new' ? '创建项目' : '编辑项目'}
          busy={busy}
          onClose={() => setEditing(null)}
        >
          <form className={styles.form} onSubmit={(e) => void save(e)}>
            <label className={styles.field}>
              项目名称
              <input
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 NexusAPI"
              />
            </label>
            <label className={styles.field}>
              工作目录（可选）
              <textarea
                aria-label="工作目录（可选）"
                aria-describedby="workspace-roots-help"
                value={roots}
                onChange={(e) => setRoots(e.target.value)}
                placeholder={'D:/Projects/NexusAPI\n/home/me/project'}
              />
              <span className={styles.hint} id="workspace-roots-help">
                每行一个绝对路径，最多 20 个；子目录优先匹配。
              </span>
            </label>
            {formError && <WorkspaceNotice error>{formError}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} disabled={busy} onClick={() => setEditing(null)}>
                取消
              </button>
              <button className={styles.primary} disabled={busy || !name.trim()}>
                {busy ? '保存中…' : editing === 'new' ? '创建项目' : '保存修改'}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
      {archiving && (
        <WorkspaceDialog
          title={archiving.status === 'archived' ? '恢复项目' : '归档项目'}
          busy={busy}
          onClose={() => setArchiving(null)}
        >
          <div className={styles.form}>
            <p className={styles.description}>
              {archiving.status === 'archived'
                ? `恢复「${archiving.name}」后可继续编辑和使用。此前释放的工作目录需重新配置，以免占用其他项目的目录。`
                : `归档「${archiving.name}」后，工作目录不再参与新的用量归属。历史观测记录保留，现有连接不会自动撤销。可在已归档列表恢复项目。`}
            </p>
            {formError && <WorkspaceNotice error>{formError}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button className={styles.secondary} disabled={busy} onClick={() => setArchiving(null)}>
                取消
              </button>
              <button className={styles.danger} disabled={busy} onClick={() => void archive()}>
                {busy ? '处理中…' : archiving.status === 'archived' ? '确认恢复' : '确认归档'}
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  )
}
