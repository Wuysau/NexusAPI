'use client'

import { PageHeader } from '@/components/PageHeader'
import { Reconciliation } from '@/components/Reconciliation'

export default function ReconciliationPage() {
  return (
    <>
      <PageHeader title="对账工单" description="核对待确认的请求与费用。" />
      <Reconciliation />
    </>
  )
}
