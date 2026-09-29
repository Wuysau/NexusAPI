import { expect, it } from 'vitest'
import { AGENT_TOOLS, agentCategory, filterAgentTools } from './agent-tools'

it('lets users find omitted Chinese tools and distinguish them from implemented native capture', () => {
  const found = filterAgentTools(AGENT_TOOLS, '灵码', 'ide', 'all')
  expect(found.map((t) => t.id)).toEqual(['tongyi_lingma'])
  expect(filterAgentTools(AGENT_TOOLS, '灵码', 'ide', 'native')).toEqual([])
  expect(filterAgentTools(AGENT_TOOLS, 'QODER', 'all', 'native').map((t) => t.id)).toEqual(['qoder'])
})

it('keeps cloud products out of local capture claims and preserves custom IDs in search', () => {
  expect(agentCategory('replit_agent')).toBe('cloud')
  expect(filterAgentTools(AGENT_TOOLS, '', 'cloud', 'native')).toEqual([])
  const custom = { id: 'future_agent', name: 'Future Agent', hint: '', capture: 'bridge' }
  expect(filterAgentTools([custom], 'future_agent', 'other', 'bridge')).toEqual([custom])
})
