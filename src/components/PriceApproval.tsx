'use client'

import { useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import { apiSend, errorMessage } from './lib/api'
import { useApiData } from './lib/useApiData'
import { useHighRiskAction } from './lib/useHighRiskAction'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { ReauthDialog } from './ReauthDialog'
import { WorkspaceDialog, WorkspaceNotice, WorkspaceToolbar } from './workspace/Workspace'
import styles from './workspace/workspace.module.css'
import { ProviderMark, fullDate } from './ui'
import { EmptyState, PermissionDenied, SkeletonRows } from './States'

interface ComponentChange {
  kind: string
  from: string | null
  to: string | null
  unit: string
}

interface Candidate {
  id: string
  provider: { id: string; code: string; name: string }
  upstreamModelId: string
  currency: string
  region: string
  status: string
  approvalBlocked: boolean
  baselineEvidence: string
  highRisk: boolean
  riskReasons: string[]
  effectiveFrom: string | null
  createdAt: string
  evidence: {
    kind: string
    sourceType: string | null
    sourceUrl: string | null
    contentSha256: string | null
    retrievedAt: string | null
    parserVersion: string | null
    rawEvidenceRef: string | null
  }
  components: { kind: string; unit: string; amount: string }[]
  diff: { changed: boolean; changes: ComponentChange[] }
}

const STATUS_LABEL: Record<string, string> = {
  fetched: '已抓取',
  validated: '已校验',
  pending_approval: '待审批',
  scheduled: '已排期',
}

const COMPONENT_LABEL: Record<string, string> = {
  input: '输入',
  output: '输出',
  cached_input: '缓存输入',
  cache_read: '缓存读取',
  cache_write: '缓存写入',
  reasoning: '推理',
}
function priceText(value: string) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}
function unitText(value: string) {
  return (
    (
      {
        per_million_tokens: '每百万 tokens',
        per_thousand_tokens: '每千 tokens',
        per_token: '每 token',
        per_request: '每请求',
      } as Record<string, string>
    )[value] ?? value
  )
}

export function PriceApproval() {
  const { can, session } = useSession()
  const { notify } = useToast()
  const state = useApiData<{ candidates: Candidate[] }>('/api/pricing')
  const highRisk = useHighRiskAction()
  const [target, setTarget] = useState<Candidate | null>(null)
  const [action, setAction] = useState<'approve' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [risk, setRisk] = useState('all')

  const canApprove = can('pricing:approve')

  async function confirm(reason: string, effectiveFrom: string) {
    if (!target || !action || (action === 'approve' && target.approvalBlocked)) return
    setBusy(true)
    try {
      await highRisk.run(async () => {
        await apiSend('/api/pricing', 'POST', {
          candidateId: target.id,
          action,
          reason: reason || undefined,
          effectiveFrom: action === 'approve' && effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
        })
        notify(action === 'approve' ? '价格已批准' : '价格候选已拒绝')
        setAction(null)
        setTarget(null)
        state.reload()
      })
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (state.forbidden) return <PermissionDenied capability="pricing:read" />

  const candidates = state.data?.candidates ?? []

  const filtered = candidates.filter(
    (c) =>
      (status === 'all' || c.status === status) &&
      (risk === 'all' || (risk === 'high' ? c.highRisk : !c.highRisk)) &&
      [c.upstreamModelId, c.provider.name, c.provider.code].join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <div className={styles.shell}>
      <div className={styles.overview}>
        <div>
          <span>待处理候选</span>
          <strong>{candidates.filter((c) => c.status !== 'scheduled').length}</strong>
          <small>审核差异与来源后作出决定</small>
        </div>
        <div>
          <span>高风险变更</span>
          <strong>{candidates.filter((c) => c.highRisk).length}</strong>
          <small>需要人工核对风险原因</small>
        </div>
        <div>
          <span>已排期</span>
          <strong>{candidates.filter((c) => c.status === 'scheduled').length}</strong>
          <small>等待计划生效时间</small>
        </div>
      </div>
      <WorkspaceNotice>
        <AlertTriangle size={17} />
        价格变更需要人工批准。提交审批时会检查身份验证是否有效，并记录决策依据。
      </WorkspaceNotice>
      <WorkspaceToolbar
        search={search}
        setSearch={setSearch}
        label="搜索模型或供应商"
        loading={state.loading}
        reload={async () => state.reload()}
      >
        <select
          className={styles.filterSelect}
          aria-label="候选状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className={styles.filterSelect}
          aria-label="风险级别"
          value={risk}
          onChange={(e) => setRisk(e.target.value)}
        >
          <option value="all">全部风险</option>
          <option value="high">高风险</option>
          <option value="normal">普通变更</option>
        </select>
      </WorkspaceToolbar>
      {state.error && <WorkspaceNotice error>{state.error}</WorkspaceNotice>}
      {state.loading ? (
        <section className={styles.card}>
          <SkeletonRows rows={3} />
        </section>
      ) : !filtered.length ? (
        <section className={styles.card}>
          <EmptyState
            icon={<CheckCircle2 size={30} />}
            title={candidates.length ? '没有匹配的候选' : '没有待审批的价格'}
            description={candidates.length ? '调整搜索或筛选条件。' : '价格同步产生新候选后会显示在这里。'}
          />
        </section>
      ) : (
        filtered.map((candidate) => (
          <article className={styles.card} key={candidate.id}>
            <div className={styles.cardTop}>
              <div className={styles.identity}>
                <ProviderMark code={candidate.provider.code} />
                <div>
                  <h2>{candidate.upstreamModelId}</h2>
                  <p>
                    {candidate.provider.name} · {candidate.region} · {candidate.currency}
                  </p>
                </div>
              </div>
              <div className={styles.footerActions}>
                <span className={styles.mutedBadge}>{STATUS_LABEL[candidate.status] ?? candidate.status}</span>
                {candidate.highRisk && (
                  <span className={styles.riskBadge}>
                    <AlertTriangle size={12} />
                    高风险
                  </span>
                )}
              </div>
            </div>
            <div className={styles.cardBody}>
              {candidate.approvalBlocked && (
                <WorkspaceNotice>演示价格来源，不能批准或生效。请提交真实来源的价格候选。</WorkspaceNotice>
              )}
              {candidate.riskReasons.length > 0 && (
                <div className={styles.riskReasons}>
                  {candidate.riskReasons.map((reason) => (
                    <span key={reason}>
                      <AlertTriangle size={13} />
                      {reason}
                    </span>
                  ))}
                </div>
              )}
              <div className={styles.sectionHeading}>
                <h3>价格差异</h3>
                <span>{candidate.currency} · 按各项计价单位比较</span>
              </div>
              {candidate.baselineEvidence === 'demo_excluded' && (
                <p className={styles.hint}>已有演示价格不作正式比较依据，当前价格显示为未知。</p>
              )}
              {!candidate.diff.changes.length ? (
                <p className={styles.description}>与当前生效版本一致，无差异。</p>
              ) : (
                <div className={styles.tableScroll}>
                  <table className={styles.comparisonTable}>
                    <thead>
                      <tr>
                        <th>计价项</th>
                        <th>当前价格</th>
                        <th>候选价格</th>
                        <th>计价单位</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidate.diff.changes.map((change) => (
                        <tr key={change.kind}>
                          <td>{COMPONENT_LABEL[change.kind] ?? change.kind}</td>
                          <td>{change.from === null ? '—' : priceText(change.from)}</td>
                          <td className={styles.proposedPrice}>
                            {change.to === null ? '移除' : priceText(change.to)}
                            {change.from === null && <small>新增</small>}
                          </td>
                          <td>{unitText(change.unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <details className={styles.evidenceDetails}>
                <summary>
                  来源证据
                  <span>
                    {candidate.evidence.kind === 'demo' ? '演示来源' : (candidate.evidence.sourceType ?? '未知来源')} ·{' '}
                    {fullDate(candidate.evidence.retrievedAt)}
                  </span>
                </summary>
                <dl className={styles.details}>
                  <dt>候选记录</dt>
                  <dd>{candidate.id}</dd>
                  <dt>来源类型</dt>
                  <dd>
                    {candidate.evidence.kind === 'demo'
                      ? '演示占位来源（非官方证据）'
                      : (candidate.evidence.sourceType ?? '未知')}
                  </dd>
                  <dt>解析器版本</dt>
                  <dd>{candidate.evidence.parserVersion ?? '—'}</dd>
                  <dt>抓取时间</dt>
                  <dd>{fullDate(candidate.evidence.retrievedAt)}</dd>
                  <dt>内容哈希</dt>
                  <dd className={styles.modelId}>{candidate.evidence.contentSha256 ?? '—'}</dd>
                  <dt>来源页面</dt>
                  <dd>
                    {candidate.evidence.sourceUrl && /^https?:\/\//i.test(candidate.evidence.sourceUrl) ? (
                      <a className={styles.link} href={candidate.evidence.sourceUrl} target="_blank" rel="noreferrer">
                        {candidate.evidence.sourceUrl}
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      (candidate.evidence.sourceUrl ?? '—')
                    )}
                  </dd>
                </dl>
              </details>
            </div>
            <div className={styles.footer}>
              <span className={styles.hint}>
                {candidate.effectiveFrom ? (
                  <>
                    <CalendarClock size={13} />
                    计划生效：{fullDate(candidate.effectiveFrom)}
                  </>
                ) : (
                  `创建于 ${fullDate(candidate.createdAt)}`
                )}
              </span>
              {canApprove && candidate.status !== 'scheduled' ? (
                <div className={styles.footerActions}>
                  <button
                    className={styles.secondary}
                    onClick={() => {
                      setTarget(candidate)
                      setAction('reject')
                    }}
                  >
                    <XCircle size={15} />
                    拒绝
                  </button>
                  <button
                    className={styles.primary}
                    disabled={candidate.approvalBlocked}
                    onClick={() => {
                      setTarget(candidate)
                      setAction('approve')
                    }}
                  >
                    <CheckCircle2 size={15} />
                    批准
                  </button>
                </div>
              ) : (
                <span className={styles.hint}>
                  {candidate.approvalBlocked
                    ? '演示来源不能生效'
                    : candidate.status === 'scheduled'
                      ? '已批准，等待生效'
                      : '当前角色仅可查看'}
                </span>
              )}
            </div>
          </article>
        ))
      )}
      {action && target && !highRisk.needsReauth && (
        <DecisionModal
          action={action}
          candidate={target}
          busy={busy}
          freshAuth={session?.freshAuth ?? false}
          onClose={() => {
            setAction(null)
            setTarget(null)
          }}
          onConfirm={confirm}
        />
      )}
      {highRisk.needsReauth && (
        <ReauthDialog
          onClose={() => {
            highRisk.clear()
            setAction(null)
            setTarget(null)
          }}
          onSuccess={async () => {
            setBusy(true)
            try {
              await highRisk.retry()
            } catch (error) {
              notify(errorMessage(error), 'error')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </div>
  )
}

function DecisionModal({
  action,
  candidate,
  busy,
  freshAuth,
  onClose,
  onConfirm,
}: {
  action: 'approve' | 'reject'
  candidate: Candidate
  busy: boolean
  freshAuth: boolean
  onClose: () => void
  onConfirm: (reason: string, effectiveFrom: string) => void
}) {
  const [reason, setReason] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')

  return (
    <WorkspaceDialog
      title={
        action === 'approve' ? `批准价格 · ${candidate.upstreamModelId}` : `拒绝候选 · ${candidate.upstreamModelId}`
      }
      onClose={onClose}
      busy={busy}
    >
      <div className={styles.form}>
        {!freshAuth && (
          <div className={styles.notice}>
            <AlertTriangle size={15} /> 当前会话已超过 15 分钟的新鲜认证窗口，提交时会要求重新输入密码。
          </div>
        )}
        {action === 'approve' && (
          <label className={styles.field}>
            生效时间（留空立即生效）
            <input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              data-testid="effective-from"
            />
          </label>
        )}
        <label className={styles.field}>
          {action === 'approve' ? '审批说明（可选）' : '拒绝原因'}
          <input
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="记录决策依据"
          />
        </label>
        <p className={styles.hint}>
          {action === 'approve'
            ? '批准后将按生效时间发布新的价格版本；高风险变更会记录人工覆盖原因。'
            : '拒绝后该候选不会生效，当前价格版本保持不变。'}
        </p>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className={action === 'approve' ? styles.primary : styles.danger}
            disabled={busy || (action === 'reject' && !reason.trim())}
            onClick={() => onConfirm(reason.trim(), effectiveFrom)}
            data-testid="confirm-decision"
          >
            {action === 'approve' ? '确认批准' : '确认拒绝'}
          </button>
        </div>
      </div>
    </WorkspaceDialog>
  )
}
