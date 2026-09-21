'use client'

import { useState, type FormEvent } from 'react'
import { Loader2, LogIn, ShieldCheck } from 'lucide-react'
import { useSession } from './SessionProvider'
import { errorMessage } from './lib/api'

export function LoginScreen() {
  const { login, state } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const environment = state.status === 'anonymous' ? state.environment : undefined
  const initialError = state.status === 'anonymous' ? state.error : undefined

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await login(String(data.get('email') ?? ''), String(data.get('password') ?? ''))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-symbol">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            Nexus<span className="brand-api">API</span>
          </span>
        </div>
        <h1>登录控制台</h1>
        <p>使用组织成员账号登录。所有管理接口均按角色在服务端鉴权。</p>
        <form onSubmit={submit}>
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required autoFocus placeholder="you@company.com" />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {(error || initialError) && <div className="error-banner">{error || initialError}</div>}
          <button className="button primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} 登录
          </button>
        </form>
        {environment && environment !== 'production' && (
          <div className="auth-hint">
            <strong>开发环境</strong>
            <br />
            运行 <code>npm run seed:dev</code> 创建演示账号：
            <br />
            <code>dev@nexus.local / nexus-dev-password</code>（owner）
            <br />
            <code>viewer@nexus.local / nexus-dev-password</code>（viewer）
          </div>
        )}
        <div className="security-note" style={{ marginTop: 16 }}>
          <ShieldCheck size={17} />
          <p>会话令牌仅存于 httpOnly Cookie，服务端只保存其哈希。</p>
        </div>
      </div>
    </div>
  )
}
