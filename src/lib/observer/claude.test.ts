import { expect, it } from 'vitest'
import { ClaudeParser } from './claude'

const event = (extra = {}) => ({
  type: 'assistant',
  sessionId: 'session-a',
  uuid: 'block-a',
  timestamp: '2026-09-29T02:29:20Z',
  cwd: 'D:\\Projects\\NexusAPI',
  version: '2.1.0',
  isSidechain: false,
  message: {
    id: 'message-a',
    role: 'assistant',
    model: 'glm-5.2',
    content: [{ text: 'PRIVATE_BODY' }],
    usage: { input_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 5 },
  },
  ...extra,
})
it('captures tool identity without inventing a provider or subscription; strips content', () => {
  const p = new ClaudeParser(),
    e = p.parse(event())!
  expect(e.source).toBe('claude_code_local')
  expect(e.providerIdentifier).toBeNull()
  expect(e.tokens).toEqual({ input: '60', cached: '30', output: '5', reasoning: null, total: '65' })
  expect(e.sessionKind).toBe('cli')
  expect(JSON.stringify([e, p.state])).not.toContain('PRIVATE_BODY')
})
it('uses stable message identity across blocks and rejects absent or malformed usage', () => {
  const p = new ClaudeParser()
  expect(p.parse(event())!.eventId).toBe(p.parse(event({ uuid: 'another-block' }))!.eventId)
  expect(p.parse(event({ type: 'user' }))).toBeNull()
  expect(p.parse(event({ timestamp: 'bad' }))).toBeNull()
  expect(p.parse(event({ message: { id: 'x', usage: { input_tokens: -1, output_tokens: 1 } } }))).toBeNull()
  expect(p.parse(event({ message: { id: 'x', usage: { input_tokens: 1 } } }))).toBeNull()
  expect(
    p.parse(
      event({ message: { id: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: '20' } } }),
    ),
  ).toBeNull()
})
it('keeps subagent sessions distinct using recorded agent identity', () => {
  const e = new ClaudeParser().parse(event({ isSidechain: true, agentId: 'a123' }))!
  expect(e.sessionId).toBe('session-a:agent:a123')
  expect(e.parentSessionId).toBe('session-a')
  expect(e.sessionKind).toBe('subagent')
})
