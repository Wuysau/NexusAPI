'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Plus, Eye, Pencil, Trash2, RotateCcw, Layers3 } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { useApiData } from './lib/useApiData'
import { apiSend, errorMessage } from './lib/api'
import { useSession } from './SessionProvider'
import { ProviderMark } from './ui'
import { EmptyState, PermissionDenied, SkeletonRows } from './States'
import { WorkspaceDialog, WorkspaceNotice, WorkspaceToolbar, localDate } from './workspace/Workspace'
import styles from './workspace/workspace.module.css'

interface ModelEntry {
  id: string
  provider: { id: string; code: string; name: string }
  upstreamModelId: string
  displayName: string
  contextWindow: number | null
  capabilities: string[]
  lifecycleStatus: string
  available: boolean
  pendingCandidates: number
  lastSeenAt?: string
  evidence?: { kind: string; recordId: string }
  priceEvidence?: { kind: string; versionId: string | null; sourceUrl: string | null; fetchedAt: string | null }
  price: {
    versionId: string
    currency: string | null
    status: string | null
    effectiveFrom: string | null
    fetchedAt: string | null
    source: { type: string | null; url: string | null }
    components: { kind: string; unit: string; amount: string }[]
  } | null
}

interface Configuration {
  id: string
  providerId: string
  upstreamModelId: string
  displayName: string
  notes: string
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
interface CatalogResponse {
  models: ModelEntry[]
  demoModels: ModelEntry[]
  configurations: Configuration[]
  providers: ModelEntry['provider'][]
}
type Entry = { model: ModelEntry; configuration?: Configuration }

export function ModelGrid() {
  const state = useApiData<CatalogResponse>('/api/models')
  const { can } = useSession()
  const [scope, setScope] = useState('organization')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [action, setAction] = useState<'add' | 'edit' | 'detail' | 'remove' | 'restore' | null>(null)
  const [target, setTarget] = useState<Entry | null>(null)
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const models = state.data?.models ?? []
  const demoModels = state.data?.demoModels ?? []
  const configurations = state.data?.configurations ?? []
  const providers = state.data?.providers ?? []
  const key = (provider: string, model: string) => JSON.stringify([provider, model])
  const byModel = new Map([...demoModels, ...models].map((m) => [key(m.provider.id, m.upstreamModelId), m]))
  const byConfig = new Map(configurations.map((c) => [key(c.providerId, c.upstreamModelId), c]))
  const orgEntries: Entry[] = configurations.map((c) => ({
    configuration: c,
    model: byModel.get(key(c.providerId, c.upstreamModelId)) ?? {
      id: c.id,
      provider: providers.find((p) => p.id === c.providerId) ?? {
        id: c.providerId,
        code: 'unknown',
        name: '未启用的供应商',
      },
      upstreamModelId: c.upstreamModelId,
      displayName: c.displayName,
      contextWindow: null,
      capabilities: [],
      lifecycleStatus: 'unlisted',
      available: false,
      pendingCandidates: 0,
      price: null,
    },
  }))
  const entries: Entry[] =
    scope === 'catalog' || scope === 'demo'
      ? (scope === 'demo' ? demoModels : models).map((m) => ({
          model: m,
          configuration: byConfig.get(key(m.provider.id, m.upstreamModelId)),
        }))
      : orgEntries.filter((e) =>
          scope === 'removed' ? Boolean(e.configuration?.archivedAt) : !e.configuration?.archivedAt,
        )
  const filtered = entries.filter(
    (e) =>
      (filter === 'all' || e.model.provider.id === filter) &&
      [e.configuration?.displayName, e.model.displayName, e.model.upstreamModelId, e.configuration?.notes]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  function open(next: typeof action, entry: Entry | null = null) {
    setAction(next)
    setTarget(entry)
    setError('')
    setProviderId(entry?.model.provider.id ?? providers[0]?.id ?? '')
    setModelId(entry?.model.upstreamModelId ?? '')
    setName(entry?.configuration?.displayName ?? entry?.model.displayName ?? '')
    setNotes(entry?.configuration?.notes ?? '')
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !action || action === 'detail') return
    setBusy(true)
    setError('')
    try {
      await apiSend(
        action === 'add'
          ? '/api/models/configurations'
          : `/api/models/configurations/${encodeURIComponent(target!.configuration!.id)}`,
        action === 'add' ? 'POST' : action === 'remove' ? 'DELETE' : 'PATCH',
        action === 'add'
          ? { providerId, upstreamModelId: modelId.trim(), displayName: name.trim(), notes }
          : {
              expectedVersion: target!.configuration!.version,
              ...(action === 'edit'
                ? { displayName: name.trim(), notes }
                : action === 'restore'
                  ? { archived: false }
                  : {}),
            },
      )
      setNotice(action === 'remove' ? '组织模型配置已移除，可在已移除列表恢复。' : '组织模型配置已保存。')
      setAction(null)
      state.reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  if (state.forbidden) return <PermissionDenied capability="pricing:read" />
  return (
    <div className={styles.shell}>
      <div className={styles.overview}>
        <div>
          <span>组织模型配置</span>
          <strong>{configurations.filter((c) => !c.archivedAt).length}</strong>
        </div>
        <div>
          <span>供应商目录</span>
          <strong>{models.length}</strong>
        </div>
        <div>
          <span>已移除配置</span>
          <strong>{configurations.filter((c) => c.archivedAt).length}</strong>
          <small>可恢复</small>
        </div>
      </div>
      <div className={styles.tabs} aria-label="模型范围">
        {[
          ['organization', '组织模型'],
          ['catalog', '供应商目录'],
          ...(demoModels.length ? [['demo', `演示记录 (${demoModels.length})`]] : []),
          ['removed', '已移除'],
        ].map(([value, label]) => (
          <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>
            {label}
          </button>
        ))}
      </div>
      <WorkspaceToolbar
        search={query}
        setSearch={setQuery}
        label="搜索模型名称、ID 或备注"
        loading={state.loading}
        reload={async () => state.reload()}
      >
        <select
          className={styles.filterSelect}
          aria-label="筛选供应商"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部供应商</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {can('model:manage') && (
          <button className={styles.primary} onClick={() => open('add')} disabled={!providers.length}>
            <Plus size={15} />
            添加模型配置
          </button>
        )}
      </WorkspaceToolbar>
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {demoModels.length > 0 && (
        <WorkspaceNotice>{demoModels.length} 条演示记录 · 能力与价格未验证，不计入供应商目录。</WorkspaceNotice>
      )}
      {state.error && <WorkspaceNotice error>{state.error}</WorkspaceNotice>}
      {state.loading ? (
        <SkeletonRows rows={3} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Layers3 size={30} />}
          title={
            query || filter !== 'all'
              ? '没有匹配的模型'
              : scope === 'catalog'
                ? '供应商目录暂无模型'
                : scope === 'removed'
                  ? '没有已移除的配置'
                  : '尚未添加组织模型'
          }
          description={
            query || filter !== 'all'
              ? '试试其他关键词或供应商。'
              : scope === 'organization'
                ? '从供应商目录添加，或填写模型 ID。'
                : undefined
          }
        />
      ) : (
        <div className={styles.grid}>
          {filtered.map((entry) => {
            const { model: m, configuration: c } = entry
            return (
              <article className={styles.card} key={key(m.provider.id, m.upstreamModelId)}>
                <div className={styles.cardTop}>
                  <div className={styles.identity}>
                    <ProviderMark code={m.provider.code} />
                    <div>
                      <h2>{c?.displayName ?? m.displayName}</h2>
                      <p>{m.provider.name}</p>
                    </div>
                  </div>
                  <span className={c && !c.archivedAt ? styles.badge : styles.mutedBadge}>
                    {m.evidence?.kind === 'demo'
                      ? '演示记录'
                      : c?.archivedAt
                        ? '已移除'
                        : c
                          ? '组织已配置'
                          : '供应商目录'}
                  </span>
                </div>
                <div className={styles.cardBody}>
                  <p className={styles.modelId}>{m.upstreamModelId}</p>
                  {(c?.notes || m.lifecycleStatus === 'unlisted') && (
                    <p className={styles.description}>{c?.notes || '目录未收录，能力与价格未知。'}</p>
                  )}
                  <dl className={styles.details}>
                    <dt>目录状态</dt>
                    <dd>
                      {m.evidence?.kind === 'demo'
                        ? '演示 · 未验证'
                        : m.lifecycleStatus === 'unlisted'
                          ? '尚未发现'
                          : m.available
                            ? '目录标记可用'
                            : '目录标记不可用'}
                    </dd>
                    <dt>上下文窗口</dt>
                    <dd>{m.contextWindow?.toLocaleString('zh-CN') ?? '未知'}</dd>
                    <dt>价格</dt>
                    <dd>
                      {m.price
                        ? `${m.price.currency ?? '—'} · ${m.price.status === 'active' ? '已生效' : '待生效'}`
                        : m.priceEvidence?.kind === 'demo'
                          ? '演示价格 · 不作正式依据'
                          : '暂无生效价格'}
                    </dd>
                  </dl>
                </div>
                <div className={styles.footer}>
                  <button className={styles.link} onClick={() => open('detail', entry)}>
                    <Eye size={13} />
                    详情
                  </button>
                  {can('model:manage') && (
                    <div className={styles.footerActions}>
                      {!c ? (
                        <button className={styles.link} onClick={() => open('add', entry)}>
                          <Plus size={13} />
                          添加到组织
                        </button>
                      ) : c.archivedAt ? (
                        <button className={styles.link} onClick={() => open('restore', entry)}>
                          <RotateCcw size={13} />
                          恢复
                        </button>
                      ) : (
                        <>
                          <button className={styles.link} onClick={() => open('edit', entry)}>
                            <Pencil size={13} />
                            编辑
                          </button>
                          <button className={styles.dangerLink} onClick={() => open('remove', entry)}>
                            <Trash2 size={13} />
                            移除
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
      <HelpDetails label="模型配置与调用权限">
        <p>配置保存名称与备注。调用需有效连接与项目策略；目录价格经审批后生效。</p>
      </HelpDetails>
      {action && (
        <WorkspaceDialog
          title={
            action === 'add'
              ? '添加组织模型'
              : action === 'edit'
                ? '编辑模型配置'
                : action === 'detail'
                  ? '模型详情'
                  : action === 'restore'
                    ? '恢复模型配置'
                    : '移除模型配置'
          }
          busy={busy}
          onClose={() => setAction(null)}
        >
          <form className={styles.form} onSubmit={(e) => void save(e)}>
            {action === 'detail' && target ? (
              <>
                <dl className={styles.details}>
                  <dt>模型名称</dt>
                  <dd>{target.configuration?.displayName ?? target.model.displayName}</dd>
                  <dt>模型 ID</dt>
                  <dd>{target.model.upstreamModelId}</dd>
                  <dt>供应商</dt>
                  <dd>{target.model.provider.name}</dd>
                  <dt>数据来源</dt>
                  <dd>
                    {target.model.evidence?.kind === 'demo'
                      ? '开发演示记录，真实能力与价格未验证'
                      : target.model.evidence
                        ? '供应商目录记录，实际调用需有效连接与策略'
                        : '组织手动配置，尚无目录证据'}
                  </dd>
                  {target.model.evidence && (
                    <>
                      <dt>目录记录</dt>
                      <dd>{target.model.evidence.recordId}</dd>
                      <dt>最后发现</dt>
                      <dd>{localDate(target.model.lastSeenAt ?? null)}</dd>
                    </>
                  )}
                  <dt>能力</dt>
                  <dd>{target.model.capabilities.join(' · ') || '未知'}</dd>
                  <dt>组织备注</dt>
                  <dd>{target.configuration?.notes || '未填写'}</dd>
                  {target.configuration && (
                    <>
                      <dt>配置更新时间</dt>
                      <dd>{localDate(target.configuration.updatedAt)}</dd>
                    </>
                  )}
                </dl>
                <h3>目录价格</h3>
                {target.model.price ? (
                  <>
                    <p className={styles.hint}>
                      {target.model.price.currency} · 生效于 {localDate(target.model.price.effectiveFrom)}
                    </p>
                    <dl className={styles.details}>
                      <dt>价格版本</dt>
                      <dd>{target.model.price.versionId}</dd>
                      <dt>获取时间</dt>
                      <dd>{localDate(target.model.price.fetchedAt)}</dd>
                      <dt>来源</dt>
                      <dd>{target.model.price.source.type ?? '未知'}</dd>
                      <dt>来源页面</dt>
                      <dd>
                        {target.model.price.source.url && /^https?:\/\//i.test(target.model.price.source.url) ? (
                          <a
                            className={styles.link}
                            href={target.model.price.source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看价格来源
                          </a>
                        ) : (
                          (target.model.price.source.url ?? '未提供')
                        )}
                      </dd>
                      {target.model.price.components.map((c) => (
                        <div className={styles.priceComponent} key={c.kind}>
                          <dt>
                            {c.kind} / {c.unit}
                          </dt>
                          <dd>
                            {c.amount} {target.model.price!.currency}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : (
                  <p className={styles.hint}>
                    {target.model.priceEvidence?.kind === 'demo'
                      ? `已保留演示价格记录 ${target.model.priceEvidence.versionId ?? ''}，来源 ${target.model.priceEvidence.sourceUrl ?? '未知'}，不作正式价格依据。`
                      : '暂无生效价格'}
                  </p>
                )}
                <Link className={styles.link} href="/pricing">
                  查看价格审批与来源证据
                </Link>
              </>
            ) : action === 'remove' || action === 'restore' ? (
              <p className={styles.description}>
                {action === 'remove'
                  ? `移除「${name}」在当前组织保存的配置？可稍后恢复；共享模型目录、连接和历史用量不会被删除。`
                  : `将「${name}」恢复到当前组织的模型列表。`}
              </p>
            ) : (
              <>
                <p className={styles.hint}>保存模型配置不会自动开通调用。</p>
                <label className={styles.field}>
                  供应商
                  <select
                    required
                    disabled={action === 'edit'}
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  模型 ID
                  <input
                    required
                    disabled={action === 'edit'}
                    maxLength={200}
                    list="catalog-model-options"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="供应商的模型标识"
                  />
                  <datalist id="catalog-model-options">
                    {models
                      .filter((m) => m.provider.id === providerId)
                      .map((m) => (
                        <option key={m.id} value={m.upstreamModelId}>
                          {m.displayName}
                        </option>
                      ))}
                  </datalist>
                  <span className={styles.hint}>可从目录选择或手动填写；创建后不可修改供应商和模型 ID。</span>
                </label>
                <label className={styles.field}>
                  显示名称
                  <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className={styles.field}>
                  备注
                  <textarea
                    maxLength={2000}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="例如适用场景、选型说明"
                  />
                </label>
              </>
            )}
            {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button className={styles.secondary} type="button" disabled={busy} onClick={() => setAction(null)}>
                {action === 'detail' ? '关闭' : '取消'}
              </button>
              {action !== 'detail' && (
                <button className={action === 'remove' ? styles.danger : styles.primary} disabled={busy}>
                  {busy ? '处理中…' : action === 'remove' ? '确认移除' : action === 'restore' ? '确认恢复' : '保存配置'}
                </button>
              )}
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </div>
  )
}
