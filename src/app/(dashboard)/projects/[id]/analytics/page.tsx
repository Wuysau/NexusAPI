import { ProjectAnalyticsView } from '@/components/ProjectAnalyticsView'
import { isUsageSource } from '@/lib/observer/agent-tools'

export default async function ProjectAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ usageSource?: string; from?: string; connectionId?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const source = query.usageSource
  const initialUsageSource = source && isUsageSource(source) ? source : 'all'
  const initialFrom = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : ''
  const initialConnectionId =
    query.connectionId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(query.connectionId) ? query.connectionId : ''
  return (
    <ProjectAnalyticsView
      key={`${id}:${initialUsageSource}:${initialFrom}:${initialConnectionId}`}
      initialProjectId={id}
      initialUsageSource={initialUsageSource}
      initialFrom={initialFrom}
      initialConnectionId={initialConnectionId}
    />
  )
}
