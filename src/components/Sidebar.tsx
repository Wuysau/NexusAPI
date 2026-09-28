'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BookOpen, ChevronRight, CircleHelp, ExternalLink, Layers3, Sparkles, X } from 'lucide-react'
import { useSession } from './SessionProvider'
import { NAV } from './navigation'

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
