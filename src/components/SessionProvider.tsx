'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, apiGet, apiSend, errorMessage } from './lib/api'

export type Role = 'owner' | 'admin' | 'billing' | 'developer' | 'viewer' | 'system-auditor'

export interface Session {
  authenticated: true
  user: { id: string; email: string; name: string | null }
  organization: { id: string; tenantId: string; name: string; slug: string }
  role: Role
  capabilities: string[]
  freshAuth: boolean
  sessionExpiresAt: string
  environment: 'development' | 'test' | 'production'
}

interface Anonymous {
  authenticated: false
  environment?: 'development' | 'test' | 'production'
}

type State =
  | { status: 'loading' }
  | { status: 'anonymous'; error?: string; environment?: 'development' | 'test' | 'production' }
  | { status: 'authenticated'; session: Session }

interface SessionContextValue {
  state: State
  session: Session | null
  /** True when the role holds the capability. UI convenience only — the server enforces. */
  can: (capability: string) => boolean
  refresh: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-enter the password to reset the fresh-auth window for high-risk operations. */
  reauth: (password: string) => Promise<void>
  error: (message: string) => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

interface AuthIntent {
  lifetime: object
  version: number
}

interface SessionWork {
  lifetime: object | null
  version: number
  pending: boolean
  read: AbortController | null
}

function cancelRead(work: SessionWork) {
  const read = work.read
  work.read = null
  read?.abort()
}

function supersededAuth() {
  return new DOMException('登录状态已改变，请重新操作。', 'AbortError')
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const work = useRef<SessionWork>({ lifetime: null, version: 0, pending: false, read: null })

  const refresh = useCallback(async () => {
    const scope = work.current
    // A read must not race an auth POST against its previous cookie/session.
    if (!scope.lifetime || scope.pending) return
    const { lifetime, version } = scope
    cancelRead(scope)
    const controller = new AbortController()
    scope.read = controller
    const current = () =>
      scope.lifetime === lifetime &&
      scope.version === version &&
      scope.read === controller &&
      !controller.signal.aborted
    try {
      const payload = await apiGet<Session | Anonymous>('/api/auth/session', controller.signal)
      if (!current()) return
      setState(
        payload.authenticated
          ? { status: 'authenticated', session: payload }
          : { status: 'anonymous', environment: payload.environment },
      )
    } catch (err) {
      if (!current()) return
      // A control-plane read failure must not pretend the user is signed in.
      setState({ status: 'anonymous', error: errorMessage(err) })
    } finally {
      if (scope.read === controller) scope.read = null
    }
  }, [])

  useEffect(() => {
    const lifetime = {}
    const scope = work.current
    scope.lifetime = lifetime
    // StrictMode may clean up this setup before its initial read starts.
    queueMicrotask(() => {
      if (scope.lifetime === lifetime) void refresh()
    })
    return () => {
      if (scope.lifetime !== lifetime) return
      scope.lifetime = null
      scope.version++
      scope.pending = false
      cancelRead(scope)
    }
  }, [refresh])

  const beginIntent = useCallback((pending: boolean): AuthIntent | null => {
    const scope = work.current
    if (!scope.lifetime) return null
    scope.version++
    scope.pending = pending
    cancelRead(scope)
    return { lifetime: scope.lifetime, version: scope.version }
  }, [])

  const isCurrent = useCallback((intent: AuthIntent | null) => {
    const scope = work.current
    return intent !== null && scope.lifetime === intent.lifetime && scope.version === intent.version
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const intent = beginIntent(true)
      if (!isCurrent(intent)) throw supersededAuth()
      try {
        await apiSend('/api/auth/login', 'POST', { email, password })
      } catch (err) {
        if (!isCurrent(intent)) throw supersededAuth()
        throw new ApiError(err instanceof ApiError ? err.status : 0, 'login_failed', errorMessage(err))
      } finally {
        if (isCurrent(intent)) work.current.pending = false
      }
      if (!isCurrent(intent)) throw supersededAuth()
      await refresh()
      if (!isCurrent(intent)) throw supersededAuth()
    },
    [beginIntent, isCurrent, refresh],
  )

  const logout = useCallback(async () => {
    const intent = beginIntent(true)
    if (!intent) return
    await apiSend('/api/auth/logout', 'POST').catch(() => {})
    if (!isCurrent(intent)) return
    work.current.pending = false
    setState({ status: 'anonymous' })
  }, [beginIntent, isCurrent])

  const reauth = useCallback(
    async (password: string) => {
      const intent = beginIntent(true)
      if (!isCurrent(intent)) throw supersededAuth()
      try {
        await apiSend('/api/auth/reauth', 'POST', { password })
      } catch (err) {
        if (!isCurrent(intent)) throw supersededAuth()
        throw err
      } finally {
        if (isCurrent(intent)) work.current.pending = false
      }
      if (!isCurrent(intent)) throw supersededAuth()
      await refresh()
      if (!isCurrent(intent)) throw supersededAuth()
    },
    [beginIntent, isCurrent, refresh],
  )

  const error = useCallback(
    (message: string) => {
      if (!beginIntent(false)) return
      setState({ status: 'anonymous', error: message })
    },
    [beginIntent],
  )

  const can = useCallback(
    (capability: string) => state.status === 'authenticated' && state.session.capabilities.includes(capability),
    [state],
  )

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      session: state.status === 'authenticated' ? state.session : null,
      can,
      refresh,
      login,
      logout,
      reauth,
      error,
    }),
    [state, can, refresh, login, logout, reauth, error],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
