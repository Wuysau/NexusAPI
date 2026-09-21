import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './HelpDetails.module.css'

/** Optional context stays reachable without competing with the task at hand. */
export function HelpDetails({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className={styles.help}>
      <summary>
        <ChevronDown size={14} aria-hidden="true" />
        {label}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  )
}
