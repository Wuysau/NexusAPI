'use client'

import { useState, type FormEvent } from 'react'
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { apiSend, errorMessage } from './lib/api'
import { useApiData } from './lib/useApiData'
import { useHighRiskAction } from './lib/useHighRiskAction'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { Modal } from './Modal'
import { ReauthDialog } from './ReauthDialog'
import { CopyButton, Status, fullDate } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'

interface KeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  enabled: boolean
  status: 'active' | 'disabled' | 'revoked'
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

interface KeysResponse {
  keys: KeyRow[]
  scopes: string[]
  excludedDevelopmentKeys?: number
}

export function KeyManager() {
  const { can } = useSession()
  const { notify } = useToast()
  const state = useApiData<KeysResponse>('/api/keys')
  const highRisk = useHighRiskAction()
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const canCreate = can('apikey:create')
  const canManage = can('apikey:revoke')

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const scopes = data.getAll('scopes').map(String)
    const expiresAt = String(data.get('expiresAt') ?? '')
    try {
      setBusyId('create')
      const result = await apiSend<{ token: string }>('/api/keys', 'POST', {
        name: data.get('name'),
        scopes: scopes.length ? scopes : undefined,
        expiresAt: expiresAt || undefined,
      })
      setCreatedToken(result.token)
      state.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function toggle(key: KeyRow) {
    setBusyId(key.id)
    try {
      await apiSend(`/api/keys/${key.id}`, 'PATCH', { enabled: !key.enabled })
      notify(key.enabled ? '密钥已停用' : '密钥已启用')
      state.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(key: KeyRow) {
    setBusyId(key.id)
    try {
      const done = await highRisk.run(async () => {
        await apiSend(`/api/keys/${key.id}`, 'DELETE')
        notify('密钥已撤销')
        state.reload()
      })
      if (!done) return
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusyId(null)
    }
  }

  if (state.forbidden) return <PermissionDenied capability="apikey:read" />

  const keys = state.data?.keys ?? []
  const scopes = state.data?.scopes ?? []

  return (
    <>
      {Boolean(state.data?.excludedDevelopmentKeys) && (
        <p className="section-note">已隐藏开发示例密钥，请创建业务密钥。</p>
      )}
      {state.loading ? (
        <div className="panel">
          <SkeletonRows rows={4} />
        </div>
      ) : state.error && !state.data ? (
        <div className="panel">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      ) : (
        <>
          <div className="mini-stats">
            <div>
              <span>密钥总数</span>
              <strong>{keys.length}</strong>
              <KeyRound size={24} />
            </div>
            <div>
              <span>启用中的密钥</span>
              <strong>{keys.filter((k) => k.status === 'active').length}</strong>
              <ShieldCheck size={24} />
            </div>
            <div>
              <span>已撤销</span>
              <strong>{keys.filter((k) => k.status === 'revoked').length}</strong>
              <Trash2 size={24} />
            </div>
          </div>

          <section className="panel">
            <div className="toolbar">
              <h3>API 密钥</h3>
              {canCreate && (
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} /> 创建 API 密钥
                </button>
              )}
            </div>
            {keys.length === 0 ? (
              <EmptyState
                icon={<KeyRound size={32} />}
                title="尚未创建密钥"
                description="为应用创建一个独立密钥。"
                action={
                  canCreate ? (
                    <button className="text-link" onClick={() => setCreating(true)}>
                      创建第一个 API 密钥
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>名称 / 密钥</th>
                      <th>状态</th>
                      <th>权限范围</th>
                      <th>最近使用</th>
                      <th>创建时间</th>
                      {canManage && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((key) => (
                      <tr key={key.id}>
                        <td>
                          <div className="key-name">
                            <span className="key-icon">
                              <KeyRound size={18} />
                            </span>
                            <div>
                              <strong>{key.name}</strong>
                              <code>{key.prefix}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Status ok={key.status === 'active'}>
                            {key.status === 'active' ? '已启用' : key.status === 'disabled' ? '已停用' : '已撤销'}
                          </Status>
                        </td>
                        <td className="muted">{key.scopes.join(', ') || '—'}</td>
                        <td className="muted">{fullDate(key.lastUsedAt)}</td>
                        <td className="muted">{fullDate(key.createdAt)}</td>
                        {canManage && (
                          <td>
                            <div className="row-actions">
                              {key.status !== 'revoked' && (
                                <button disabled={busyId === key.id} onClick={() => toggle(key)}>
                                  {key.enabled ? '停用' : '启用'}
                                </button>
                              )}
                              {key.status !== 'revoked' && (
                                <button
                                  className="danger-icon"
                                  aria-label="撤销密钥"
                                  disabled={busyId === key.id}
                                  onClick={() => revoke(key)}
                                >
                                  {busyId === key.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={15} />}
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <div className="security-note">
            <ShieldCheck size={18} />
            <p>完整密钥仅显示一次，请在创建后保存。</p>
          </div>
          <HelpDetails label="密钥安全说明">
            <p>服务端仅保存密钥哈希。开发示例密钥不列为可用密钥，历史记录仍保留。</p>
          </HelpDetails>
        </>
      )}

      {creating && (
        <Modal
          title={createdToken ? '密钥创建成功' : '创建 API 密钥'}
          onClose={() => {
            setCreating(false)
            setCreatedToken('')
          }}
          busy={busyId === 'create'}
        >
          {createdToken ? (
            <div className="form-body">
              <div className="success-icon">
                <ShieldCheck size={26} />
              </div>
              <h3 className="center">密钥创建成功</h3>
              <p className="muted center">请立即复制保存，关闭后将无法再次查看完整密钥。</p>
              <div className="created-token">
                <code data-testid="created-key">{createdToken}</code>
                <CopyButton value={createdToken} label="复制新密钥" />
              </div>
              <button
                className="button primary full-width"
                onClick={() => {
                  setCreating(false)
                  setCreatedToken('')
                }}
              >
                我已保存
              </button>
            </div>
          ) : (
            <form onSubmit={createKey}>
              <div className="form-body">
                <label>
                  密钥名称
                  <input name="name" placeholder="例如：Production App" required maxLength={80} autoFocus />
                </label>
                <label>
                  过期时间（可选）
                  <input name="expiresAt" type="datetime-local" />
                </label>
                <label>权限范围</label>
                <div className="model-checkboxes">
                  {scopes.map((scope) => (
                    <label key={scope}>
                      <input type="checkbox" name="scopes" value={scope} defaultChecked={scope === 'chat:write'} />
                      {scope}
                    </label>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="button" onClick={() => setCreating(false)}>
                  取消
                </button>
                <button className="button primary" disabled={busyId === 'create'}>
                  {busyId === 'create' ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 创建密钥
                </button>
              </div>
            </form>
          )}
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
