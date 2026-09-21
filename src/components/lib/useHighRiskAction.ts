'use client'

import { useCallback, useState } from 'react'
import { ApiError } from './api'

/**
 * Runs a high-risk mutation; when the server rejects it with 401
 * `recent authentication required`, the caller renders <ReauthDialog> and
 * retries the same action after the password is re-verified.
 */
export function useHighRiskAction() {
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && error.code === 'forbidden') {
        setPendingAction(() => action)
        return false
      }
      throw error
    } finally {
      setBusy(false)
    }
  }, [])

  const needsReauth = pendingAction !== null
  const clear = useCallback(() => setPendingAction(null), [])
  const retry = useCallback(async () => {
    const action = pendingAction
    setPendingAction(null)
    if (action) await action()
  }, [pendingAction])

  return { run, needsReauth, clear, retry, busy }
}
