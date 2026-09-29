'use client'

import { PageHeader } from '@/components/PageHeader'
import { BillingView } from '@/components/BillingView'
import { ProjectAnalyticsView } from '@/components/ProjectAnalyticsView'
import { AgentObserverPanel } from '@/components/workspace/AgentObserverPanel'

export default function BillingPage() {
  return (
    <>
      <PageHeader title="用量与计费" description="查看用量、费用与账单。" />
      <BillingView />
      <AgentObserverPanel />
      <ProjectAnalyticsView />
    </>
  )
}
