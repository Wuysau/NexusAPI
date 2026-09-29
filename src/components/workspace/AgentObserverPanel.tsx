'use client'

import { useState } from 'react'
import { useSession } from '@/components/SessionProvider'
import { useApiData } from '@/components/lib/useApiData'
import { apiSend, errorMessage } from '@/components/lib/api'
import { AGENT_CATEGORIES, agentCategory, filterAgentTools } from '@/lib/observer/agent-tools'
import { localDate, WorkspaceNotice } from './Workspace'
import styles from './workspace.module.css'

interface Source {
  tool: string
  path: string
  format: 'native' | 'telemetry'
  workspace?: string
  exists?: boolean
  removable?: boolean
}
interface ObserverView {
  available: boolean
  reason?: string
  configured?: boolean
  autoDiscover?: boolean
  enabled?: boolean
  intervalSeconds?: number
  tools?: Array<{
    id: string
    name: string
    capture: string
    hint: string
    events: string
    sessions: string
    lastObserved: string | null
  }>
  detected?: Source[]
  sources?: Source[]
  runtime?: {
    state: string
    lastSync: string | null
    lastSuccessfulSync: string | null
    nextSync: string | null
    requested: boolean
    error: string | null
    sourceErrors: Array<{ tool: string; code: string }>
  } | null
}
const states: Record<string, string> = {
  running: '运行中',
  syncing: '同步中',
  idle: '等待同步',
  stopped: '后台已停止',
  error: '同步异常',
  not_configured: '尚未配置',
  source_unavailable: '来源不可用',
}
const captures: Record<string, string> = {
  native: '本地记录',
  export: '导出文件',
  hook: 'Hook 接入',
  bridge: '仅通用事件',
  unavailable: '尚未内置适配',
}
const sourceErrors: Record<string, string> = {
  source_unavailable: '来源路径不可访问，请检查路径和权限',
  capture_failed: '记录解析或导入失败，请检查格式与采集日志',
}
const docs = 'https://github.com/Wuysau/NexusAPI/blob/main/docs/operations/agent-observer.md'

export function AgentObserverPanel() {
  const { session } = useSession()
  const admin = session?.role === 'owner' || session?.role === 'admin'
  const state = useApiData<ObserverView>(admin ? '/api/local/agent-observer' : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tool, setTool] = useState('gemini_cli')
  const [format, setFormat] = useState<'native' | 'telemetry'>('native')
  const [sourcePath, setSourcePath] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [toolSearch, setToolSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [capture, setCapture] = useState('all')
  if (!admin) return null
  const data = state.data
  const shownTools = filterAgentTools(data?.tools ?? [], toolSearch, category, capture)
  async function act(body: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await apiSend<{ result: string }>('/api/local/agent-observer', 'POST', body)
      setNotice(
        body.action === 'sync'
          ? result.result === 'already_syncing'
            ? '后台正在同步，请稍后刷新状态。'
            : '同步请求已提交，请稍后刷新状态。'
          : '采集配置已保存，后台将在下次轮询时加载。',
      )
      state.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className={styles.analyticsPanel}>
      <summary>
        <strong>Agent 工具采集</strong>
      </summary>
      <p className={styles.hint}>
        查看本机工具记录与采集后台状态。历史记录存在不代表当前后台正在运行；缺失的 Token 保持未知。
      </p>
      {state.error && <WorkspaceNotice error>{state.error}</WorkspaceNotice>}
      {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {!data ? (
        <p className={styles.hint}>{state.loading ? '正在读取采集状态…' : '暂时无法读取采集状态。'}</p>
      ) : !data.available ? (
        <WorkspaceNotice>{data.reason}</WorkspaceNotice>
      ) : (
        <>
          <div className={styles.toolbarActions}>
            <label>
              <input
                type="checkbox"
                checked={Boolean(data.autoDiscover)}
                disabled={busy}
                onChange={(event) => void act({ action: 'discovery', enabled: event.target.checked })}
              />{' '}
              自动发现本机工具记录
            </label>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || !data.configured || data.runtime?.requested || data.runtime?.state === 'syncing'}
              onClick={() => void act({ action: 'sync' })}
            >
              立即同步
            </button>
            <button type="button" className={styles.secondary} disabled={state.loading} onClick={state.reload}>
              刷新状态
            </button>
          </div>
          <dl className={styles.details}>
            <dt>采集后台</dt>
            <dd>
              {states[data.runtime?.state ?? (data.configured ? 'stopped' : 'not_configured')] ?? '状态未知'} ·{' '}
              {data.enabled ? `每 ${data.intervalSeconds} 秒轮询` : '自动同步已关闭'}
            </dd>
            <dt>最近同步完成</dt>
            <dd>{localDate(data.runtime?.lastSync ?? null)}</dd>
            <dt>最近成功同步</dt>
            <dd>{localDate(data.runtime?.lastSuccessfulSync ?? null)}</dd>
          </dl>
          {data.runtime?.error && <WorkspaceNotice error>最近同步失败，请检查来源路径与本机配置。</WorkspaceNotice>}
          <div className={styles.analyticsFilters}>
            <label className={styles.field}>
              搜索 Agent 工具
              <input
                value={toolSearch}
                onChange={(event) => setToolSearch(event.target.value)}
                placeholder="工具名称、中文名称或标识"
              />
            </label>
            <label className={styles.field}>
              工具类别
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="all">全部类别</option>
                {Object.entries(AGENT_CATEGORIES).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              采集接入方式
              <select value={capture} onChange={(event) => setCapture(event.target.value)}>
                <option value="all">全部接入方式</option>
                {Object.entries(captures).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.hint}>
            显示 {shownTools.length} / {data.tools?.length ?? 0}{' '}
            个工具。目录列出工具并不代表已适配；“仅通用事件”需要自行对接元数据，“尚未内置适配”不能自动采集。
          </p>
          <div className={styles.tableScroll}>
            <table className={styles.comparisonTable}>
              <thead>
                <tr>
                  <th>工具</th>
                  <th>接入方式</th>
                  <th>本机来源</th>
                  <th>已有记录</th>
                  <th>最近观测</th>
                </tr>
              </thead>
              <tbody>
                {shownTools.map((entry) => {
                  const detected = data.detected?.filter((source) => source.tool === entry.id) ?? []
                  const configured = data.sources?.filter((source) => source.tool === entry.id) ?? []
                  const failures = [
                    ...new Set(
                      data.runtime?.sourceErrors
                        .filter((source) => source.tool === entry.id)
                        .map((source) => sourceErrors[source.code] ?? sourceErrors.capture_failed) ?? [],
                    ),
                  ]
                  return (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.name}</strong>
                        <span className={styles.badge}>{AGENT_CATEGORIES[agentCategory(entry.id)]}</span>
                        <p className={styles.hint}>{entry.hint}</p>
                      </td>
                      <td>{captures[entry.capture] ?? entry.capture}</td>
                      <td>
                        {failures.length
                          ? failures.join('；')
                          : configured.some((source) => !source.exists)
                            ? '配置路径缺失'
                            : configured.length
                              ? '已配置'
                              : detected.length
                                ? data.autoDiscover
                                  ? '已发现，自动采集'
                                  : '已发现，尚未启用'
                                : entry.capture === 'unavailable'
                                  ? '尚未内置适配'
                                  : entry.capture === 'hook'
                                    ? '待配置 Hook'
                                    : entry.capture === 'export'
                                      ? '待添加导出文件'
                                      : entry.capture === 'bridge'
                                        ? '待对接通用事件'
                                        : '未发现来源'}
                      </td>
                      <td>
                        {entry.sessions} 个会话 · {entry.events} 条记录
                      </td>
                      <td>{localDate(entry.lastObserved)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!shownTools.length && <p className={styles.hint}>没有符合筛选条件的工具。</p>}
          </div>
          <details>
            <summary>管理采集路径</summary>
            {(data.detected ?? [])
              .filter(
                (source) =>
                  !data.sources?.some(
                    (configured) => configured.tool === source.tool && configured.path === source.path,
                  ),
              )
              .map((source) => (
                <div className={styles.accountSection} key={'detected:' + source.tool + ':' + source.path}>
                  <strong>{data.tools?.find((entry) => entry.id === source.tool)?.name ?? source.tool}</strong>
                  <p className={styles.hint}>
                    {source.path} · {data.autoDiscover ? '自动发现来源' : '已发现，自动发现未启用'}
                  </p>
                </div>
              ))}
            {(data.sources ?? []).map((source) => (
              <div className={styles.accountSection} key={source.tool + ':' + source.path}>
                <strong>{data.tools?.find((entry) => entry.id === source.tool)?.name ?? source.tool}</strong>
                <p className={styles.hint}>
                  {source.path}
                  {source.workspace ? ` · 工作目录：${source.workspace}` : ''} ·{' '}
                  {source.exists ? '路径可访问' : '路径不存在或不可访问'}
                </p>
                {source.removable ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void act({ action: 'removeSource', tool: source.tool, path: source.path })}
                  >
                    移除手动来源
                  </button>
                ) : (
                  <p className={styles.hint}>此来源沿用原有 Observer 配置。</p>
                )}
              </div>
            ))}
            {Boolean(data.autoDiscover) && (
              <p className={styles.hint}>
                移除手动来源后，默认位置仍可能被自动发现。关闭自动发现可停止读取未手动配置的来源。
              </p>
            )}
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                void act({
                  action: 'addSource',
                  source: {
                    tool: tool.trim(),
                    format,
                    path: sourcePath.trim(),
                    ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
                  },
                })
              }}
            >
              <label className={styles.field}>
                工具标识
                <input
                  value={tool}
                  onChange={(event) => setTool(event.target.value)}
                  list="agent-observer-tools"
                  required
                  pattern="[a-z][a-z0-9_]{0,47}"
                  maxLength={48}
                />
                <datalist id="agent-observer-tools">
                  {data.tools?.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className={styles.field}>
                记录格式
                <select value={format} onChange={(event) => setFormat(event.target.value as 'native' | 'telemetry')}>
                  <option value="native">工具原生记录 / 已支持的导出</option>
                  <option value="telemetry">NexusAPI 通用用量事件</option>
                </select>
              </label>
              <label className={styles.field}>
                来源绝对路径
                <input
                  value={sourcePath}
                  onChange={(event) => setSourcePath(event.target.value)}
                  placeholder="C:\\Users\\you\\.nexusapi\\usage\\cursor.jsonl"
                  maxLength={4096}
                  required
                />
              </label>
              <label className={styles.field}>
                工作目录（可选）
                <input
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder="记录缺少项目目录时，指定项目绝对路径"
                  maxLength={4096}
                />
              </label>
              <p className={styles.hint}>
                通用接入用于工具提供的元数据或遥测。原生记录仅适用于上方标明本地记录或导出文件的工具；Codex、Claude Code
                继续使用原有配置。
              </p>
              <button className={styles.primary} disabled={busy} type="submit">
                添加或更新来源
              </button>
            </form>
          </details>
        </>
      )}
      <p className={styles.hint}>
        <a className={styles.link} href={docs} target="_blank" rel="noreferrer">
          采集接入文档
        </a>{' '}
        ·{' '}
        <a className={styles.link} href={docs + '#hook-接入'} target="_blank" rel="noreferrer">
          工具 Hook 配置
        </a>
      </p>
    </details>
  )
}
