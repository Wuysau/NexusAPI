import { expect, it } from 'vitest'
import { projectAnalyticsHref } from './project-analytics-link'

it('opens project analytics from the earliest observed local calendar day', () => {
  expect(projectAnalyticsHref('project-a', new Date(2026, 8, 14, 0, 30).toISOString())).toBe(
    '/projects/project-a/analytics?from=2026-09-14',
  )
})

it('keeps the normal default range for projects without observations', () => {
  expect(projectAnalyticsHref('project-a', null)).toBe('/projects/project-a/analytics')
})
