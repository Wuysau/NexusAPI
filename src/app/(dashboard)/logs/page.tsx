'use client'

import { PageHeader } from '@/components/PageHeader'
import { LogTable } from '@/components/LogTable'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { isRequestTraceId } from '../../../../packages/contracts/request-trace'

function Logs() {
  const query = useSearchParams()
  const requestId = query.get('requestId')
  return <LogTable requestId={isRequestTraceId(requestId) ? requestId : null} />
}

export default function LogsPage() {
  return (
    <>
      <PageHeader title="请求日志" description="查看调用结果与用量。" />
      <Suspense fallback={<p>读取请求日志…</p>}>
        <Logs />
      </Suspense>
    </>
  )
}
