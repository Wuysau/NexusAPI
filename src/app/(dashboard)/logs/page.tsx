'use client'

import { PageHeader } from '@/components/PageHeader'
import { LogTable } from '@/components/LogTable'

export default function LogsPage() {
  return (
    <>
      <PageHeader title="请求日志" description="查看调用结果与用量。" />
      <LogTable />
    </>
  )
}
