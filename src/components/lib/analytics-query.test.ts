import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { analyticsDateQuery, defaultAnalyticsDates } from './analytics-query'

it.each([
  ['UTC', '2026-09-18', '2026-09-18', '2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z'],
  ['Asia/Shanghai', '2026-09-18', '2026-09-18', '2026-09-17T16:00:00.000Z', '2026-09-18T16:00:00.000Z'],
  ['Asia/Shanghai', '2026-09-12', '2026-09-18', '2026-09-11T16:00:00.000Z', '2026-09-18T16:00:00.000Z'],
  ['UTC', '2026-08-20', '2026-09-18', '2026-08-20T00:00:00.000Z', '2026-09-19T00:00:00.000Z'],
  ['America/Los_Angeles', '2026-03-08', '2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
  ['America/Los_Angeles', '2026-11-01', '2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
])('converts local calendar range in %s (%s–%s)', (tz, from, to, start, end) => {
  // Separate process: TZ is fixed before the runtime initializes local time.
  const source = `import { analyticsDateQuery } from './src/components/lib/analytics-query.ts'; console.log(JSON.stringify(Object.fromEntries(analyticsDateQuery(${JSON.stringify({ from, to, projectId: 'a', groupBy: 'executionMode' })}, new Date('2026-12-01T00:00:00Z')))))`
  const result = JSON.parse(
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    }),
  )
  expect(result).toMatchObject({ from: start, to: end, projectId: 'a', groupBy: 'executionMode' })
})
it('bounds today at asOf and defaults to seven inclusive calendar dates', () => {
  const now = new Date(2026, 8, 18, 0, 15)
  expect(defaultAnalyticsDates(now)).toEqual({ from: '2026-09-12', to: '2026-09-18' })
  const q = analyticsDateQuery({ ...defaultAnalyticsDates(now), projectId: '', groupBy: 'project' }, now)
  expect(q.get('to')).toBe(now.toISOString())
  expect(q.get('asOf')).toBe(now.toISOString())
})
it('keeps the selected gateway connection in a project usage drilldown', () => {
  const q = analyticsDateQuery(
    {
      from: '2026-09-12',
      to: '2026-09-18',
      projectId: 'project-a',
      connectionId: 'connection-a',
      usageSource: 'gateway',
      groupBy: 'model',
    },
    new Date('2026-09-20T00:00:00Z'),
  )
  expect(q.get('projectId')).toBe('project-a')
  expect(q.get('connectionId')).toBe('connection-a')
  expect(q.get('usageSource')).toBe('gateway')
})
it.each([
  ['', '2026-09-18'],
  ['2026-02-30', '2026-09-18'],
  ['2026-09-19', '2026-09-18'],
])('rejects invalid dates %s %s', (from, to) => {
  expect(() => analyticsDateQuery({ from, to, projectId: '', groupBy: 'model' })).toThrow()
})
