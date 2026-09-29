import { describe, expect, it } from 'vitest'
import { parseNativeCli } from './native-cli'

const timestamp = '2026-09-29T10:00:00.000Z'
const context = { file: '/home/test/.gemini/tmp/hash/chats/session-test.jsonl', workspace: '/work/project' }
const geminiMessage = (extra = {}) => ({
  id: 'msg-1',
  type: 'gemini',
  timestamp,
  model: 'gemini-test',
  content: 'PRIVATE_PROMPT',
  tokens: { input: 100, cached: 40, output: 20, thoughts: 10, tool: 0, total: 130 },
  ...extra,
})
const qwenMessage = (extra = {}) => ({
  uuid: 'msg-1',
  sessionId: 'qwen-session',
  type: 'assistant',
  timestamp,
  cwd: '/work/qwen',
  model: 'qwen-test',
  message: { parts: [{ text: 'PRIVATE_PROMPT' }] },
  usageMetadata: {
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 30,
    thoughtsTokenCount: 10,
    totalTokenCount: 130,
  },
  ...extra,
})
const opencodeMessage = (extra = {}) => ({
  info: {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    modelID: 'model-test',
    providerID: 'DO_NOT_GUESS_PROVIDER',
    time: { created: Date.parse(timestamp) },
    path: { cwd: '/work/opencode' },
    tokens: { input: 50, output: 20, reasoning: 10, cache: { read: 40, write: 10 }, total: 130 },
    ...extra,
  },
  parts: [
    { type: 'text', text: 'PRIVATE_PROMPT' },
    { type: 'step-finish', tokens: { input: 9999 } },
  ],
})
const exported = (messages: unknown[]) => ({ info: { id: 'ses-1', directory: '/work/root' }, messages })

describe('native CLI usage snapshots', () => {
  it('reads legacy Gemini JSON and equivalent JSONL with stable IDs across file migration', () => {
    const metadata = { sessionId: 'session-1', projectHash: 'not-a-workspace', kind: 'main' }
    const legacy = parseNativeCli('gemini_cli', { ...metadata, messages: [geminiMessage()] }, context)
    const jsonl = parseNativeCli('gemini_cli', [metadata, geminiMessage()], { ...context, file: '/copied.jsonl' })
    expect(jsonl).toEqual(legacy)
    expect(legacy).toHaveLength(1)
    expect(legacy[0].tokens).toEqual({ input: '100', cached: '40', output: '30', reasoning: '10', total: '130' })
    expect(legacy[0].cwd).toBe('/work/project')
    expect(JSON.stringify(legacy)).not.toContain('PRIVATE_PROMPT')
  })

  it('uses latest full Gemini message replacement and deduplicates checkpoints and rewinds for usage', () => {
    const records = [
      { sessionId: 'session-1', projectHash: 'hash' },
      geminiMessage({ tokens: null }),
      geminiMessage(),
      { $set: { messages: [geminiMessage()], summary: 'PRIVATE_SUMMARY' } },
      { $rewindTo: 'msg-1' },
      geminiMessage({ id: 'msg-2' }),
    ]
    const result = parseNativeCli('gemini_cli', records, context)
    expect(result).toHaveLength(2)
    expect(result[0].eventId).not.toEqual(result[1].eventId)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(parseNativeCli('gemini_cli', [...records, geminiMessage({ tokens: { input: -1 } })], context)).toHaveLength(
      1,
    )
  })

  it('keeps missing counters unknown and only derives inclusive Gemini output from a consistent total', () => {
    const parse = (tokens: unknown) =>
      parseNativeCli('gemini_cli', { sessionId: 'session-1', messages: [geminiMessage({ tokens })] }, { file: 'file' })
    expect(parse({ input: 10 })[0]).toMatchObject({
      cwd: null,
      tokens: { input: '10', cached: null, output: null, reasoning: null, total: null },
    })
    expect(parse({ input: 10, output: 2, total: 15 })[0].tokens).toEqual({
      input: '10',
      cached: null,
      output: '5',
      reasoning: null,
      total: '15',
    })
    expect(parse({ input: 10, output: 2, thoughts: 0, total: 13 })).toEqual([])
    expect(parse({ input: 10, cached: 11 })).toEqual([])
    expect(parse({ input: 10, tool: 1 })).toEqual([])
    expect(parse({ input: 10, output: 2 })[0].tokens.output).toBeNull()
  })

  it('identifies Gemini subagents only from explicit kind and verified nested chat path', () => {
    const result = parseNativeCli('gemini_cli', [{ sessionId: 'child', kind: 'subagent' }, geminiMessage()], {
      file: 'C:\\Users\\test\\.gemini\\tmp\\hash\\chats\\parent\\child.jsonl',
    })
    expect(result[0]).toMatchObject({ kind: 'subagent', parentSessionId: 'parent', cwd: null })
    expect(
      parseNativeCli('gemini_cli', [{ sessionId: 'a' }, { $set: { sessionId: 'b' } }, geminiMessage()], context),
    ).toEqual([])
  })

  it('reads Qwen native JSONL without adding reasoning twice and retains explicit lineage', () => {
    const parent = {
      type: 'system',
      subtype: 'parent_session',
      sessionId: 'qwen-session',
      systemPayload: { parentSessionId: 'parent' },
    }
    const result = parseNativeCli('qwen_code', [qwenMessage(), parent, qwenMessage()], context)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      cwd: '/work/qwen',
      kind: 'subagent',
      parentSessionId: 'parent',
      tokens: { input: '100', cached: '40', output: '30', reasoning: '10', total: '130' },
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(
      parseNativeCli(
        'qwen_code',
        qwenMessage({ forkedFrom: { sessionId: 'original', messageUuid: 'msg-1' } }),
        context,
      ),
    ).toEqual([])
    expect(
      parseNativeCli('qwen_code', qwenMessage({ usageMetadata: { totalTokenCount: 23 } }), context)[0].tokens,
    ).toEqual({ input: null, output: null, cached: null, reasoning: null, total: '23' })
  })

  it('normalizes OpenCode exclusive cache/write/reasoning counters and ignores duplicate parts totals', () => {
    const result = parseNativeCli('opencode', exported([opencodeMessage(), opencodeMessage()]), context)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      cwd: '/work/opencode',
      model: 'model-test',
      tokens: { input: '100', cached: '40', output: '30', reasoning: '10', total: '130' },
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(JSON.stringify(result)).not.toContain('DO_NOT_GUESS_PROVIDER')
    expect(
      parseNativeCli(
        'opencode',
        { ...exported([opencodeMessage()]), info: { id: 'ses-1', parentID: 'parent' } },
        context,
      )[0],
    ).toMatchObject({ kind: 'subagent', parentSessionId: 'parent' })
    expect(parseNativeCli('opencode', exported([opencodeMessage({ sessionID: 'other' })]), context)).toEqual([])
  })

  it('does not turn missing OpenCode cache-write or reasoning into zero', () => {
    const result = parseNativeCli(
      'opencode',
      exported([opencodeMessage({ tokens: { input: 50, output: 20, cache: { read: 40 } } })]),
      context,
    )
    expect(result[0].tokens).toEqual({ input: null, output: null, cached: '40', reasoning: null, total: null })
  })

  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '10', {}, true])(
    'rejects invalid numeric tokens %j',
    (input) => {
      expect(
        parseNativeCli('gemini_cli', { sessionId: 's', messages: [geminiMessage({ tokens: { input } })] }, context),
      ).toEqual([])
      expect(parseNativeCli('qwen_code', qwenMessage({ usageMetadata: { promptTokenCount: input } }), context)).toEqual(
        [],
      )
      expect(parseNativeCli('opencode', exported([opencodeMessage({ tokens: { input } })]), context)).toEqual([])
    },
  )

  it('rejects malformed identities, timestamps, impossible inclusive totals and unrelated inputs', () => {
    expect(parseNativeCli('gemini_cli', { sessionId: 'x'.repeat(161), messages: [geminiMessage()] }, context)).toEqual(
      [],
    )
    expect(parseNativeCli('qwen_code', qwenMessage({ timestamp: 'not-a-date' }), context)).toEqual([])
    expect(
      parseNativeCli(
        'qwen_code',
        qwenMessage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }),
        context,
      ),
    ).toEqual([])
    expect(parseNativeCli('opencode', exported([opencodeMessage({ time: { created: 1e20 } })]), context)).toEqual([])
    expect(
      parseNativeCli(
        'opencode',
        exported([
          opencodeMessage({
            tokens: { input: 50, output: 20, reasoning: 10, cache: { read: 40, write: 10 }, total: 999 },
          }),
        ]),
        context,
      ),
    ).toEqual([])
    for (const value of [null, {}, [], 'PRIVATE_PROMPT', true, 3]) {
      for (const tool of ['gemini_cli', 'qwen_code', 'opencode', 'unknown'])
        expect(parseNativeCli(tool, value, context)).toEqual([])
    }
  })
})
