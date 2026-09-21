'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface RefreshContextValue {
  /** Monotonic counter; pages include it in their loader effect dependencies. */
  tick: number
  refresh: () => void
}

const RefreshContext = createContext<RefreshContextValue | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const value = useMemo(() => ({ tick, refresh }), [tick, refresh])
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext)
  if (!ctx) throw new Error('useRefresh must be used inside RefreshProvider')
  return ctx
}
