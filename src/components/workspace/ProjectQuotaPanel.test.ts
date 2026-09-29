import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ProjectQuotaPanel } from './ProjectQuotaPanel'

vi.mock('../lib/useApiData', () => ({
  useApiData: () => ({
    loading: false,
    data: {
      connections: [
        { id: 'api', provider: 'custom', mode: 'byok', quotas: [] },
        {
          id: 'claude',
          provider: 'anthropic',
          mode: 'subscription_interactive',
          subscriptionProduct: 'claude_code',
          quotas: [],
        },
        { id: 'legacy-codex', provider: 'openai', mode: 'subscription_interactive', quotas: [] },
      ],
    },
  }),
}))

it('uses the subscription catalog label and gives API connections actionable empty-quota guidance', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectQuotaPanel, { projectId: 'project' }))
  expect(html).toContain('Claude Code')
  expect(html.match(/<strong>OpenAI Codex<\/strong>/g)).toHaveLength(1)
  expect(html).toContain('该 API 连接未提供账户额度；请求用量请查看上方用量分析或服务商控制台。')
  expect(html).toContain('尚无可用额度观测；请查看服务商账户或连接详情中的接入说明。')
  expect(html.match(/配额未知，请先在连接详情刷新。/g)).toHaveLength(1)
})
