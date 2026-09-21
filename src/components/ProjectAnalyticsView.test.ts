import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseUsageAnalyticsQuery } from '../../packages/contracts/usage-analytics'
import { ProjectAnalyticsView } from './ProjectAnalyticsView'

const state = vi.hoisted(() => ({ data: {} as unknown, path: '' }))
vi.mock('./lib/useApiData', () => ({
  useApiData: (path: string) => {
    state.path = path
    return { data: state.data, loading: false, forbidden: false, error: null }
  },
}))
vi.mock('./SessionProvider', () => ({ useSession: () => ({ session: { organization: { id: 'org' } } }) }))
const known = { knownSum: '0', unknownRequests: '0', total: '0' }
const unknown = { knownSum: '0', unknownRequests: '1', total: null }
beforeEach(() => {
  const metrics = {
    requests: '9007199254740993',
    tokens: { input: known, output: known, cached: known, reasoning: unknown, total: unknown },
    money: ['USD', 'CNY'].map((currency) => ({
      currency,
      charge: { ...known, knownSum: '9007199254740993001', total: '9007199254740993001' },
      upstreamCost: unknown,
      margin: unknown,
    })),
  }
  state.data = {
    analytics: {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      asOf: '2026-02-01T00:00:00Z',
      groupBy: 'project',
      totals: metrics,
      groups: [{ key: 'a', label: 'Project A', metrics }],
      totalGroups: '1',
      limit: 100,
      offset: 0,
      nextOffset: null,
    },
  }
})
it('renders the real canonical API envelope without rows/connections and retains exact unknown/currencies', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectAnalyticsView))
  expect(html).toContain('Project A')
  expect(html).toContain('未知')
  expect(html).toContain('9007199254740993')
  expect(html).toContain('9007199254740.993001')
  expect(html).toContain('USD')
  expect(html).toContain('CNY')
})
it('emits a valid default timestamp query and all canonical grouping choices', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectAnalyticsView))
  expect(() => parseUsageAnalyticsQuery(new URL(state.path, 'http://localhost').searchParams)).not.toThrow()
  expect(html).toContain('value="executionMode"')
  expect(html).toContain('value="apiKey"')
  expect(html).toContain('观测事件')
  expect(html).toContain('运行会话')
  expect(html).toContain('value="codex_local"')
  expect(html).toContain('value="day"')
  expect(html).toContain('value="subscription"')
  expect(new URL(state.path, 'http://localhost').searchParams.get('usageSource')).toBe('all')
})
