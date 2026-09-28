import { ProjectAnalyticsView } from '@/components/ProjectAnalyticsView'

export default async function ProjectAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ usageSource?: string; from?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const source = query.usageSource
  const initialUsageSource = source && ['all', 'gateway', 'codex_local'].includes(source) ? source : 'all'
  const initialFrom = query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : ''
  return (
    <ProjectAnalyticsView
      key={`${id}:${initialUsageSource}:${initialFrom}`}
      initialProjectId={id}
      initialUsageSource={initialUsageSource}
      initialFrom={initialFrom}
    />
  )
}
