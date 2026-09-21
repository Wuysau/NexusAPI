'use client'

import { PageHeader } from '@/components/PageHeader'
import { AuditLog } from '@/components/AuditLog'

export default function AuditPage() {
  return (
    <>
      <PageHeader title="审计日志" description="查看成员操作与变更记录。" />
      <AuditLog />
    </>
  )
}
