'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiGet, errorMessage } from './api'
import { useRefresh } from '../RefreshProvider'
import { useSession } from '../SessionProvider'

export interface ApiDataState<T> {
  data: T | null
  loading: boolean
  error: string | null
  forbidden: boolean
  /** Epoch ms of the last successful load — used to render a stale badge. */
  loadedAt: number | null
  reload: () => void
}

type LoadState<T> = Omit<ApiDataState<T>, 'reload'> & { path: string | null }

function initialState<T>(path: string | null): LoadState<T> {
  return { path, data: null, loading: Boolean(path), error: null, forbidden: false, loadedAt: null }
}

/**
 * Read a control-plane endpoint with the four states every page must handle:
 * loading, error, permission-denied and (on refresh failure) stale data.
 *
 * A 401 triggers a session refresh so the shell falls back to the login screen
 * rather than leaving a broken console on screen.
 */
export function useApiData<T>(path: string | null): ApiDataState<T> {
  const { tick } = useRefresh()
  const { refresh: refreshSession } = useSession()
  const [state, setState] = useState<LoadState<T>>(() => initialState(path))
  const [localTick, setLocalTick] = useState(0)

  // Reset before children commit so a new query never renders the previous result.
  const current = state.path === path ? state : initialState<T>(path)
  if (state.path !== path) setState(current)

  const reload = useCallback(() => {
    setState((previous) => (previous.path && previous.loadedAt === null ? { ...previous, loading: true } : previous))
    setLocalTick((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const controller = new AbortController()
    ;(async () => {
      try {
        const result = await apiGet<T>(path, controller.signal)
        if (cancelled) return
        const loadedAt = Date.now()
        setState((previous) =>
          previous.path === path ? { ...previous, data: result, error: null, forbidden: false, loadedAt } : previous,
        )
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) {
          await refreshSession()
          return
        }
        const forbidden = err instanceof ApiError && err.status === 403
        const error = errorMessage(err)
        setState((previous) => (previous.path === path ? { ...previous, forbidden, error } : previous))
      } finally {
        if (!cancelled) {
          setState((previous) => (previous.path === path ? { ...previous, loading: false } : previous))
        }
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [path, tick, localTick, refreshSession])

  return {
    data: current.data,
    loading: current.loading,
    error: current.error,
    forbidden: current.forbidden,
    loadedAt: current.loadedAt,
    reload,
  }
}
