import { parseUsageAnalyticsQuery, type AnalyticsGroupBy } from '../../../packages/contracts/usage-analytics'

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function defaultAnalyticsDates(now = new Date()) {
  const from = new Date(now)
  from.setDate(from.getDate() - 6)
  return { from: localDate(from), to: localDate(now) }
}
function midnight(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期')
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (localDate(date) !== value) throw new Error('请选择有效日期')
  return date
}
/** Inclusive UI calendar dates become [local midnight, next local midnight).
 * Calendar arithmetic, not 24h arithmetic, preserves DST days. Today's end is asOf.
 */
export function analyticsDateQuery(
  values: {
    from: string
    to: string
    groupBy: AnalyticsGroupBy
    projectId: string
    organizationId?: string
    usageSource?: string
    connectionId?: string
    provider?: string
    model?: string
  },
  now = new Date(),
): URLSearchParams {
  const start = midnight(values.from)
  const end = midnight(values.to)
  if (start > end) throw new Error('开始日期不能晚于结束日期')
  end.setDate(end.getDate() + 1)
  const params = new URLSearchParams({
    scope: 'organization',
    groupBy: values.groupBy,
    from: start.toISOString(),
    to: new Date(Math.min(end.getTime(), now.getTime())).toISOString(),
    asOf: now.toISOString(),
  })
  if (values.projectId) params.set('projectId', values.projectId)
  if (values.organizationId) params.set('organizationId', values.organizationId)
  if (values.usageSource) params.set('usageSource', values.usageSource)
  if (values.connectionId) params.set('connectionId', values.connectionId)
  if (values.provider) params.set('provider', values.provider)
  if (values.model) params.set('model', values.model)
  parseUsageAnalyticsQuery(params, now)
  return params
}
