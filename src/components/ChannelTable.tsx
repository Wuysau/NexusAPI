'use client'

import { useState, type FormEvent } from 'react'
import { Loader2, Network, Plus, RotateCcw, Trash2, Zap } from 'lucide-react'
import { channelConfigurationState } from '@/lib/channels/configuration'
import { apiSend, errorMessage } from './lib/api'
import { useApiData } from './lib/useApiData'
import { useHighRiskAction } from './lib/useHighRiskAction'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { Modal } from './Modal'
import { ReauthDialog } from './ReauthDialog'
import { Badge, ProviderMark, fullDate } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'
import { SUBSCRIPTION_PRODUCTS, getSubscriptionProduct } from '@/lib/subscriptions/catalog'

interface Channel {
  id: string
  name: string
  provider: { id: string; code: string; name: string }
  capabilities: string[]
  region: string
  weight: number
  priority: number
  enabled: boolean
  isPlatform: boolean
  createdAt: string
  baseUrl: string
  protocol: 'openai' | 'anthropic' | null
  model: string | null
  models: string[]
  verification?: Verification | null
  credential: {
    id: string
    name: string | null
    enabled: boolean | null
    fingerprint: string | null
    lastVerifiedAt: string | null
    credentialType: string | null
    isPlatformManaged: boolean
    storage: 'local' | 'external'
  } | null
}

interface Verification {
  checkedAt: string
  ok: boolean
  status: string | number
  inputTokens?: string | null
  outputTokens?: string | null
  responseId?: string | null
}

interface ChannelsResponse {
  channels: Channel[]
  capabilities: string[]
  providers: { id: string; code: string; name: string; baseUrl?: string }[]
  localKeyInput: boolean
}

const CONFIGURATION_LABELS = {
  disabled: '渠道已停用',
  missing_credential: '未配置凭据',
  credential_disabled: '凭据已禁用',
  credential_unknown: '凭据状态未知',
  reference_recorded: '已记录凭据引用',
} as const

export function ChannelTable({ compact = false }: { compact?: boolean }) {
  const { can } = useSession()
  const { notify } = useToast()
  const state = useApiData<ChannelsResponse>('/api/channels')
  const highRisk = useHighRiskAction()
  const [dialog, setDialog] = useState<'create' | 'rotate' | null>(null)
  const [target, setTarget] = useState<Channel | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [providerRef, setProviderRef] = useState('')
  const [presetId, setPresetId] = useState('')

  const canCreate = can('credential:create')
  const canRotate = can('credential:rotate')
  const canDisable = can('credential:disable')
  const localKeyInput = state.data?.localKeyInput === true
  const actionBusy = busy || highRisk.busy || highRisk.needsReauth

  function closeDialog() {
    highRisk.clear()
    setDialog(null)
    setTarget(null)
  }

  function openCreate() {
    const product = getSubscriptionProduct(new URLSearchParams(window.location.search).get('subscriptionProduct') ?? '')
    const preset = localKeyInput ? product?.channelPreset : undefined
    setBaseUrl(preset?.baseUrl ?? '')
    setProtocol(preset?.protocol ?? 'openai')
    setProviderRef(
      preset ? (state.data?.providers.find((provider) => provider.code === product?.provider)?.id ?? 'custom') : '',
    )
    setPresetId(preset ? product!.id : '')
    setDialog('create')
  }

  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    try {
      await apiSend('/api/channels', 'POST', {
        name: data.get('name'),
        provider: data.get('provider'),
        ...(localKeyInput
          ? {
              secret: data.get('secret'),
              baseUrl: data.get('baseUrl'),
              protocol: data.get('protocol'),
              models: String(data.get('models') ?? '')
                .split(/\r?\n/)
                .map((model) => model.trim())
                .filter(Boolean),
            }
          : {
              credentialId: data.get('credentialId'),
              credentialVersion: Number(data.get('credentialVersion')),
            }),
        weight: Number(data.get('weight') ?? 10),
        capabilities: data.getAll('capabilities').map(String),
      })
      form.reset()
      notify(localKeyInput ? '渠道和 API Key 已保存，可手动测试连接' : '渠道已创建')
      closeDialog()
      state.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function replaceKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!target) return
    const form = event.currentTarget
    const secret = new FormData(form).get('secret')
    const channelId = target.id
    setBusy(true)
    try {
      await highRisk.run(async () => {
        await apiSend(`/api/channels/${channelId}`, 'PATCH', { secret })
        form.reset()
        notify('API Key 已替换，可重新测试连接')
        closeDialog()
        state.reload()
      })
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(channel: Channel) {
    setBusy(true)
    setTestingId(channel.id)
    try {
      const { verification } = await apiSend<{ verification: Verification }>(`/api/channels/${channel.id}/test`, 'POST')
      notify(
        verification.ok ? '上游连接测试成功' : `上游连接测试未通过（${verification.status}）`,
        verification.ok ? 'success' : 'error',
      )
      state.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
      setTestingId(null)
    }
  }

  async function toggle(channel: Channel) {
    setBusy(true)
    try {
      await apiSend(`/api/channels/${channel.id}`, 'PATCH', { enabled: !channel.enabled })
      notify(channel.enabled ? '渠道已停用' : '渠道已启用')
      state.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function disable(channel: Channel) {
    setBusy(true)
    try {
      await highRisk.run(async () => {
        await apiSend(`/api/channels/${channel.id}`, 'DELETE')
        notify('渠道已停用并禁用其凭据')
        state.reload()
      })
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (state.forbidden) return <PermissionDenied capability="credential:read" />

  const channels = state.data?.channels ?? []
  const providers = state.data?.providers ?? []
  const capabilities = state.data?.capabilities ?? ['chat']
  const visible = compact ? channels.slice(0, 4) : channels

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div className="inline-heading">
            <h3>渠道状态</h3>
            <span className="number-badge">{channels.length}</span>
          </div>
          {canCreate && !compact && (
            <button className="button primary" disabled={actionBusy || state.loading} onClick={openCreate}>
              <Plus size={16} /> 添加渠道
            </button>
          )}
        </div>

        {state.loading ? (
          <SkeletonRows rows={3} />
        ) : state.error && !state.data ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : channels.length === 0 ? (
          <EmptyState
            icon={<Network size={30} />}
            title="暂无渠道"
            description={localKeyInput ? '添加上游地址、模型和 API Key。' : '添加已注册的上游凭据。'}
            action={
              canCreate && !compact ? (
                <button className="text-link" onClick={openCreate} disabled={actionBusy}>
                  添加您的第一个渠道
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="channel-table">
              <thead>
                <tr>
                  <th>渠道名称</th>
                  <th>状态</th>
                  <th>凭据</th>
                  {!compact && <th>最近测试</th>}
                  <th>权重</th>
                  <th>区域</th>
                  {!compact && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((channel) => (
                  <tr key={channel.id}>
                    <td>
                      <span className="provider-cell">
                        <ProviderMark code={channel.provider.code} small />
                        <span>
                          <span>{channel.name}</span>
                          {!compact && channel.baseUrl && (
                            <span
                              className="muted tiny"
                              style={{
                                display: 'block',
                                maxWidth: 240,
                                whiteSpace: 'normal',
                                overflowWrap: 'anywhere',
                                marginTop: 6,
                              }}
                            >
                              {channel.baseUrl}
                              {channel.protocol && (
                                <span style={{ display: 'block' }}>
                                  {channel.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}
                                  {channel.models.length ? ` · ${channel.models.join('、')}` : ''}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td>
                      <Badge tone={channelConfigurationState(channel) === 'reference_recorded' ? 'info' : 'warn'}>
                        {channelConfigurationState(channel) === 'reference_recorded' &&
                        channel.credential?.storage === 'local'
                          ? 'API Key 已保存'
                          : CONFIGURATION_LABELS[channelConfigurationState(channel)]}
                      </Badge>
                    </td>
                    <td className="muted">
                      {channel.credential
                        ? `${channel.credential.storage === 'local' ? '本地加密保存' : (channel.credential.name ?? '凭据引用')}${channel.credential.isPlatformManaged ? '（平台管理）' : ''}`
                        : '未绑定'}
                    </td>
                    {!compact && (
                      <td className="muted">
                        {channel.verification ? (
                          <div style={{ display: 'grid', gap: 5 }}>
                            <span>
                              <Badge tone={channel.verification.ok ? 'info' : 'warn'}>
                                {channel.verification.ok
                                  ? '上游测试通过'
                                  : `上游测试未通过 · ${channel.verification.status}`}
                              </Badge>
                            </span>
                            <span className="tiny">{fullDate(channel.verification.checkedAt)}</span>
                            <span className="tiny">
                              输入 / 输出 Token：{channel.verification.inputTokens ?? '未知'} /{' '}
                              {channel.verification.outputTokens ?? '未知'}
                            </span>
                          </div>
                        ) : channel.credential?.storage === 'local' ? (
                          '尚未测试'
                        ) : channel.credential?.lastVerifiedAt ? (
                          `凭据验证：${fullDate(channel.credential.lastVerifiedAt)}`
                        ) : (
                          '无验证记录'
                        )}
                      </td>
                    )}
                    <td className="tabular">{channel.weight}</td>
                    <td className="muted">{channel.region}</td>
                    {!compact && (
                      <td>
                        <div className="row-actions" style={{ flexWrap: 'wrap', minWidth: 160 }}>
                          {canCreate &&
                            localKeyInput &&
                            !channel.isPlatform &&
                            channel.credential?.storage === 'local' && (
                              <button
                                disabled={actionBusy || !channel.enabled || !channel.credential.enabled}
                                onClick={() => testConnection(channel)}
                              >
                                {testingId === channel.id ? <Loader2 size={13} className="spin" /> : <Zap size={13} />}
                                {testingId === channel.id ? '测试中…' : '测试连接'}
                              </button>
                            )}
                          {canRotate &&
                            !channel.isPlatform &&
                            channel.credential &&
                            (channel.credential.storage !== 'local' || localKeyInput) && (
                              <button
                                disabled={actionBusy}
                                onClick={() => {
                                  setTarget(channel)
                                  setDialog('rotate')
                                }}
                              >
                                <RotateCcw size={13} />{' '}
                                {localKeyInput && channel.credential.storage === 'local' ? '替换 API Key' : '轮换密钥'}
                              </button>
                            )}
                          {canDisable && !channel.isPlatform && (
                            <>
                              <button disabled={actionBusy} onClick={() => toggle(channel)}>
                                {channel.enabled ? '停用' : '启用'}
                              </button>
                              <button
                                className="danger-icon"
                                aria-label="删除渠道"
                                disabled={actionBusy}
                                onClick={() => disable(channel)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                          {channel.isPlatform && <span className="muted tiny">平台维护</span>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!compact && (
              <p className="section-note">
                {localKeyInput ? '测试连接会消耗少量上游额度。' : '连接状态以最近一次测试结果为准。'}
              </p>
            )}
          </div>
        )}
      </section>

      {dialog === 'create' && (
        <Modal title="添加上游渠道" onClose={closeDialog} busy={actionBusy}>
          <form onSubmit={createChannel}>
            <fieldset className="form-body" disabled={actionBusy} style={{ border: 0, margin: 0, minWidth: 0 }}>
              {localKeyInput && (
                <label>
                  接入模板
                  <select
                    value={presetId}
                    onChange={(event) => {
                      const id = event.target.value
                      setPresetId(id)
                      const product = getSubscriptionProduct(id)
                      const preset = product?.channelPreset
                      setProviderRef(
                        providers.find((provider) => provider.code === product?.provider)?.id ?? (id ? 'custom' : ''),
                      )
                      setBaseUrl(preset?.baseUrl ?? (id === 'cliproxyapi' ? 'http://127.0.0.1:8317/v1' : ''))
                      setProtocol(preset?.protocol ?? 'openai')
                    }}
                  >
                    <option value="">手动配置</option>
                    <optgroup label="官方 API（使用独立开放平台密钥）">
                      {SUBSCRIPTION_PRODUCTS.filter((product) => product.channelPreset).map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="已部署的兼容代理">
                      <option value="cliproxyapi">CLIProxyAPI · 本地 OpenAI 兼容入口</option>
                      <option value="compatible_proxy">New API / Sub2API / 其他兼容服务</option>
                    </optgroup>
                  </select>
                  <small>
                    {getSubscriptionProduct(presetId)?.channelPreset?.note ??
                      (presetId
                        ? '填写你已部署服务的 API 地址与访问密钥。代理账号与授权由该服务管理；NexusAPI 不导入登录 Cookie 或 OAuth 令牌。'
                        : '模板仅填写地址和协议，模型 ID 请按实际授权填写。')}
                  </small>
                  {getSubscriptionProduct(presetId)?.apiGuideUrl && (
                    <a href={getSubscriptionProduct(presetId)!.apiGuideUrl} target="_blank" rel="noreferrer">
                      查看官方接入文档 ↗
                    </a>
                  )}
                </label>
              )}
              <label>
                渠道名称
                <input name="name" required maxLength={80} placeholder="例如：OpenAI 备用渠道" autoFocus />
              </label>
              <div className="form-row">
                <label>
                  上游供应商
                  <select
                    name="provider"
                    value={providerRef}
                    required
                    onChange={(event) => {
                      setProviderRef(event.target.value)
                      setPresetId('')
                      const provider = providers.find((item) => item.id === event.target.value)
                      setBaseUrl(provider?.baseUrl ?? '')
                      setProtocol(provider?.code === 'anthropic' ? 'anthropic' : 'openai')
                    }}
                  >
                    <option value="" disabled>
                      请选择已登记的供应商
                    </option>
                    {providers
                      .filter((p) => p.code !== 'custom')
                      .map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                        </option>
                      ))}
                    {localKeyInput && <option value="custom">自定义（兼容接口）</option>}
                  </select>
                  <small>
                    {localKeyInput
                      ? '未列出的服务可选“自定义”，再填写接口地址、调用协议和模型 ID。'
                      : '选择已登记的供应商。'}
                  </small>
                </label>
                <label>
                  路由权重
                  <input name="weight" type="number" min={1} max={100} defaultValue={10} required />
                  <small>同优先级、同状态渠道的相对选中倾向；20 对 10 约为 2:1，并非流量百分比。</small>
                </label>
              </div>
              {localKeyInput ? (
                <>
                  <label>
                    API 地址（Base URL）
                    <input
                      name="baseUrl"
                      type="url"
                      required
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      autoComplete="off"
                    />
                    <small>填写服务提供的完整基础地址。本地服务支持内网 HTTP 地址。</small>
                  </label>
                  <label>
                    调用协议
                    <select
                      name="protocol"
                      value={protocol}
                      onChange={(event) => setProtocol(event.target.value as 'openai' | 'anthropic')}
                    >
                      <option value="openai">OpenAI 兼容 · Chat Completions</option>
                      <option value="anthropic">Anthropic 兼容 · Messages</option>
                    </select>
                  </label>
                  <label>
                    模型 ID（每行一个）
                    <textarea
                      name="models"
                      required
                      rows={4}
                      placeholder={'服务商提供的模型 ID，例如：\nmodel-large\nmodel-fast'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <small>网关模型列表会列出这些 ID。测试连接仅验证第一个模型。</small>
                  </label>
                  <label>
                    API Key
                    <input
                      name="secret"
                      type="password"
                      required
                      autoComplete="new-password"
                      spellCheck={false}
                      placeholder="粘贴此渠道的 API Key"
                    />
                    <small>加密保存，保存后不再显示。</small>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    已注册的凭据 ID
                    <input
                      name="credentialId"
                      type="text"
                      required
                      autoComplete="off"
                      pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}"
                      placeholder="独立注册流程返回的凭据 ID"
                    />
                    <small>填写注册流程返回的 ID，无需输入密钥。</small>
                  </label>
                  <label>
                    凭据版本
                    <input name="credentialVersion" type="number" min={1} step={1} defaultValue={1} required />
                    <small>填写独立注册流程返回的版本号。</small>
                  </label>
                </>
              )}
              <label>能力</label>
              <div className="model-checkboxes">
                {capabilities.map((cap) => (
                  <label key={cap}>
                    <input type="checkbox" name="capabilities" value={cap} defaultChecked={cap === 'chat'} />
                    {cap}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="modal-footer">
              <button type="button" className="button" disabled={actionBusy} onClick={closeDialog}>
                取消
              </button>
              <button className="button primary" disabled={actionBusy}>
                {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 保存渠道
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog === 'rotate' && target && (
        <Modal
          title={`${localKeyInput && target.credential?.storage === 'local' ? '替换 API Key' : '轮换上游密钥'} · ${target.name}`}
          onClose={closeDialog}
          busy={actionBusy}
        >
          {localKeyInput && target.credential?.storage === 'local' ? (
            <form onSubmit={replaceKey}>
              <div className="form-body">
                <p className="muted">输入新密钥并保存，之后可重新测试连接。</p>
                <label>
                  新 API Key
                  <input
                    name="secret"
                    type="password"
                    required
                    autoComplete="new-password"
                    autoFocus
                    spellCheck={false}
                    placeholder="粘贴新的 API Key"
                    disabled={actionBusy}
                  />
                </label>
              </div>
              <div className="modal-footer">
                <button type="button" className="button" onClick={closeDialog} disabled={actionBusy}>
                  取消
                </button>
                <button className="button primary" disabled={actionBusy}>
                  {busy && <Loader2 size={15} className="spin" />} 保存新密钥
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="form-body">
                <p>请通过独立凭据工作负载轮换密钥，并由授权操作员发布新的签名注册表。</p>
                <p className="muted">凭据 ID：{target.credential?.id}</p>
              </div>
              <div className="modal-footer">
                <button className="button" onClick={closeDialog}>
                  关闭
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {highRisk.needsReauth && (
        <ReauthDialog
          onClose={highRisk.clear}
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
    </>
  )
}
