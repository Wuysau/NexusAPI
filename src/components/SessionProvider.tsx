'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const payload = await apiGet<Session | Anonymous>('/api/auth/session')
      setState(
        payload.authenticated
          ? { status: 'authenticated', session: payload }
          : { status: 'anonymous', environment: payload.environment },
      )
    } catch (err) {
      // A control-plane read failure must not pretend the user is signed in.
      setState({ status: 'anonymous', error: errorMessage(err) })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await apiGet<Session | Anonymous>('/api/auth/session')
        if (cancelled) return
        setState(
          payload.authenticated
            ? { status: 'authenticated', session: payload }
            : { status: 'anonymous', environment: payload.environment },
        )
      } catch (err) {
        if (!cancelled) setState({ status: 'anonymous', error: errorMessage(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        await apiSend('/api/auth/login', 'POST', { email, password })
      } catch (err) {
        throw new ApiError(err instanceof ApiError ? err.status : 0, 'login_failed', errorMessage(err))
      }
      await refresh()
    },
    [refresh],
  )

  const logout = useCallback(async () => {
    await apiSend('/api/auth/logout', 'POST').catch(() => {})
    setState({ status: 'anonymous' })
  }, [])

  const reauth = useCallback(
    async (password: string) => {
      await apiSend('/api/auth/reauth', 'POST', { password })
      await refresh()
    },
    [refresh],
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
      error: (message: string) => setState({ status: 'anonymous', error: message }),
    }),
    [state, can, refresh, login, logout, reauth],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
