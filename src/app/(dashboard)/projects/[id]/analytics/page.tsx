import { ProjectAnalyticsView } from '@/components/ProjectAnalyticsView'

export default async function ProjectAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ usageSource?: string }>
}) {
  const { id } = await params
  const source = (await searchParams).usageSource
  const initialUsageSource = source && ['all', 'gateway', 'codex_local'].includes(source) ? source : 'all'
  return (
    <ProjectAnalyticsView
      key={`${id}:${initialUsageSource}`}
      initialProjectId={id}
      initialUsageSource={initialUsageSource}
    />
  )
}
