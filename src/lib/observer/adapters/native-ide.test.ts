import { describe, expect, it } from 'vitest'
import { parseNativeIde } from './native-ide'

const milliseconds = Date.parse('2026-09-29T10:00:00.000Z')
const context = {
  file: 'C:\\Users\\fixture\\globalStorage\\extension\\tasks\\task-1\\ui_messages.json',
  workspace: 'D:\\work\\project',
}
const request = (usage: unknown, ts = milliseconds) => ({
  type: 'say',
  say: 'api_req_started',
  ts,
  text: JSON.stringify(usage),
})
const noTokens = { input: null, cached: null, output: null, reasoning: null, total: null }

describe('Cline, Roo Code and legacy Kilo Code UI snapshots', () => {
  it.each(['roo_code', 'kilo_code'])('%s reads normalized input without adding caches twice', (tool) => {
    const [item] = parseNativeIde(
      tool,
      [request({ tokensIn: 150, tokensOut: 30, cacheReads: 100, cacheWrites: 20 })],
      context,
    )
    expect(item.tokens).toEqual({ input: '150', output: '30', cached: '100', reasoning: null, total: '180' })
    expect(item.cwd).toBe(context.workspace)
    expect(item.model).toBeNull()
    expect(item.timestamp).toBe('2026-09-29T10:00:00.000Z')
    expect(item.kind).toBe('other')
  })
  it('keeps ambiguous Cline cache-inclusive input and total unknown', () => {
    const [item] = parseNativeIde(
      'cline',
      [request({ tokensIn: 10, tokensOut: 30, cacheReads: 100, cacheWrites: 20 })],
      context,
    )
    expect(item.tokens).toEqual({ input: null, output: '30', cached: '100', reasoning: null, total: null })
  })
  it('preserves reported zero while missing counters remain null', () => {
    const [item] = parseNativeIde('roo_code', [request({ tokensIn: 0, tokensOut: 0 })], context)
    expect(item.tokens).toEqual({ input: '0', output: '0', total: '0', cached: null, reasoning: null })
    expect(parseNativeIde('cline', [request({ tokensOut: 0 })], context)[0].tokens.input).toBeNull()
  })
  it('retains stable identities across mutable snapshots without hashing prompt contents', () => {
    const first = request({ request: 'sensitive prompt', tokensOut: 1 })
    const second = request({ request: 'different sensitive prompt', tokensIn: 20, tokensOut: 3 })
    const [initial] = parseNativeIde('roo_code', [first], context)
    const [final] = parseNativeIde('roo_code', [second], context)
    expect(initial.eventId).toBe(final.eventId)
    const merged = parseNativeIde('roo_code', [first, second, first], context)
    expect(merged).toHaveLength(1)
    expect(merged[0].tokens.total).toBe('23')
    expect(parseNativeIde('roo_code', [second, request({ request: 'not finished' })], context)[0].tokens.total).toBe(
      '23',
    )
    expect(
      parseNativeIde('roo_code', [second], { ...context, file: context.file.replace('task-1', 'task-2') })[0].sessionId,
    ).not.toBe(final.sessionId)
  })
  it('uses only recognized request rows, no aggregate/deleted/subagent summaries or prompt workspace extraction', () => {
    const rows = [
      request({ request: '<cwd>D:/secret</cwd>', tokensIn: 10, tokensOut: 2 }),
      { ...request({ tokensIn: 1000 }), say: 'deleted_api_reqs' },
      { ...request({ tokensIn: 1000 }), say: 'subagent_usage' },
      { ...request({ tokensIn: 1000 }), say: 'api_req_finished' },
      { ...request({ tokensIn: 1000 }), type: 'ask' },
    ]
    const result = parseNativeIde('roo_code', rows, { file: context.file })
    expect(result).toHaveLength(1)
    expect(result[0].cwd).toBeNull()
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('does not turn Kilo usageMissing synthetic zeroes into reported measurements', () => {
    expect(
      parseNativeIde(
        'kilo_code',
        [request({ tokensIn: 0, tokensOut: 0, cacheReads: 0, usageMissing: true })],
        context,
      )[0].tokens,
    ).toEqual(noTokens)
  })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, true, '1e6', '001', '9223372036854775808'])(
    'rejects malformed numeric count %s',
    (value) => {
      const [item] = parseNativeIde(
        'roo_code',
        [request({ tokensIn: value, tokensOut: value, cacheReads: value })],
        context,
      )
      expect(item.tokens).toEqual(noTokens)
    },
  )
  it('supports exact bigint strings but does not overflow derived totals or violate cache subset', () => {
    const [large] = parseNativeIde('roo_code', [request({ tokensIn: '9223372036854775807', tokensOut: '1' })], context)
    expect(large.tokens.input).toBe('9223372036854775807')
    expect(large.tokens.total).toBeNull()
    const [invalid] = parseNativeIde('roo_code', [request({ tokensIn: 1, tokensOut: 3, cacheReads: 4 })], context)
    expect(invalid.tokens).toMatchObject({ input: null, cached: '4', output: '3', total: null })
  })
  it('drops invalid dates and model labels, accepts activity with malformed payload, strips private fields', () => {
    const row = {
      ...request({ tokensIn: 4, tokensOut: 2, request: 'PRIVATE', access_token: 'PRIVATE', cost: 9 }),
      modelInfo: { modelId: 'claude-sonnet-4', providerId: 'PRIVATE' },
      images: ['PRIVATE'],
      reasoning: 'PRIVATE',
    }
    const [item] = parseNativeIde('cline', [row], context)
    expect(item.model).toBe('claude-sonnet-4')
    expect(JSON.stringify(item)).not.toMatch(/PRIVATE|access_token|providerId|images|cost/)
    expect(parseNativeIde('cline', [{ ...row, ts: NaN }], context)).toEqual([])
    expect(parseNativeIde('cline', [{ ...row, text: '{' }], context)[0].tokens).toEqual(noTokens)
  })
})

const start = {
  type: 'session.start',
  id: 'start-event',
  timestamp: '2026-09-29T10:00:00Z',
  data: {
    sessionId: 'copilot-session',
    context: { cwd: '/work/repo', branch: 'PRIVATE' },
    selectedModel: 'not-actual-model',
  },
}
const assistant = (id: string, data: Record<string, unknown> = {}) => ({
  type: 'assistant.message',
  id,
  timestamp: '2026-09-29T10:01:00Z',
  data: { messageId: `msg-${id}`, content: 'PRIVATE RESPONSE', ...data },
})
const copilotContext = { file: '/home/fixture/.copilot/session-state/copilot-session/events.jsonl' }
describe('Copilot CLI persisted events', () => {
  it('reads explicit session identity/cwd and output-only usage while skipping nonpersistent and aggregate metrics', () => {
    const rows = [
      start,
      assistant('a', { outputTokens: 40, model: 'gpt-5' }),
      { type: 'assistant.usage', data: { inputTokens: 100, outputTokens: 40 } },
      {
        type: 'session.shutdown',
        data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 100, outputTokens: 40 } } } },
      },
    ]
    const [item] = parseNativeIde('github_copilot', rows, copilotContext)
    expect(parseNativeIde('github_copilot', rows, copilotContext)).toHaveLength(1)
    expect(item).toMatchObject({
      sessionId: 'copilot-session',
      cwd: '/work/repo',
      model: 'gpt-5',
      kind: 'cli',
      tokens: { ...noTokens, output: '40' },
    })
    expect(JSON.stringify(item)).not.toContain('PRIVATE')
  })
  it('does not invent usage or actual models from session settings', () => {
    const [item] = parseNativeIde('github_copilot', [start, assistant('a')], copilotContext)
    expect(item.model).toBeNull()
    expect(item.tokens).toEqual(noTokens)
  })
  it('merges split output counters by durable API call id and deduplicates snapshots', () => {
    const first = assistant('a', { apiCallId: 'completion-1', chunkCount: 2, chunkIndex: 0, outputTokens: 40 })
    const second = assistant('b', { apiCallId: 'completion-1', chunkCount: 2, chunkIndex: 1, outputTokens: 40 })
    const result = parseNativeIde('github_copilot', [start, first, second, second], copilotContext)
    expect(result).toHaveLength(1)
    expect(result[0].tokens.output).toBe('40')
    expect(parseNativeIde('github_copilot', [start, first], copilotContext)[0].eventId).toBe(result[0].eventId)
    expect(
      parseNativeIde('github_copilot', [start, assistant('c', { chunkCount: 2, outputTokens: 40 })], copilotContext)[0]
        .tokens.output,
    ).toBeNull()
  })
  it('isolates subagents, keeps parent relation, and rejects malformed agent identities', () => {
    const result = parseNativeIde(
      'github_copilot',
      [start, assistant('a'), { ...assistant('a'), agentId: 'worker-a' }],
      copilotContext,
    )
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ kind: 'subagent', parentSessionId: 'copilot-session' })
    expect(result[1].eventId).not.toBe(result[0].eventId)
    expect(
      parseNativeIde('github_copilot', [start, { ...assistant('b'), agentId: 'PRIVATE invalid' }], copilotContext),
    ).toEqual([])
  })
  it('uses recorded context changes only for subsequent events; file location is never workspace', () => {
    const result = parseNativeIde(
      'github_copilot',
      [
        assistant('before'),
        start,
        { type: 'session.context_changed', data: { cwd: '/work/second' } },
        assistant('after'),
      ],
      copilotContext,
    )
    expect(result[0].cwd).toBeNull()
    expect(result[1].cwd).toBe('/work/second')
  })
})

const wire = (type: string, payload: unknown, offset = 0) => ({
  timestamp: milliseconds / 1000 + offset,
  message: { type, payload },
})
const usage = { input_other: 10, output: 7, input_cache_read: 20, input_cache_creation: 3 }
const kimiContext = { file: '/home/fixture/.kimi/sessions/workdirhash/session-a/wire.jsonl' }
describe('Kimi CLI wire snapshots', () => {
  it('normalizes the actual timestamp/message envelope and explicit four-part usage', () => {
    const [item] = parseNativeIde(
      'kimi_cli',
      [wire('StatusUpdate', { message_id: 'completion-a', token_usage: usage }, 0.125)],
      kimiContext,
    )
    expect(item.timestamp).toBe('2026-09-29T10:00:00.125Z')
    expect(item.tokens).toEqual({ input: '33', cached: '20', output: '7', reasoning: null, total: '40' })
    expect(item.model).toBeNull()
    expect(item.cwd).toBeNull()
  })
  it('enriches the same stable step activity without counting repeated StatusUpdate reports twice', () => {
    const step = wire('StepBegin', { n: 1 }, 1)
    const [initial] = parseNativeIde('kimi_cli', [wire('TurnBegin', { user_input: 'PRIVATE' }), step], kimiContext)
    const updated = parseNativeIde(
      'kimi_cli',
      [
        wire('TurnBegin', { user_input: 'PRIVATE' }),
        step,
        wire('StatusUpdate', { token_usage: usage }, 2),
        wire('StatusUpdate', { message_id: 'completion-a', token_usage: usage }, 3),
      ],
      kimiContext,
    )
    expect(initial.tokens).toEqual(noTokens)
    expect(updated).toHaveLength(1)
    expect(updated[0].eventId).toBe(initial.eventId)
    expect(updated[0].timestamp).toBe(initial.timestamp)
    expect(updated[0].tokens.total).toBe('40')
    expect(JSON.stringify(updated)).not.toContain('PRIVATE')
  })
  it('keeps missing fields unknown instead of applying producer-side defaults', () => {
    const [item] = parseNativeIde(
      'kimi_cli',
      [wire('StatusUpdate', { message_id: 'm', token_usage: { input_other: 10, output: 0 } })],
      kimiContext,
    )
    expect(item.tokens).toEqual({ ...noTokens, output: '0' })
    expect(parseNativeIde('kimi_cli', [wire('StatusUpdate', { token_usage: usage })], kimiContext)).toEqual([])
    expect(
      parseNativeIde('kimi_cli', [wire('StatusUpdate', { context_tokens: 100, max_context_tokens: 200 })], kimiContext),
    ).toEqual([])
  })
  it('records step subagents separately and does not retain prompts, tool inputs or credentials', () => {
    const child = wire('SubagentEvent', {
      agent_id: 'child-a',
      parent_tool_call_id: 'tool-a',
      event: { type: 'StatusUpdate', payload: { message_id: 'm', token_usage: usage, access_token: 'PRIVATE' } },
    })
    const result = parseNativeIde(
      'kimi_cli',
      [
        wire('StatusUpdate', { message_id: 'm', token_usage: usage }),
        child,
        child,
        wire('ToolCall', { arguments: 'PRIVATE' }),
        wire('TextPart', { text: 'PRIVATE' }),
      ],
      { ...kimiContext, workspace: '/explicit' },
    )
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ kind: 'subagent', parentSessionId: result[0].sessionId, cwd: '/explicit' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
})

it('rejects unknown tools/relative files, ignores malformed values, and keeps identifiers bounded', () => {
  expect(parseNativeIde('unknown', [], context)).toEqual([])
  expect(parseNativeIde('cline', [request({})], { file: 'relative.json' })).toEqual([])
  expect(parseNativeIde('kimi_cli', [null, true, 'PRIVATE', {}, { timestamp: Infinity }], kimiContext)).toEqual([])
  const result = parseNativeIde(
    'github_copilot',
    [{ ...start, data: { sessionId: 'x'.repeat(1000) } }, assistant('a')],
    { file: '/home/' + 'x'.repeat(1000) + '/events.jsonl' },
  )
  expect(result[0].sessionId.length).toBeLessThanOrEqual(160)
  expect(result[0].eventId).toMatch(/^[a-f0-9]{64}$/)
})
