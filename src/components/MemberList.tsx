'use client'

import { useState, type FormEvent } from 'react'
import { CreditCard, ShieldCheck, Users, Plus, Eye, Pencil, UserMinus } from 'lucide-react'
import { apiSend, errorMessage } from './lib/api'
import { useApiData } from './lib/useApiData'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { fullDate, num } from './ui'
import { EmptyState, PermissionDenied, SkeletonRows } from './States'
import { WorkspaceDialog, WorkspaceNotice, WorkspaceToolbar } from './workspace/Workspace'
import styles from './workspace/workspace.module.css'

const ROLES = ['owner', 'admin', 'billing', 'developer', 'viewer'] as const
const ROLE_LABEL: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  billing: '财务',
  developer: '开发者',
  viewer: '只读',
}

interface OrgsResponse {
  organization: { id: string; tenantId: string; name: string; slug: string }
  members: {
    id: string
    userId: string
    email: string
    name: string | null
    role: string
    createdAt: string
    isSelf: boolean
  }[]
  subscription: {
    id: string
    planCode: string
    planVersion: number
    status: string
    effectiveFrom: string
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
  } | null
  entitlements: {
    key: string
    kind: string
    limit: string | null
    boolean: boolean | null
    description: string | null
  }[]
}

const ROLE_DESCRIPTION: Record<string, string> = {
  owner: '管理组织、成员、项目、连接和财务，可管理其他所有者。',
  admin: '管理成员、项目、连接和财务，不能管理所有者。',
  billing: '查看组织用量与账单，管理财务及审批价格。',
  developer: '管理获授权项目、连接和 API Key，查看项目用量。',
  viewer: '只读查看获授权项目、连接和用量。',
}
type Member = OrgsResponse['members'][number]

export function MemberList() {
  const { can, session } = useSession()
  const { notify } = useToast()
  const state = useApiData<OrgsResponse>('/api/orgs')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [target, setTarget] = useState<Member | null>(null)
  const [action, setAction] = useState<'add' | 'edit' | 'remove' | 'detail' | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const data = state.data
  const members = (data?.members ?? []).filter(
    (m) =>
      (roleFilter === 'all' || m.role === roleFilter) &&
      [m.email, m.name ?? ''].join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  const canEdit = (m: Member) => !m.isSelf && (m.role !== 'owner' || session?.role === 'owner')
  function open(next: typeof action, member: Member | null = null) {
    setAction(next)
    setTarget(member)
    setEmail(member?.email ?? '')
    setRole(member?.role ?? 'viewer')
    setError('')
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !action || action === 'detail') return
    setBusy(true)
    setError('')
    try {
      await apiSend(
        action === 'add' ? '/api/orgs/members' : `/api/orgs/members/${encodeURIComponent(target!.id)}`,
        action === 'add' ? 'POST' : action === 'remove' ? 'DELETE' : 'PATCH',
        action === 'add' ? { email: email.trim(), role } : action === 'edit' ? { role } : undefined,
      )
      notify(action === 'add' ? '成员已添加' : action === 'remove' ? '成员已移除' : '角色已更新')
      setAction(null)
      state.reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  if (state.forbidden) return <PermissionDenied capability="org:read" />
  return (
    <div className={styles.shell}>
      <div className={styles.overview}>
        <div>
          <span>组织</span>
          <strong>{data?.organization.name ?? '—'}</strong>
          <small>{data?.members.length ?? 0} 位成员</small>
        </div>
        <div>
          <span>当前角色</span>
          <strong>{session ? ROLE_LABEL[session.role] : '—'}</strong>
          <small>操作权限由组织角色决定</small>
        </div>
        <div>
          <span>Nexus 组织计划</span>
          <strong>{data?.subscription?.planCode ?? '未订阅'}</strong>
          <small>与 Codex 等上游订阅分别管理</small>
        </div>
      </div>
      <WorkspaceToolbar
        search={search}
        setSearch={setSearch}
        label="搜索成员名称或邮箱"
        loading={state.loading}
        reload={async () => state.reload()}
      >
        <select
          className={styles.filterSelect}
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="筛选角色"
        >
          <option value="all">全部角色</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {can('member:invite') && (
          <button className={styles.primary} onClick={() => open('add')}>
            <Plus size={15} />
            添加成员
          </button>
        )}
      </WorkspaceToolbar>
      {state.error && <WorkspaceNotice error>{state.error}</WorkspaceNotice>}
      <section className={styles.card}>
        <div className={styles.cardTop}>
          <div className={styles.identity}>
            <span className={styles.icon}>
              <Users size={20} />
            </span>
            <div>
              <h2>组织成员</h2>
              <p>{members.length} 位成员 · 查看详情或管理访问权限</p>
            </div>
          </div>
        </div>
        <div className={styles.cardBody}>
          {state.loading ? (
            <SkeletonRows rows={3} />
          ) : !members.length ? (
            <EmptyState
              icon={<Users size={28} />}
              title="没有匹配的成员"
              description="调整查询条件，或添加已注册的账号。"
            />
          ) : (
            members.map((m) => (
              <div className={styles.managementRow} key={m.id}>
                <div className={styles.identity}>
                  <span className={styles.icon}>{(m.name || m.email).slice(0, 1).toUpperCase()}</span>
                  <div>
                    <h2>
                      {m.name || m.email}
                      {m.isSelf ? ' · 我' : ''}
                    </h2>
                    <p>{m.email}</p>
                  </div>
                </div>
                <div className={styles.footerActions}>
                  <span className={styles.mutedBadge}>{ROLE_LABEL[m.role]}</span>
                  <button className={styles.link} onClick={() => open('detail', m)}>
                    <Eye size={13} />
                    详情
                  </button>
                  {can('member:update-role') && canEdit(m) && (
                    <button className={styles.link} onClick={() => open('edit', m)}>
                      <Pencil size={13} />
                      修改角色
                    </button>
                  )}
                  {can('member:remove') && canEdit(m) && (
                    <button className={styles.dangerLink} onClick={() => open('remove', m)}>
                      <UserMinus size={13} />
                      移除
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
      <details className={styles.card}>
        <summary className={styles.disclosure}>
          <ShieldCheck size={17} />
          角色权限说明<span className={styles.hint}>5 个内置角色</span>
        </summary>
        <div className={styles.cardBody}>
          {ROLES.map((r) => (
            <div className={styles.managementRow} key={r}>
              <strong>{ROLE_LABEL[r]}</strong>
              <span className={styles.hint}>{ROLE_DESCRIPTION[r]}</span>
            </div>
          ))}
          <p className={styles.hint}>角色由统一权限规则定义；在成员上分配角色，不支持创建或删除内置角色。</p>
        </div>
      </details>
      <details className={styles.card}>
        <summary className={styles.disclosure}>
          <CreditCard size={17} />
          计划权益
        </summary>
        <div className={styles.cardBody}>
          {!data?.entitlements.length ? (
            <p className={styles.hint}>
              暂无生效的 Nexus 计划权益。当前按组织角色管理成员；订阅计划后将应用其成员席位限制。
            </p>
          ) : (
            data.entitlements.map((e) => (
              <div className={styles.managementRow} key={e.key}>
                <span>{e.description ?? e.key}</span>
                <strong>
                  {e.kind === 'boolean' ? (e.boolean ? '开启' : '关闭') : e.limit === null ? '不限' : num(e.limit)}
                </strong>
              </div>
            ))
          )}
        </div>
      </details>
      {action && (
        <WorkspaceDialog
          title={
            action === 'add'
              ? '添加成员'
              : action === 'edit'
                ? '修改成员角色'
                : action === 'remove'
                  ? '移除成员'
                  : '成员详情'
          }
          busy={busy}
          onClose={() => setAction(null)}
        >
          <form className={styles.form} onSubmit={(e) => void save(e)}>
            {action === 'detail' && target ? (
              <dl className={styles.details}>
                <dt>名称</dt>
                <dd>{target.name || '未设置'}</dd>
                <dt>邮箱</dt>
                <dd>{target.email}</dd>
                <dt>加入时间</dt>
                <dd>{fullDate(target.createdAt)}</dd>
                <dt>角色</dt>
                <dd>{ROLE_LABEL[target.role]}</dd>
                <dt>权限</dt>
                <dd>{ROLE_DESCRIPTION[target.role]}</dd>
              </dl>
            ) : action === 'remove' ? (
              <p className={styles.description}>
                移除「{target?.email}
                」后，该账号将失去此组织及其项目的成员权限。账号本身与历史用量保留，可按邮箱重新添加，但项目授权需重新配置。
              </p>
            ) : (
              <>
                {action === 'add' ? (
                  <label className={styles.field}>
                    注册邮箱
                    <input
                      autoFocus
                      required
                      type="email"
                      maxLength={254}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                    />
                    <span className={styles.hint}>添加已注册的 Nexus 账号后立即授予组织权限，不会发送邮件。</span>
                  </label>
                ) : (
                  <p className={styles.description}>{target?.email}</p>
                )}
                <label className={styles.field}>
                  组织角色
                  <select value={role} onChange={(e) => setRole(e.target.value)}>
                    {ROLES.filter((r) => r !== 'owner' || session?.role === 'owner').map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <span className={styles.hint}>{ROLE_DESCRIPTION[role]}</span>
                </label>
              </>
            )}
            {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setAction(null)} disabled={busy}>
                {action === 'detail' ? '关闭' : '取消'}
              </button>
              {action !== 'detail' && (
                <button className={action === 'remove' ? styles.danger : styles.primary} disabled={busy}>
                  {busy ? '处理中…' : action === 'remove' ? '确认移除' : '保存'}
                </button>
              )}
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </div>
  )
}
