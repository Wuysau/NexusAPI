'use client'

import { useState, type FormEvent } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Scale } from 'lucide-react'
import { apiSend, errorMessage } from './lib/api'
import { useApiData } from './lib/useApiData'
import { useHighRiskAction } from './lib/useHighRiskAction'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { Modal } from './Modal'
import { ReauthDialog } from './ReauthDialog'
import { Badge, fullDate, money, type BadgeTone } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'

interface CaseRow {
  id: string
  requestId: string | null
  status: string
  reason: string
  expectedAmount: string | null
  actualAmount: string | null
  currency: string | null
  resolution: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'warn',
  investigating: 'info',
  resolved: 'good',
  unresolved: 'danger',
}

const REASON_LABEL: Record<string, string> = {
  unknown_completion: '上游完成状态未知',
  amount_mismatch: '金额不一致',
  missing_event: '缺少用量事件',
  missing_usage: '缺少用量记录',
}

export function Reconciliation() {
  const { can } = useSession()
  const { notify } = useToast()
  const state = useApiData<{ cases: CaseRow[] }>('/api/billing/reconciliation')
  const highRisk = useHighRiskAction()
  const [target, setTarget] = useState<CaseRow | null>(null)
  const [busy, setBusy] = useState(false)

  const canManage = can('billing:manage')

  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!target) return
    const data = new FormData(event.currentTarget)
    const status = String(data.get('status'))
    const resolution = String(data.get('resolution') ?? '')
    const releaseHold = data.get('releaseHold') === 'on'
    setBusy(true)
    try {
      await highRisk.run(async () => {
        await apiSend('/api/billing/reconciliation', 'POST', {
          caseId: target.id,
          status,
          resolution,
          releaseHold,
        })
        notify('对账工单已处理')
        setTarget(null)
        state.reload()
      })
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (state.forbidden) return <PermissionDenied capability="billing:read" />

  const cases = state.data?.cases ?? []

  return (
    <>
      <div className="info-banner">
        <Scale size={19} />
        <div>
          <strong>结果未知的请求保留预占额度，确认后再处理。</strong>
        </div>
      </div>

      <section className="panel">
        {state.loading ? (
          <SkeletonRows rows={4} />
        ) : state.error && !state.data ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : cases.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={30} />} title="暂无对账工单" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>创建时间</th>
                  <th>原因</th>
                  <th>状态</th>
                  <th>预期金额</th>
                  <th>实际金额</th>
                  <th>处理说明</th>
                  {canManage && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => (
                  <tr key={row.id}>
                    <td className="muted">{fullDate(row.createdAt)}</td>
                    <td>
                      <Badge tone="warn">
                        <AlertTriangle size={11} /> {REASON_LABEL[row.reason] ?? row.reason}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[row.status] ?? 'muted'}>{row.status}</Badge>
                    </td>
                    <td className="tabular">{row.expectedAmount === null ? '—' : money(row.expectedAmount, 6)}</td>
                    <td className="tabular">{row.actualAmount === null ? '—' : money(row.actualAmount, 6)}</td>
                    <td className="muted">{row.resolution ?? '—'}</td>
                    {canManage && (
                      <td>
                        {row.status === 'resolved' || row.status === 'unresolved' ? (
                          <span className="muted tiny">已关闭</span>
                        ) : (
                          <button onClick={() => setTarget(row)}>处理</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {target && (
        <Modal title="处理对账工单" onClose={() => setTarget(null)} busy={busy}>
          <form onSubmit={resolve}>
            <div className="form-body">
              <p className="muted">
                请求 {target.requestId?.slice(0, 12) ?? '—'} · {REASON_LABEL[target.reason] ?? target.reason}
              </p>
              <label>
                处理结果
                <select name="status" defaultValue="resolved">
                  <option value="resolved">已确认并结清</option>
                  <option value="unresolved">无法确认（保持未决）</option>
                </select>
              </label>
              <label>
                处理说明
                <input name="resolution" required maxLength={500} placeholder="记录判定依据" />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" name="releaseHold" /> 释放该请求的预占额度（仅在确认未实际发生时勾选）
              </label>
              <p className="muted">释放预占会记录到账本，不直接改变余额。</p>
            </div>
            <div className="modal-footer">
              <button type="button" className="button" onClick={() => setTarget(null)}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />} 提交处理
              </button>
            </div>
          </form>
        </Modal>
      )}

      {highRisk.needsReauth && (
        <ReauthDialog
          onClose={highRisk.clear}
          onSuccess={async () => {
            await highRisk.retry().catch((error) => notify(errorMessage(error), 'error'))
          }}
        />
      )}
    </>
  )
}
