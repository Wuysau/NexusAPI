'use client'

import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { SessionProvider, useSession } from '@/components/SessionProvider'
import { ToastProvider } from '@/components/Toast'
import { RefreshProvider } from '@/components/RefreshProvider'
import { Sidebar } from '@/components/Sidebar'
import { Topbar } from '@/components/Topbar'
import { LoginScreen } from '@/components/LoginScreen'

function Shell({ children }: { children: ReactNode }) {
  const { state } = useSession()
  const [mobileOpen, setMobileOpen] = useState(false)

  if (state.status === 'loading') {
    return (
      <div className="auth-screen">
        <div className="state-block" aria-busy="true">
          <Loader2 size={26} className="spin" />
          <strong>正在加载控制台…</strong>
        </div>
      </div>
    )
  }

  if (state.status === 'anonymous') return <LoginScreen />

  return (
    <div className="app-shell">
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
      <Sidebar open={mobileOpen} onNavigate={() => setMobileOpen(false)} />
      <div className="main-shell">
        <Topbar onOpenMenu={() => setMobileOpen(true)} />
        <main>{children}</main>
        <footer className="main-footer">
          <span>
            © {new Date().getFullYear()} Nexus API <i />让 AI 连接更简单
          </span>
          <span>
            <span className="tiny-dot" />
            {state.session.environment === 'production' ? 'Production' : '开发环境'}
          </span>
        </footer>
      </div>
    </div>
  )
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <RefreshProvider>
          <Shell>{children}</Shell>
        </RefreshProvider>
      </ToastProvider>
    </SessionProvider>
  )
}
