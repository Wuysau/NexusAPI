'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const hadData = useRef(false)

  const reload = useCallback(() => {
    if (!hadData.current) setLoading(true)
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
        setData(result)
        setError(null)
        setForbidden(false)
        setLoadedAt(Date.now())
        hadData.current = true
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) {
          await refreshSession()
          return
        }
        setForbidden(err instanceof ApiError && err.status === 403)
        setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [path, tick, localTick, refreshSession])

  return { data, loading, error, forbidden, loadedAt, reload }
}
