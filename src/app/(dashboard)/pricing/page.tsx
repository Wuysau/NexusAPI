'use client'

import styles from '@/components/workspace/workspace.module.css'
import { PageHeader } from '@/components/PageHeader'
import { PriceApproval } from '@/components/PriceApproval'

export default function PricingPage() {
  return (
    <div className={styles.shell}>
      <PageHeader title="价格审批" description="核对模型价格变更、来源证据与生效安排。" />
      <PriceApproval />
    </div>
  )
}
