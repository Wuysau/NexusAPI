'use client'

import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * Reuses the legacy modal chrome (.modal-overlay / .modal / .modal-heading)
 * so the visual language stays identical.
 */
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  busy?: boolean
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div className="modal" style={wide ? { maxWidth: 720 } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose} disabled={busy}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
