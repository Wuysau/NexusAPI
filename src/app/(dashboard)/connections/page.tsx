'use client'
import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Cable, Plus, ArrowUpRight, Copy, Download, Terminal } from 'lucide-react'
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
  type WorkspaceConnection,
  type WorkspaceProject,
} from '@/components/workspace/Workspace'
import styles from '@/components/workspace/workspace.module.css'
import { ObserverPathField } from '@/components/workspace/ObserverPathField'
import { CodexAccountPanel, accountStatusLabels } from '@/components/workspace/CodexAccountPanel'
import { ObserverPanel } from '@/components/workspace/ObserverPanel'

const modes: Record<string, string> = {
  subscription_interactive: 'Codex 账户与订阅观测',
  direct_api: 'API 连接登记',
  local_sidecar: '本地连接器',
  customer_vpc_runner: '私有网络连接器',
  external_endpoint: '外部服务登记',
}
function title(c: WorkspaceConnection) {
  return c.subscription_product === 'openai_codex' ? 'OpenAI Codex' : c.provider
}
function revoked(c: WorkspaceConnection) {
  return Boolean(c.revoked_at) || c.status === 'revoked'
}
function state(c: WorkspaceConnection) {
  if (revoked(c)) return '已撤销'
  if (c.status === 'blocked') return '已阻止'
  if (c.status === 'expired') return '已过期'
  if (c.mode === 'subscription_interactive')
    return c.accountStatus
      ? (accountStatusLabels[c.accountStatus] ?? '尚未同步')
      : BigInt(c.observedEvents) > 0n
        ? '已有观测'
        : '待采集'
  return c.last_heartbeat_at ? '已上报心跳' : '待配置'
}

export default function ConnectionsPage() {
  const { can, session } = useSession()
  const {
    items: connections,
    loading,
    error,
    reload,
  } = useCollection<WorkspaceConnection>('/api/connections', 'connections')
  const projectData = useCollection<WorkspaceProject>('/api/projects', 'projects')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<WorkspaceConnection | null>(null)
  const [setup, setSetup] = useState<WorkspaceConnection | null>(null)
  const [mode, setMode] = useState('subscription_interactive')
  const [provider, setProvider] = useState('openai')
  const [identifier, setIdentifier] = useState('openai')
  const [projectId, setProjectId] = useState('')
  const [source, setSource] = useState('')
  const [pickingPath, setPickingPath] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [observerRevision, setObserverRevision] = useState(0)
  const filtered = connections.filter(
    (c) =>
      [title(c), c.provider, c.project_name ?? '', c.id].join(' ').toLowerCase().includes(search.toLowerCase()) &&
      (statusFilter === 'all' || (statusFilter === 'revoked' ? revoked(c) : !revoked(c))),
  )
  async function create(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setFormError('')
    try {
      await apiSend('/api/connections', 'POST', {
        provider: mode === 'subscription_interactive' ? 'openai' : provider.trim(),
        mode,
        projectId: projectId || null,
        ...(mode === 'subscription_interactive' ? { providerIdentifier: identifier.trim() } : {}),
      })
      setCreating(false)
      setNotice('连接已登记。完成配置并收到实际观测或连接器心跳后，页面会更新对应状态。')
      await reload()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function revoke() {
    if (!revoking || busy) return
    setBusy(true)
    setFormError('')
    try {
      await apiSend('/api/connections/' + encodeURIComponent(revoking.id), 'DELETE')
      setRevoking(null)
      setNotice('连接已撤销。历史观测仍然保留；Nexus 中的撤销不会退出你本机的 Codex 账号。')
      await reload()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function copyId() {
    if (!setup) return
    try {
      await navigator.clipboard.writeText(setup.id)
      setCopied(true)
    } catch {
      setFormError('无法自动复制，请手动选择下方连接 ID。')
    }
  }
  function download(e: FormEvent) {
    e.preventDefault()
    if (!session || !setup) return
    const path = source.trim()
    if (!/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path) || /[\x00-\x1f]/.test(path)) {
      setFormError('请填写本机 Codex sessions 目录或 rollout 文件的绝对路径。')
      return
    }
    const config = {
      tenantId: session.organization.tenantId,
      organizationId: session.organization.id,
      sources: [path],
      roots: projectData.items.flatMap((p) => p.workspaceRoots.map((root) => ({ root, projectId: p.id }))),
      providers: [
        {
          identifier: setup.provider_identifier ?? 'openai',
          provider: setup.provider,
          product: setup.subscription_product ?? 'openai_codex',
          connectionId: setup.id,
        },
      ],
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'nexus-observer.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFormError('')
  }
  return (
    <div className={styles.shell}>
      <PageHeader title="我的连接" description="管理账户连接、订阅额度与本地用量。">
        {can('credential:create') && (
          <button
            className={styles.primary}
            onClick={() => {
              setCreating(true)
              setFormError('')
              setMode('subscription_interactive')
              setProvider('openai')
              setIdentifier('openai')
              setProjectId('')
            }}
          >
            <Plus size={16} />
            添加连接
          </button>
        )}
      </PageHeader>
      <div className={styles.overview}>
        <div>
          <span>全部连接</span>
          <strong>{loading && !connections.length ? '—' : connections.length}</strong>
        </div>
        <div>
          <span>有用量的连接</span>
          <strong>{connections.filter((c) => !revoked(c) && BigInt(c.observedEvents) > 0n).length}</strong>
        </div>
        <div>
          <span>已撤销</span>
          <strong>{connections.filter(revoked).length}</strong>
        </div>
      </div>
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {error && <WorkspaceNotice error>{error}。请点击刷新重试。</WorkspaceNotice>}
      <WorkspaceToolbar
        search={search}
        setSearch={setSearch}
        label="搜索供应商、项目或连接 ID"
        loading={loading}
        reload={reload}
      >
        <select
          aria-label="连接状态筛选"
          className={styles.secondary}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="active">未撤销</option>
          <option value="revoked">已撤销</option>
        </select>
      </WorkspaceToolbar>
      {loading && !connections.length ? (
        <LoadingState label="正在加载连接…" />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Cable size={30} />}
          title={search || statusFilter !== 'all' ? '没有匹配的连接' : '还没有连接'}
          description={
            can('credential:create') ? '添加连接，查看账户与用量。' : '请联系管理员添加连接或授予项目访问权限。'
          }
        />
      ) : (
        <div className={styles.grid}>
          {filtered.map((c) => (
            <article key={c.id} className={styles.card} aria-label={title(c) + ' ' + c.id}>
              <div className={styles.cardTop}>
                <div className={styles.identity}>
                  <span className={styles.icon}>
                    {c.mode === 'subscription_interactive' ? <Terminal size={21} /> : <Cable size={21} />}
                  </span>
                  <div>
                    <h2>{title(c)}</h2>
                    <p>
                      {modes[c.mode] ?? c.mode}
                      {c.accountPlan ? ` · ${c.accountPlan}` : ''}
                    </p>
                  </div>
                </div>
                <span
                  className={
                    ['已有观测', '已上报心跳', '已连接', '已连接 · Connected'].includes(state(c))
                      ? styles.badge
                      : styles.mutedBadge
                  }
                >
                  {state(c)}
                </span>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.metrics}>
                  <div>
                    <strong>{count(c.observedSessions)}</strong>
                    <span>本地会话</span>
                  </div>
                  <div>
                    <strong>{count(c.observedEvents)}</strong>
                    <span>用量记录</span>
                  </div>
                </div>
                <dl className={styles.details}>
                  <dt>绑定项目</dt>
                  <dd>{c.project_name ?? '未绑定 · 按工作目录归属'}</dd>
                  <dt>最近观测</dt>
                  <dd>{localDate(c.lastObservedAt)}</dd>
                  {c.mode !== 'subscription_interactive' && (
                    <>
                      <dt>最近心跳</dt>
                      <dd>{localDate(c.last_heartbeat_at)}</dd>
                    </>
                  )}
                </dl>
              </div>
              <div className={styles.footer}>
                <button
                  className={styles.link}
                  onClick={() => {
                    setSetup(c)
                    setFormError('')
                    setCopied(false)
                    setSource('')
                  }}
                >
                  {revoked(c) ? '查看记录' : '配置与详情'}
                  <ArrowUpRight size={14} />
                </button>
                {can('credential:disable') && !revoked(c) && (
                  <button
                    className={styles.dangerLink}
                    onClick={() => {
                      setRevoking(c)
                      setFormError('')
                    }}
                  >
                    撤销连接
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <HelpDetails label="连接与用量说明">
        添加连接后需完成配置。本地用量独立于官方额度与账单，撤销连接后仍保留历史记录。 API 模型调用请在渠道管理中配置。
      </HelpDetails>
      {creating && (
        <WorkspaceDialog title="添加连接" busy={busy} onClose={() => setCreating(false)}>
          <form className={styles.form} onSubmit={(e) => void create(e)}>
            <label className={styles.field}>
              连接类型
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                {Object.entries(modes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {value === 'subscription_interactive' ? 'OpenAI Codex · 本地订阅观测' : label}
                  </option>
                ))}
              </select>
            </label>
            {mode === 'subscription_interactive' ? (
              <>
                <WorkspaceNotice>使用本机已登录的 Codex，无需填写账号或密钥。</WorkspaceNotice>
                <label className={styles.field}>
                  Codex 供应商标识
                  <input
                    required
                    maxLength={80}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]*"
                    value={identifier}
                    aria-label="Codex 供应商标识"
                    aria-describedby="provider-identifier-help"
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                  <span className={styles.hint} id="provider-identifier-help">
                    官方订阅保留 openai；自定义配置需与 model_provider 一致。
                  </span>
                </label>
              </>
            ) : (
              <>
                <WorkspaceNotice>添加后需配置连接器。API 接入请前往渠道管理。</WorkspaceNotice>
                <label className={styles.field}>
                  供应商标识
                  <input
                    required
                    maxLength={80}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="openai / anthropic"
                  />
                </label>
              </>
            )}
            <label className={styles.field}>
              绑定项目（可选）
              <select
                value={projectId}
                aria-label="绑定项目（可选）"
                aria-describedby="connection-project-help"
                onChange={(e) => setProjectId(e.target.value)}
                disabled={projectData.loading || Boolean(projectData.error)}
              >
                <option value="">不绑定项目</option>
                {projectData.items.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className={styles.hint} id="connection-project-help">
                绑定项目控制访问范围；订阅用量按工作目录归属。
              </span>
            </label>
            {projectData.error && <WorkspaceNotice error>项目加载失败。请关闭弹窗刷新后重试。</WorkspaceNotice>}
            {formError && <WorkspaceNotice error>{formError}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} disabled={busy} onClick={() => setCreating(false)}>
                取消
              </button>
              <button className={styles.primary} disabled={busy}>
                {busy ? '添加中…' : '添加连接'}
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
      {revoking && (
        <WorkspaceDialog title="撤销连接" busy={busy} onClose={() => setRevoking(null)}>
          <div className={styles.form}>
            <p className={styles.description}>
              撤销「{title(revoking)}
              」后，此映射不能继续关联新的观测记录，连接器租约也会撤销。历史用量保留；重新接入需创建新连接。
            </p>
            {formError && <WorkspaceNotice error>{formError}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button className={styles.secondary} disabled={busy} onClick={() => setRevoking(null)}>
                取消
              </button>
              <button className={styles.danger} disabled={busy} onClick={() => void revoke()}>
                {busy ? '撤销中…' : '确认撤销'}
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
      {setup && (
        <WorkspaceDialog title={title(setup) + ' · 连接详情'} onClose={() => setSetup(null)}>
          <div className={styles.form}>
            {revoked(setup) && <WorkspaceNotice>连接已撤销，当前显示历史记录。</WorkspaceNotice>}
            {!revoked(setup) && setup.mode !== 'subscription_interactive' && (
              <WorkspaceNotice>已登记连接，可用状态请在渠道管理中查看。</WorkspaceNotice>
            )}
            {setup.mode === 'subscription_interactive' && (
              <CodexAccountPanel
                key={`account:${setup.id}`}
                connectionId={setup.id}
                revoked={revoked(connections.find((c) => c.id === setup.id) ?? setup)}
                refreshRevision={observerRevision}
                onSynced={() => void reload()}
              />
            )}
            {!revoked(setup) &&
              setup.mode === 'subscription_interactive' &&
              can('credential:create') &&
              session &&
              ['owner', 'admin'].includes(session.role) && (
                <ObserverPanel
                  key={`observer:${setup.id}`}
                  connectionId={setup.id}
                  source={source}
                  setSource={setSource}
                  disabled={pickingPath || projectData.loading || Boolean(projectData.error)}
                  onSynced={() => {
                    void reload()
                    setObserverRevision((revision) => revision + 1)
                  }}
                />
              )}
            <HelpDetails label="连接信息">
              <div>
                <div className={styles.toolbar}>
                  <span className={styles.hint}>连接 ID</span>
                  <button className={styles.link} onClick={() => void copyId()}>
                    <Copy size={13} />
                    {copied ? '已复制' : '复制 ID'}
                  </button>
                </div>
                <div className={styles.code}>{setup.id}</div>
              </div>
              <dl className={styles.details}>
                <dt>状态</dt>
                <dd>{state(connections.find((c) => c.id === setup.id) ?? setup)}</dd>
                <dt>数据来源</dt>
                <dd>
                  {setup.mode === 'subscription_interactive'
                    ? 'Codex App Server + Codex local telemetry'
                    : '连接登记 / 自报心跳'}
                </dd>
                <dt>历史观测</dt>
                <dd>
                  {count(setup.observedSessions)} 会话 / {count(setup.observedEvents)} 条记录
                </dd>
              </dl>
            </HelpDetails>
            {!revoked(setup) && setup.mode === 'subscription_interactive' && can('credential:create') && (
              <HelpDetails label="本地同步配置">
                <form className={styles.form} onSubmit={download}>
                  <ObserverPathField value={source} onChange={setSource} onBusyChange={setPickingPath} />
                  <button
                    className={styles.secondary}
                    disabled={pickingPath || projectData.loading || Boolean(projectData.error)}
                  >
                    <Download size={14} />
                    下载 Observer 配置
                  </button>
                  <p className={styles.hint}>应用配置后自动同步。下载的配置可用于备份或其他机器。</p>
                  <details>
                    <summary className={styles.hint}>开发与运维命令</summary>
                    <pre className={styles.code}>
                      {
                        'npm run observer:codex -- scan --config config/nexus-observer.json --dry-run\nnpm run observer:codex -- scan --config config/nexus-observer.json'
                      }
                    </pre>
                    <p className={styles.hint}>
                      CLI 按终端 DATABASE_URL、.env.observer.local、.env.local
                      的优先级读取数据库，请确保与页面使用同一个库。
                    </p>
                  </details>
                </form>
              </HelpDetails>
            )}

            {setup.mode !== 'subscription_interactive' && !revoked(setup) && (
              <Link className={styles.link} href="/channels">
                前往渠道管理
                <ArrowUpRight size={14} />
              </Link>
            )}
            {formError && <WorkspaceNotice error>{formError}</WorkspaceNotice>}
          </div>
        </WorkspaceDialog>
      )}
    </div>
  )
}
