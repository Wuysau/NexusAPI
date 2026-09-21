'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  CreditCard,
  ExternalLink,
  FileText,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Network,
  Scale,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { useSession } from './SessionProvider'

interface NavEntry {
  href: string
  label: string
  icon: typeof LayoutDashboard
  group?: string
  capability?: string
}

const NAV: NavEntry[] = [
  { href: '/', label: '数据概览', icon: LayoutDashboard, capability: 'usage:read' },
  { href: '/channels', label: '渠道管理', icon: Network, group: '网关管理', capability: 'credential:read' },
  { href: '/connections', label: '我的连接', icon: Network, group: '网关管理', capability: 'credential:read' },
  { href: '/models', label: '模型广场', icon: Layers3, capability: 'pricing:read' },
  { href: '/pricing', label: '价格审批', icon: ClipboardCheck, capability: 'pricing:read' },
  { href: '/keys', label: 'API 密钥', icon: KeyRound, group: '工作空间', capability: 'apikey:read' },
  { href: '/projects', label: '项目', icon: Layers3, group: '工作空间', capability: 'project:read' },
  { href: '/logs', label: '请求日志', icon: FileText, capability: 'request:read' },
  { href: '/billing', label: '用量与计费', icon: CreditCard, capability: 'billing:read' },
  { href: '/reconciliation', label: '对账工单', icon: Scale, capability: 'billing:read' },
  { href: '/playground', label: '在线调试', icon: Terminal, capability: 'request:read' },
  { href: '/members', label: '成员与角色', icon: Users, group: '治理', capability: 'member:read' },
  { href: '/audit', label: '审计日志', icon: ShieldCheck, capability: 'audit:read' },
  { href: '/settings', label: '系统设置', icon: Settings2, capability: 'org:read' },
]

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname()
  const { session, can } = useSession()
  const visible = NAV.filter((entry) => !entry.capability || can(entry.capability))
  const [helpCollapsed, setHelpCollapsed] = useState(() => {
    try {
      return localStorage.getItem('nexus-help-collapsed') !== '0'
    } catch {
      return true
    }
  })

  function toggleHelp() {
    const next = !helpCollapsed
    setHelpCollapsed(next)
    try {
      localStorage.setItem('nexus-help-collapsed', next ? '1' : '0')
    } catch {
      // ignore
    }
  }

  return (
    <aside className={'sidebar ' + (open ? 'open' : '')}>
      <Link className="brand" href="/" onClick={onNavigate}>
        <span className="brand-symbol">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>
          Nexus<span className="brand-api">API</span>
        </span>
      </Link>
      <div className="workspace-switch">
        <span className="workspace-icon">
          <Layers3 size={17} />
        </span>
        <span>
          {session?.organization.name ?? '工作空间'}
          <small>{session ? `${session.role} · ${session.organization.tenantId}` : '—'}</small>
        </span>
        <ChevronRight size={14} />
      </div>
      <nav>
        {visible.map((entry, index) => {
          const active = entry.href === '/' ? pathname === '/' : pathname.startsWith(entry.href)
          return (
            <div key={entry.href}>
              {entry.group && entry.group !== visible[index - 1]?.group && (
                <div className="nav-group">{entry.group}</div>
              )}
              <Link className={'nav-item ' + (active ? 'active' : '')} href={entry.href} onClick={onNavigate}>
                <entry.icon size={18} strokeWidth={1.7} />
                <span>{entry.label}</span>
              </Link>
            </div>
          )
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className={'help-card ' + (helpCollapsed ? 'collapsed' : '')}>
          {helpCollapsed ? (
            <button className="help-collapsed-bar" onClick={toggleHelp} title="展开帮助卡片">
              <span className="help-spark small">
                <Sparkles size={15} />
              </span>
              <span>构建 AI 应用</span>
              <ChevronRight size={13} className="right-icon" />
            </button>
          ) : (
            <>
              <div className="help-card-top">
                <span className="help-spark">
                  <Sparkles size={18} />
                </span>
                <h4>构建你的 AI 应用</h4>
                <button className="help-close-btn" onClick={toggleHelp} aria-label="收起帮助卡片" title="收起">
                  <X size={14} />
                </button>
              </div>
              <p>了解凭据、渠道配置与模型接入步骤。</p>
              <Link href="/docs" onClick={onNavigate}>
                阅读接入文档 <ExternalLink size={13} />
              </Link>
            </>
          )}
        </div>
        <Link
          className={'nav-item ' + (pathname.startsWith('/docs') ? 'active' : '')}
          href="/docs"
          onClick={onNavigate}
        >
          <BookOpen size={17} />
          开发文档
          <ExternalLink size={13} className="right-icon" />
        </Link>
        <Link className="nav-item" href="/docs" onClick={onNavigate}>
          <CircleHelp size={17} />
          帮助与支持
        </Link>
        <div className="sidebar-version">{session?.environment ?? '环境未知'}</div>
      </div>
    </aside>
  )
}
