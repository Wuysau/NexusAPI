'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { useRouter } from 'next/navigation'
import {
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FileText,
  KeyRound,
  Layers3,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  RefreshCw,
  Scale,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useSession } from './SessionProvider'
import { useRefresh } from './RefreshProvider'
import { ReauthDialog } from './ReauthDialog'
import { useToast } from './Toast'

const TITLES: Record<string, string> = {
  '/': '数据概览',
  '/channels': '渠道管理',
  '/models': '模型广场',
  '/pricing': '价格审批',
  '/keys': 'API 密钥',
  '/logs': '请求日志',
  '/billing': '用量与计费',
  '/reconciliation': '对账工单',
  '/playground': '在线调试',
  '/members': '成员与角色',
  '/audit': '审计日志',
  '/settings': '系统设置',
  '/docs': '开发文档',
  '/projects': '项目',
  '/connections': '我的连接',
}

interface SearchEntry {
  label: string
  href: string
  icon: LucideIcon
  keywords: string[]
}

const SEARCH_ENTRIES: SearchEntry[] = [
  { label: '数据概览', href: '/', icon: LayoutDashboard, keywords: ['overview', 'dashboard', '概览'] },
  { label: '渠道管理', href: '/channels', icon: Network, keywords: ['channel', 'provider', '渠道'] },
  { label: '我的连接', href: '/connections', icon: Network, keywords: ['connection', 'byok', '连接'] },
  { label: '模型广场', href: '/models', icon: Layers3, keywords: ['model', '模型'] },
  { label: '价格审批', href: '/pricing', icon: Settings2, keywords: ['price', 'pricing', '价格'] },
  { label: 'API 密钥', href: '/keys', icon: KeyRound, keywords: ['key', 'api', '密钥'] },
  { label: '项目', href: '/projects', icon: Layers3, keywords: ['project', '项目'] },
  { label: '请求日志', href: '/logs', icon: FileText, keywords: ['log', 'request', '日志'] },
  { label: '用量与计费', href: '/billing', icon: CreditCard, keywords: ['billing', 'usage', '计费'] },
  { label: '对账工单', href: '/reconciliation', icon: Scale, keywords: ['reconciliation', '对账'] },
  { label: '在线调试', href: '/playground', icon: Terminal, keywords: ['playground', 'debug', '调试'] },
  { label: '成员与角色', href: '/members', icon: Users, keywords: ['member', 'role', '成员'] },
  { label: '审计日志', href: '/audit', icon: ShieldCheck, keywords: ['audit', '审计'] },
  { label: '系统设置', href: '/settings', icon: Settings2, keywords: ['setting', '设置'] },
  { label: '开发文档', href: '/docs', icon: BookOpen, keywords: ['docs', '文档'] },
]

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const { session, logout, refresh } = useSession()
  const { refresh: refreshData } = useRefresh()
  const { notify } = useToast()
  const [profile, setProfile] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [reauth, setReauth] = useState(false)
  const [spinning, setSpinning] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setProfile(false)
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) closeSearch()
    }
    window.addEventListener('mousedown', onClick)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape' && searchOpen) closeSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [searchOpen, router])

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [searchOpen])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return SEARCH_ENTRIES
    return SEARCH_ENTRIES.filter((e) => e.label.toLowerCase().includes(q) || e.keywords.some((k) => k.includes(q)))
  }, [searchQuery])

  // No effect needed — searchIndex resets in the onChange handler.

  function closeSearch() {
    setSearchOpen(false)
    setSearchQuery('')
  }

  function selectEntry(entry: SearchEntry) {
    router.push(entry.href)
    closeSearch()
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSearchIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSearchIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[searchIndex]) {
      e.preventDefault()
      selectEntry(filtered[searchIndex])
    }
  }

  const title = TITLES[pathname] ?? '控制台'

  async function doRefresh() {
    setSpinning(true)
    refreshData()
    await refresh()
    setTimeout(() => setSpinning(false), 700)
  }

  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <button className="mobile-menu icon-button" onClick={onOpenMenu} aria-label="打开菜单">
          <Menu size={20} />
        </button>
        <span>控制台</span>
        <ChevronRight size={13} />
        <strong>{title}</strong>
        <span className="header-divider" />
        <span className="environment">{session?.environment ?? '环境未知'}</span>
      </div>
      <div className="header-actions">
        <button className="global-search" onClick={() => setSearchOpen(true)} title="搜索控制台功能" aria-label="搜索">
          <Search size={15} />
          <span>搜索控制台功能...</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className="icon-button docs-icon"
          title="开发文档"
          aria-label="开发文档"
          onClick={() => router.push('/docs')}
        >
          <BookOpen size={18} />
        </button>
        <div className="dropdown-anchor">
          <button
            className="icon-button notification-button"
            aria-label="查看通知"
            onClick={() => {
              setNotifications((value) => !value)
              setProfile(false)
            }}
          >
            <Bell size={18} />
          </button>
          {notifications && (
            <div className="dropdown notifications">
              <h4>通知中心</h4>
              <div>
                <span className="notice-icon">
                  <Bell size={18} />
                </span>
                <section>
                  <strong>通知数据尚未接入</strong>
                  <p>通知服务暂未接入。</p>
                </section>
              </div>
            </div>
          )}
        </div>
        <span className="header-divider" />
        <button
          className={'icon-button refresh ' + (spinning ? 'spinning' : '')}
          onClick={doRefresh}
          title="刷新数据"
          aria-label="刷新数据"
        >
          <RefreshCw size={16} />
        </button>
        <span className="header-divider" />
        <div className="dropdown-anchor" ref={menuRef}>
          <button className="user-button" onClick={() => setProfile((v) => !v)} aria-label="账户菜单">
            <span className="avatar">{(session?.user.email ?? '?').slice(0, 1).toUpperCase()}</span>
            <ChevronDown size={12} />
          </button>
          {profile && (
            <div className="dropdown profile-dropdown">
              <strong>{session?.user.name || session?.user.email}</strong>
              <small>
                {session?.organization.name} · {session?.role}
                {session?.freshAuth ? '' : '（需重新验证）'}
              </small>
              <button
                onClick={() => {
                  setProfile(false)
                  setReauth(true)
                }}
              >
                <KeyRound size={15} />
                重新验证身份
              </button>
              <button
                onClick={() => {
                  setProfile(false)
                  router.push('/settings')
                }}
              >
                <ShieldCheck size={15} />
                工作空间设置
              </button>
              <button
                onClick={async () => {
                  setProfile(false)
                  await logout()
                  notify('已退出登录')
                }}
              >
                <LogOut size={15} />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
      {searchOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="modal-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeSearch()
            }}
          >
            <div className="modal search-modal" ref={searchRef} data-search-panel>
              <div className="modal-heading">
                <h2>快速查找</h2>
                <button className="icon-button" aria-label="关闭搜索" onClick={() => closeSearch()}>
                  <X size={19} />
                </button>
              </div>
              <div className="form-body search-form-body">
                <div className="search-input">
                  <Search size={18} />
                  <input
                    ref={searchInputRef}
                    data-search-input
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value)
                      setSearchIndex(0)
                    }}
                    onKeyDown={onSearchKey}
                    placeholder="搜索控制台功能..."
                    autoFocus
                  />
                </div>
                <small>功能导航</small>
                <div className="search-results">
                  {filtered.map((entry, i) => (
                    <button
                      key={entry.href}
                      className={'search-result ' + (i === searchIndex ? 'selected' : '')}
                      onMouseEnter={() => setSearchIndex(i)}
                      onClick={() => selectEntry(entry)}
                    >
                      <entry.icon size={17} strokeWidth={1.7} />
                      <span>{entry.label}</span>
                      <ChevronRight size={14} className="right-icon" />
                    </button>
                  ))}
                </div>
                {filtered.length === 0 && (
                  <div className="search-empty">
                    <Search size={32} />
                    <p>没有匹配的结果</p>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      {reauth && <ReauthDialog onClose={() => setReauth(false)} onSuccess={() => setReauth(false)} />}
    </header>
  )
}
