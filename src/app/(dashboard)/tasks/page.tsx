'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { ListTodo, Plus, RefreshCw, Settings2, Terminal, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState, LoadingState } from '@/components/States'
import { useSession } from '@/components/SessionProvider'
import { apiSend, errorMessage } from '@/components/lib/api'
import { useApiData } from '@/components/lib/useApiData'
import { selectResource, type Candidate, type RoutingPolicy as Policy, type Resource } from '@/lib/task-runtime/router'
import {
  useCollection,
  WorkspaceDialog,
  WorkspaceNotice,
  localDate,
  count,
  type WorkspaceProject,
  type WorkspaceConnection,
} from '@/components/workspace/Workspace'
import styles from '@/components/workspace/workspace.module.css'

interface Task {
  id: string
  projectId: string
  originalGoal: string
  cwd: string
  status: string
  activeResource: string | null
  activeTool: string | null
  activeSession: string | null
  createdAt: string | null
  updatedAt: string | null
  pauseReason: string | null
  nextResetAt: string | null
  handoffs: number
  resourceSwitchCount: number
  transitions: {
    id: string
    source_connection_id: string | null
    target_connection_id: string
    source_conversation_id: string | null
    target_conversation_id: string
    switch_type: 'in_place' | 'runtime_restart' | 'context_handoff'
    reason: string
    created_at: string | null
  }[]
  history: {
    id: string
    source_connection_id?: string | null
    target_connection_id?: string | null
    reason?: string
    created_at?: string | null
  }[]
  sessions: {
    id: string
    connectionId: string
    externalSessionId: string | null
    startedAt: string | null
    endedAt: string | null
    reason: string | null
    status: string
  }[]
  usage: { connectionId: string | null; totalTokens: string | null }[]
}
interface Runtime {
  tasks: Task[]
  resources: Resource[]
  policy: Policy | null
}
const labels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  resumed: '已恢复',
  handoff_pending: '等待交接',
  handoff_capturing: '保存交接上下文',
  handoff_starting: '启动下一会话',
  paused: '已暂停',
  switching: '切换中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  ended: '已结束',
  available: '可用',
  unknown: '未知',
  stale: '观测已过期',
  exhausted: '额度耗尽',
  unavailable: '不可用',
  temporarily_unavailable: '暂不可用',
  rate_limited: '请求限流',
  resetting: '等待额度刷新',
  not_in_policy: '未加入策略',
  disabled: '未启用',
  capability: '能力不匹配',
  tool: '工具不匹配',
  model: '模型不匹配',
  near_limit: '接近上限',
  quota_exhausted: '额度耗尽',
  rate_limit: '请求限流',
  provider_unavailable: '服务暂不可用',
  authentication_failure: '认证失败',
  no_available_resource: '没有可用资源',
  no_compatible_resource: '没有兼容资源',
  no_compatible_resources: '当前没有兼容且可用的资源',
  approval_required: '需要检查工具操作权限',
  previous_runtime_still_alive: '上次运行器尚未退出',
  supervisor_interrupted: '监督进程中断，请先核实上次执行结果',
  supervisor_error: '监督服务异常',
  runtime_uncertain: '运行状态不确定，请先核实上次执行结果',
  launch_uncertain: '会话启动结果不确定',
  routing_policy_missing: '尚未配置路由策略',
  manual_switch: '手动切换',
  manual_resume: '继续任务',
  resource_recovered: '资源恢复',
  auto_return: '恢复优先资源',
  in_place: '原运行器切换',
  runtime_restart: '重启后续用原会话',
  context_handoff: '上下文交接至新会话',
  conversation_continuity_unknown: '无法确认原会话能否安全恢复',
  conversation_migration_required: '需要同工具会话迁移',
  stopped: '已停止',
  manual: '手动切换',
  subscription: '订阅',
  api: 'API',
  official_subscription: '官方订阅',
  coding_plan: 'Coding Plan',
  token_plan: 'Token Plan',
  third_party_api: '第三方 API',
  payg_api: '按量 API',
}
const label = (value: string | null | undefined) => (value ? (labels[value] ?? value) : '—')
const blankPolicy = (): Policy => ({
  name: 'Codex 编程任务',
  workload: 'coding-agent-high',
  requiredCapabilities: ['coding', 'tool_calling'],
  tool: 'codex',
  model: null,
  autoFailover: true,
  autoReturn: false,
  candidates: [],
})
const list = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

export default function TasksPage() {
  const projects = useCollection<WorkspaceProject>('/api/projects', 'projects')
  const [selected, setSelected] = useState('')
  const projectId = selected || projects.items[0]?.id || ''
  return (
    <div className={styles.shell}>
      <PageHeader title="任务" description="跟踪编程目标、资源状态与会话连续性。" />
      {projects.error && (
        <WorkspaceNotice error>
          {projects.error}
          <button className={styles.link} onClick={() => void projects.reload()}>
            重试
          </button>
        </WorkspaceNotice>
      )}
      {projects.loading && !projectId ? (
        <LoadingState label="正在加载项目…" />
      ) : !projectId ? (
        <EmptyState
          icon={<ListTodo size={30} />}
          title="先创建一个项目"
          description="任务按项目归集，请先在项目页配置工作目录。"
        />
      ) : (
        <>
          <label className={styles.field}>
            项目
            <select value={projectId} onChange={(e) => setSelected(e.target.value)}>
              {projects.items.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <ProjectTasks key={projectId} projectId={projectId} />
        </>
      )}
    </div>
  )
}

function ProjectTasks({ projectId }: { projectId: string }) {
  const { can } = useSession()
  const state = useApiData<Runtime>('/api/task-runtime?projectId=' + encodeURIComponent(projectId))
  const [editing, setEditing] = useState(false)
  const [switching, setSwitching] = useState<Task | null>(null)
  const [resuming, setResuming] = useState<Task | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const reload = state.reload
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reload()
    }
    const timer = window.setInterval(refresh, 7000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload])
  const data = state.data
  const resources = data?.resources ?? []
  const rejected = new Map(
    data?.policy
      ? selectResource(resources, data.policy).rejected.map((r) => [r.connectionId, r.reason])
      : resources.map((r) => [r.connectionId, 'not_in_policy']),
  )
  const eligible = resources.filter((r) => !rejected.has(r.connectionId))
  const targets = eligible.filter((r) => r.connectionId !== switching?.activeResource)
  const disabled = busy || Boolean(state.error) || state.loading
  async function act(task: Task, action: 'switch' | 'resume') {
    if (disabled) return
    setBusy(true)
    setActionError('')
    try {
      await apiSend(
        '/api/task-runtime/' + encodeURIComponent(task.id) + '/' + action,
        'POST',
        action === 'switch' ? { targetConnectionId: target } : {},
      )
      setNotice(
        action === 'switch' ? '切换请求已提交，将在安全边界优先沿用原会话。' : '恢复请求已提交，等待本地 Agent 处理。',
      )
      setSwitching(null)
      setResuming(null)
      reload()
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.hint}>页面可见时每 7 秒刷新</span>
        <div className={styles.toolbarActions}>
          <button className={styles.secondary} disabled={state.loading} onClick={reload}>
            <RefreshCw size={14} />
            刷新
          </button>
          {can('project:update') && (
            <button className={styles.primary} disabled={disabled || !data} onClick={() => setEditing(true)}>
              <Settings2 size={14} />
              编辑策略
            </button>
          )}
        </div>
      </div>
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {state.error && <WorkspaceNotice error>{state.error}。当前展示可能已过期，请刷新后再操作。</WorkspaceNotice>}
      <details className={styles.card}>
        <summary className={styles.disclosure}>
          <Terminal size={16} />
          从本地启动任务
        </summary>
        <div className={styles.cardBody}>
          <p className={styles.description}>
            先配置本地 Observer 的项目、工作目录和独立 Codex
            profile，再在已登记的目录中运行。此命令明确同意持久化任务目标与交接上下文。
          </p>
          <div className={styles.root}>
            <span>{`npm run nexus -- codex --project ${projectId} --goal "描述你的编程目标" --persist-context`}</span>
          </div>
          <Link className={styles.link} href="/connections">
            管理连接与 Observer
          </Link>
        </div>
      </details>
      {state.loading && !data ? (
        <LoadingState label="正在加载任务与资源…" />
      ) : (
        data && (
          <>
            <div className={styles.overview}>
              <div>
                <span>项目任务</span>
                <strong>{data.tasks.length}</strong>
              </div>
              <div>
                <span>运行中</span>
                <strong>{data.tasks.filter((t) => t.status === 'running').length}</strong>
              </div>
              <div>
                <span>可用资源 / 全部</span>
                <strong>
                  {eligible.length} / {resources.length}
                </strong>
              </div>
            </div>
            <section aria-label="任务列表">
              {!data.tasks.length ? (
                <EmptyState
                  icon={<ListTodo size={30} />}
                  title="还没有托管任务"
                  description="展开「从本地启动任务」，在已登记的工作目录提交目标。"
                />
              ) : (
                <div className={styles.grid}>
                  {data.tasks.map((task) => (
                    <article className={styles.card} key={task.id}>
                      <div className={styles.cardTop}>
                        <div className={styles.identity}>
                          <div>
                            <h2>{task.originalGoal}</h2>
                            <p>{task.id}</p>
                          </div>
                        </div>
                        <span className={task.status === 'running' ? styles.badge : styles.mutedBadge}>
                          {label(task.status)}
                        </span>
                      </div>
                      <div className={styles.cardBody}>
                        <dl className={styles.details}>
                          <dt>当前资源</dt>
                          <dd>{task.activeResource ?? '尚未分配'}</dd>
                          <dt>工具 / 会话</dt>
                          <dd>
                            {label(task.activeTool)} / {task.activeSession ?? '—'}
                          </dd>
                          <dt>资源切换 / 新会话交接</dt>
                          <dd>
                            {task.resourceSwitchCount ?? 0} / {task.handoffs}
                          </dd>
                          <dt>会话连续性</dt>
                          <dd>
                            {task.transitions?.at(-1)?.switch_type === 'context_handoff'
                              ? '已创建后续会话'
                              : task.activeSession
                                ? '保留当前会话'
                                : '尚未启动'}
                          </dd>
                          <dt>最近更新</dt>
                          <dd>{localDate(task.updatedAt)}</dd>
                        </dl>
                        <div className={styles.root}>
                          <span>{task.cwd}</span>
                        </div>
                        {task.status === 'paused' && (
                          <WorkspaceNotice>
                            暂停原因：{label(task.pauseReason)}。请确认资源与上次执行结果后恢复。
                            <br />
                            下次重置：{task.nextResetAt ? localDate(task.nextResetAt) : '未知，等待新的额度观测'}
                          </WorkspaceNotice>
                        )}
                        <details className={styles.evidenceDetails}>
                          <summary>
                            会话与资源记录（{task.sessions.length} 个会话，{task.resourceSwitchCount ?? 0} 次资源转换）
                          </summary>
                          {task.sessions.map((session) => (
                            <div key={session.id} className={styles.managementRow}>
                              <div>
                                <strong>
                                  {label(session.status)} · {session.connectionId}
                                </strong>
                                <small>会话 {session.externalSessionId ?? session.id}</small>
                                <small>
                                  {localDate(session.startedAt)} →{' '}
                                  {session.endedAt ? localDate(session.endedAt) : '尚未结束'} · {label(session.reason)}
                                </small>
                              </div>
                            </div>
                          ))}
                          {task.history.map((handoff) => (
                            <div key={handoff.id} className={styles.managementRow}>
                              <div>
                                交接：{handoff.source_connection_id ?? '—'} → {handoff.target_connection_id ?? '待分配'}
                                <small>
                                  {label(handoff.reason)} · {localDate(handoff.created_at ?? null)}
                                </small>
                              </div>
                            </div>
                          ))}
                          {task.transitions?.map((transition) => (
                            <div key={transition.id} className={styles.managementRow}>
                              <div>
                                资源：{transition.source_connection_id ?? '—'} → {transition.target_connection_id}
                                <small>
                                  {label(transition.switch_type)} · {label(transition.reason)} ·{' '}
                                  {localDate(transition.created_at)}
                                </small>
                                <small>
                                  会话：{transition.source_conversation_id ?? '—'} → {transition.target_conversation_id}
                                </small>
                              </div>
                            </div>
                          ))}
                          {!task.sessions.length && !task.handoffs && <p className={styles.hint}>尚无交接记录</p>}
                        </details>
                        <details className={styles.evidenceDetails}>
                          <summary>按资源的观测用量</summary>
                          <p className={styles.description}>
                            仅展示关联会话的观测 Token；未知保持未知，订阅用量不计入钱包账单。
                          </p>
                          {task.usage.map((usage, index) => (
                            <div className={styles.managementRow} key={usage.connectionId ?? index}>
                              <span>{usage.connectionId ?? '未知资源'}</span>
                              <strong>{usage.totalTokens === null ? '未知' : count(usage.totalTokens)} Token</strong>
                            </div>
                          ))}
                          {!task.usage.length && <p className={styles.hint}>尚无观测用量</p>}
                        </details>
                      </div>
                      {can('project:update') &&
                        ['running', 'resumed', 'handoff_pending', 'paused', 'failed'].includes(task.status) && (
                          <div className={styles.footer}>
                            {['running', 'resumed', 'handoff_pending'].includes(task.status) && (
                              <button
                                className={styles.link}
                                disabled={disabled}
                                onClick={() => {
                                  setSwitching(task)
                                  setTarget('')
                                  setActionError('')
                                }}
                              >
                                切换资源
                              </button>
                            )}
                            {['paused', 'failed'].includes(task.status) && (
                              <button
                                className={styles.secondary}
                                disabled={disabled}
                                onClick={() => {
                                  setResuming(task)
                                  setActionError('')
                                }}
                              >
                                恢复任务
                              </button>
                            )}
                          </div>
                        )}
                    </article>
                  ))}
                </div>
              )}
            </section>
            <section className={styles.card} aria-label="资源池">
              <div className={styles.cardTop}>
                <div className={styles.identity}>
                  <div>
                    <h2>资源池</h2>
                    <p>{data.policy?.name ?? '尚未配置路由策略'}</p>
                  </div>
                </div>
              </div>
              <div className={styles.cardBody}>
                <p className={styles.description}>
                  接近上限只准备备用资源；确认额度耗尽或不可用后才切换。过期观测不能用于自动路由。
                </p>
                {!resources.length ? (
                  <p className={styles.hint}>添加策略候选连接后显示资源状态。</p>
                ) : (
                  <div className={styles.tableScroll}>
                    <table className={styles.comparisonTable}>
                      <thead>
                        <tr>
                          <th scope="col">连接 / Profile</th>
                          <th scope="col">可用性</th>
                          <th scope="col">额度</th>
                          <th scope="col">重置时间</th>
                          <th scope="col">优先级</th>
                          <th scope="col">能力 / 计费模式</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resources.map((r) => (
                          <tr key={r.connectionId + r.profileRef}>
                            <td>
                              {r.provider} · {r.product}
                              <br />
                              {r.profileRef} / {r.connectionId}
                            </td>
                            <td>{label(rejected.get(r.connectionId) ?? 'available')}</td>
                            <td>
                              {label(r.quotaState)} · {r.usedPercent === null ? '未知' : `${r.usedPercent}%`}
                            </td>
                            <td>{r.resetAt ? localDate(r.resetAt) : '未知'}</td>
                            <td>{r.priority}</td>
                            <td>
                              {r.capabilities.join(', ') || '未知'}
                              <br />
                              {label(r.resourceType)} · {r.executionMode}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          </>
        )
      )}
      {editing && (
        <PolicyEditor
          projectId={projectId}
          initial={data?.policy ?? blankPolicy()}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            setNotice('路由策略已保存。')
            reload()
          }}
        />
      )}
      {switching && (
        <WorkspaceDialog title="切换资源" busy={busy} onClose={() => setSwitching(null)}>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault()
              void act(switching, 'switch')
            }}
          >
            <p className={styles.description}>
              请求会排队到安全边界，优先在原会话切换资源或重启恢复。只有确认无法保留原会话时才创建后续会话。
            </p>
            <label className={styles.field}>
              目标资源
              <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">请选择可用资源</option>
                {targets.map((r) => (
                  <option key={r.connectionId} value={r.connectionId}>
                    {r.profileRef} · {r.connectionId}
                  </option>
                ))}
              </select>
            </label>
            {!targets.length && <WorkspaceNotice>当前没有其他可用资源。请检查策略与最新额度观测。</WorkspaceNotice>}
            {actionError && <WorkspaceNotice error>{actionError}</WorkspaceNotice>}
            <button className={styles.primary} disabled={disabled || !targets.some((r) => r.connectionId === target)}>
              {busy ? '提交中…' : '提交切换'}
            </button>
          </form>
        </WorkspaceDialog>
      )}
      {resuming && (
        <WorkspaceDialog title="恢复任务" busy={busy} onClose={() => setResuming(null)}>
          <div className={styles.form}>
            <p className={styles.description}>
              请先检查工作目录与上次会话，确认不确定的外部操作结果。恢复后由本地 Observer 继续此目标。
            </p>
            {actionError && <WorkspaceNotice error>{actionError}</WorkspaceNotice>}
            <button className={styles.primary} disabled={disabled} onClick={() => void act(resuming, 'resume')}>
              {busy ? '提交中…' : '确认恢复'}
            </button>
          </div>
        </WorkspaceDialog>
      )}
    </>
  )
}

function PolicyEditor({
  projectId,
  initial,
  onClose,
  onSaved,
}: {
  projectId: string
  initial: Policy
  onClose: () => void
  onSaved: () => void
}) {
  const [policy, setPolicy] = useState<Policy>(() => structuredClone(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const connections = useApiData<{ connections: WorkspaceConnection[] }>('/api/connections')
  const choices =
    connections.data?.connections.filter(
      (c) => !c.revoked_at && c.status !== 'revoked' && (!c.project_id || c.project_id === projectId),
    ) ?? []
  const update = (index: number, patch: Partial<Candidate>) =>
    setPolicy((p) => ({ ...p, candidates: p.candidates.map((c, i) => (i === index ? { ...c, ...patch } : c)) }))
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await apiSend('/api/task-runtime/policy', 'PUT', { projectId, policy })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <WorkspaceDialog title="路由策略" busy={busy} onClose={onClose}>
      <form className={styles.form} onSubmit={(e) => void save(e)}>
        <label className={styles.field}>
          策略名称
          <input
            required
            maxLength={120}
            value={policy.name}
            onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          任务模型（留空不限）
          <input
            value={policy.model ?? ''}
            onChange={(e) => setPolicy({ ...policy, model: e.target.value.trim() || null })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={policy.autoFailover}
            onChange={(e) => setPolicy({ ...policy, autoFailover: e.target.checked })}
          />{' '}
          额度耗尽或资源不可用时自动切换
        </label>
        <p className={styles.description}>Profile 只填写本地配置中的引用名。各 Profile 的独立登录在本机完成。</p>
        {connections.error && (
          <WorkspaceNotice error>
            {connections.error}
            <button className={styles.link} type="button" onClick={connections.reload}>
              重试
            </button>
          </WorkspaceNotice>
        )}
        {policy.candidates.map((candidate, index) => (
          <fieldset
            key={index}
            className={styles.form}
            disabled={busy}
            style={{ border: '1px solid var(--border, #dce5e0)', borderRadius: 8, padding: 16, minWidth: 0 }}
          >
            <legend>候选资源 {index + 1}</legend>
            <label className={styles.field}>
              连接
              <select
                aria-label="连接"
                required
                value={candidate.connectionId}
                onChange={(e) => update(index, { connectionId: e.target.value })}
              >
                <option value="">选择现有连接</option>
                {candidate.connectionId && !choices.some((c) => c.id === candidate.connectionId) && (
                  <option value={candidate.connectionId}>{candidate.connectionId}（当前不可选择）</option>
                )}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.provider} · {c.id}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Profile 引用
              <input
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"
                maxLength={80}
                value={candidate.profileRef}
                onChange={(e) => update(index, { profileRef: e.target.value })}
                placeholder="例如 codex-work"
              />
            </label>
            <label className={styles.field}>
              优先级
              <input
                required
                type="number"
                min="0"
                step="1"
                value={candidate.priority}
                onChange={(e) => update(index, { priority: Number(e.target.value) })}
              />
            </label>
            <label className={styles.field}>
              备用准备阈值（已用 %）
              <input
                required
                type="number"
                min="1"
                max="100"
                value={candidate.switchThreshold}
                onChange={(e) => update(index, { switchThreshold: Number(e.target.value) })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={candidate.enabled}
                onChange={(e) => update(index, { enabled: e.target.checked })}
              />{' '}
              启用候选资源
            </label>
            <details>
              <summary>兼容性设置</summary>
              <div className={styles.form}>
                <label className={styles.field}>
                  能力（逗号分隔）
                  <ListInput
                    key={candidate.connectionId + '-capabilities'}
                    values={candidate.capabilities}
                    onChange={(values) => update(index, { capabilities: values })}
                  />
                </label>
                <label className={styles.field}>
                  允许的模型（留空不限，逗号分隔）
                  <ListInput
                    key={candidate.connectionId + '-models'}
                    values={candidate.allowedModels}
                    onChange={(values) => update(index, { allowedModels: values })}
                  />
                </label>
                <label className={styles.field}>
                  费用模式
                  <select value={candidate.costMode} onChange={(e) => update(index, { costMode: e.target.value })}>
                    <option value="subscription">订阅</option>
                    <option value="api">API</option>
                  </select>
                </label>
              </div>
            </details>
            <button
              type="button"
              className={styles.dangerLink}
              onClick={() => setPolicy({ ...policy, candidates: policy.candidates.filter((_, i) => i !== index) })}
            >
              <Trash2 size={14} />
              移除此候选
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className={styles.secondary}
          disabled={busy || connections.loading}
          onClick={() =>
            setPolicy({
              ...policy,
              candidates: [
                ...policy.candidates,
                {
                  connectionId: '',
                  profileRef: '',
                  priority: policy.candidates.length + 1,
                  enabled: true,
                  switchThreshold: 90,
                  capabilities: ['coding', 'tool_calling'],
                  allowedModels: [],
                  allowedTools: ['codex'],
                  costMode: 'subscription',
                },
              ],
            })
          }
        >
          <Plus size={14} />
          添加候选资源
        </button>
        {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className={styles.primary} disabled={busy}>
            {busy ? '保存中…' : '保存策略'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  )
}

function ListInput({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [text, setText] = useState(values.join(', '))
  return (
    <input
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        onChange(list(event.target.value))
      }}
    />
  )
}
