'use client'

import { useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { HelpDetails } from '@/components/HelpDetails'
import { useSession } from '@/components/SessionProvider'
import { ReauthDialog } from '@/components/ReauthDialog'
import { Badge } from '@/components/ui'
import { PermissionDenied } from '@/components/States'
import { gatewayEndpoint } from '@/lib/gateway-endpoint'

export default function SettingsPage() {
  const { session, can } = useSession()
  const [reauth, setReauth] = useState(false)
  const endpoint = gatewayEndpoint(process.env.NEXT_PUBLIC_GATEWAY_BASE_URL)

  if (!can('org:read')) return <PermissionDenied capability="org:read" />

  return (
    <>
      <PageHeader title="系统设置" description="工作空间、会话与安全状态。" />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h3>工作空间与会话</h3>
          </div>
          <div className="form-body">
            <div className="kv-grid">
              <div>
                <small>组织</small>
                <strong>{session?.organization.name}</strong>
              </div>
              <div>
                <small>租户 ID</small>
                <strong>{session?.organization.tenantId}</strong>
              </div>
              <div>
                <small>当前角色</small>
                <strong>
                  {(
                    {
                      owner: '所有者',
                      admin: '管理员',
                      member: '成员',
                      viewer: '只读成员',
                      support: '支持人员',
                      billing: '财务',
                    } as Record<string, string>
                  )[session?.role ?? ''] ?? session?.role}
                </strong>
              </div>
              <div>
                <small>环境</small>
                <strong>
                  {session?.environment === 'development'
                    ? '开发环境'
                    : session?.environment === 'production'
                      ? '生产环境'
                      : session?.environment}
                </strong>
              </div>
              <div>
                <small>会话到期</small>
                <strong>{session ? new Date(session.sessionExpiresAt).toLocaleString('zh-CN') : '—'}</strong>
              </div>
              <div>
                <small>高风险操作认证</small>
                <strong>{session?.freshAuth ? '有效（15 分钟内）' : '需要重新验证'}</strong>
              </div>
            </div>
            <button className="button" onClick={() => setReauth(true)}>
              <KeyRound size={15} /> 重新验证身份
            </button>
          </div>
        </section>

        <section className="panel security-panel">
          <div className="panel-heading">
            <h3>部署与安全</h3>
            <ShieldCheck size={19} />
          </div>
          <div className="form-body">
            <Badge tone="info">运行环境：{session?.environment ?? '未知'}</Badge>
            <small>网关地址</small>
            <code>{endpoint ?? '尚未配置有效地址'}</code>
            <Badge tone="warn">运行健康状态未知</Badge>
            <HelpDetails label="部署信息说明">
              <p>环境来自当前会话，网关地址来自构建配置。此页未检测网关、Vault 或签名凭据注册表的健康状态。</p>
              <p>完整部署验证需由运维检查各工作负载；本页不录入或显示上游密钥。</p>
            </HelpDetails>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h3>当前角色的能力</h3>
          </div>
          <div className="form-body">
            {session?.capabilities.length ? (
              <HelpDetails label={`查看 ${session.capabilities.length} 项权限`}>
                <div className="model-checkboxes">
                  {session.capabilities.map((capability) => (
                    <span className="badge info" key={capability}>
                      {capability}
                    </span>
                  ))}
                </div>
              </HelpDetails>
            ) : (
              <p className="muted">当前角色没有任何控制台能力。</p>
            )}
          </div>
        </section>
      </div>
      {reauth && <ReauthDialog onClose={() => setReauth(false)} onSuccess={() => setReauth(false)} />}
    </>
  )
}
