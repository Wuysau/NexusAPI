import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import TasksPage from './page'

const state = vi.hoisted(() => ({ runtime: {} as unknown, canManage: true, error: null as string | null }))
vi.mock('@/components/SessionProvider', () => ({ useSession: () => ({ can: () => state.canManage }) }))
vi.mock('@/components/workspace/Workspace', async (original) => ({
  ...(await original<object>()),
  useCollection: () => ({ items: [{ id: 'project-a', name: '项目 A' }], loading: false, error: '', reload: vi.fn() }),
}))
vi.mock('@/components/lib/useApiData', () => ({
  useApiData: (path: string) => ({
    data: path.includes('connections') ? { connections: [] } : state.runtime,
    loading: false,
    error: state.error,
    reload: vi.fn(),
  }),
}))

beforeEach(() => {
  state.canManage = true
  state.error = null
  const candidate = {
    connectionId: 'resource-unknown',
    profileRef: 'work',
    priority: 1,
    enabled: true,
    switchThreshold: 90,
    capabilities: ['coding'],
    allowedModels: [],
    allowedTools: ['codex'],
    costMode: 'subscription',
  }
  state.runtime = {
    policy: {
      name: '测试策略',
      workload: 'coding-agent-high',
      tool: 'codex',
      model: null,
      requiredCapabilities: ['coding'],
      autoFailover: true,
      autoReturn: false,
      candidates: [candidate],
    },
    resources: [
      {
        ...candidate,
        connectionId: 'resource-unknown',
        profileRef: 'work',
        provider: 'openai',
        product: 'codex',
        executionMode: 'local',
        availability: 'available',
        quotaState: 'unknown',
        usedPercent: null,
        resetAt: null,
        priority: 1,
        capabilities: ['coding'],
        costMode: 'subscription',
      },
    ],
    tasks: [
      {
        id: 'task-a',
        projectId: 'project-a',
        originalGoal: '修复目标',
        cwd: 'D:/work',
        status: 'paused',
        activeResource: null,
        activeTool: 'codex',
        activeSession: null,
        createdAt: null,
        updatedAt: null,
        pauseReason: 'no_available_resource',
        nextResetAt: '2026-10-01T00:00:00Z',
        handoffs: 1,
        history: [
          {
            id: 'handoff-a',
            source_connection_id: 'resource-before',
            target_connection_id: 'resource-unknown',
            reason: 'quota_exhausted',
            created_at: '2026-09-21T00:00:00Z',
          },
        ],
        sessions: [
          {
            id: 'session-a',
            connectionId: 'resource-unknown',
            externalSessionId: 'external-a',
            startedAt: null,
            endedAt: null,
            reason: 'quota_exhausted',
            status: 'ended',
          },
        ],
        usage: [
          { connectionId: 'resource-unknown', totalTokens: null },
          { connectionId: 'resource-known', totalTokens: '9007199254740993' },
        ],
      },
    ],
  }
})

it('preserves unknown quota and usage, exact totals, pause/reset context and session history', () => {
  const html = renderToStaticMarkup(React.createElement(TasksPage))
  expect(html).toContain('修复目标')
  expect(html).toContain('未知')
  expect(html).not.toContain('0%')
  expect(html).toContain('可用资源 / 全部</span><strong>0 / 1</strong>')
  expect(html).toContain('9,007,199,254,740,993')
  expect(html).toContain('下次重置')
  expect(html).toContain('external-a')
  expect(html).toContain('resource-before')
  expect(html).toContain('npm run nexus -- codex --project project-a')
  expect(html).toContain('--persist-context')
})

it('hides writes from readers and disables actions on stale data', () => {
  state.canManage = false
  let html = renderToStaticMarkup(React.createElement(TasksPage))
  expect(html).not.toContain('编辑策略')
  expect(html).not.toContain('恢复任务')
  state.canManage = true
  state.error = '网络不可用'
  html = renderToStaticMarkup(React.createElement(TasksPage))
  expect(html).toContain('网络不可用')
  expect(html).toMatch(/disabled=""[^>]*>恢复任务/)
})

it('waits for fresh observations after reset instead of inferring new capacity', () => {
  const data = state.runtime as {
    resources: { quotaState: string; usedPercent: number | null; resetAt: string | null }[]
  }
  data.resources[0] = {
    ...data.resources[0],
    quotaState: 'available',
    usedPercent: 10,
    resetAt: '2000-01-01T00:00:00Z',
  }
  const html = renderToStaticMarkup(React.createElement(TasksPage))
  expect(html).toContain('等待额度刷新')
  expect(html).toContain('可用资源 / 全部</span><strong>0 / 1</strong>')
})
