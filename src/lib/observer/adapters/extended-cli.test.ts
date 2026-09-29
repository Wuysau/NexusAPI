import { describe, expect, it } from 'vitest'
import { parseExtendedCli } from './extended-cli'

const stamp = '2026-09-29T10:00:00.000Z'
const later = '2026-09-29T10:01:00.000Z'
const context = { file: '/home/test/.pi/agent/sessions/--work-project--/session.jsonl', workspace: '/work/fallback' }
const header = (extra = {}) => ({
  type: 'session',
  version: 3,
  id: 'session-one',
  timestamp: stamp,
  cwd: '/work/project',
  ...extra,
})
const usage = (extra = {}) => ({
  input: 60,
  cacheRead: 30,
  cacheWrite: 10,
  output: 20,
  reasoning: 5,
  totalTokens: 120,
  cost: { total: 99 },
  ...extra,
})
const assistant = (extra = {}) => ({
  type: 'message',
  id: 'entry-one',
  parentId: 'user-one',
  timestamp: later,
  message: {
    role: 'assistant',
    model: 'custom-model',
    provider: 'NOT_ACCOUNT',
    content: [{ type: 'text', text: 'PRIVATE_PROMPT' }],
    usage: usage(),
  },
  ...extra,
})
const droidMessage = (role: 'user' | 'assistant', id: string, time: string) => ({
  type: role,
  message: {
    id,
    role,
    createdAt: Date.parse(time),
    updatedAt: Date.parse(time),
    modelId: role === 'assistant' ? 'custom-model' : undefined,
    content: [{ type: 'text', text: 'PRIVATE_PROMPT' }],
  },
})
const droid = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  success: true,
  sessionId: 'droid-session',
  durationMs: 60000,
  turnCount: 1,
  messages: [droidMessage('user', 'user-one', stamp), droidMessage('assistant', 'assistant-one', later)],
  tokenUsage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    factoryCredits: 99,
  },
  text: 'PRIVATE_RESULT',
  ...extra,
})

describe('Pi and legacy OpenClaw session exports', () => {
  it.each(['pi', 'openclaw'])('reads %s message usage without double-counting cache or reasoning', (tool) => {
    const records = parseExtendedCli(tool, [header(), assistant()], context)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionId: 'session-one',
      timestamp: later,
      cwd: '/work/project',
      model: 'custom-model',
      tokens: { input: '100', cached: '30', output: '20', reasoning: '5', total: '120' },
    })
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|NOT_ACCOUNT|cost|factoryCredits/)
    expect(records[0].eventId).toMatch(/^[a-f0-9]{64}$/)
  })
  it('deduplicates repeated entry IDs and preserves all consumed branches', () => {
    const result = parseExtendedCli(
      'pi',
      [
        header(),
        assistant(),
        assistant(),
        { type: 'model_change', id: 'change', modelId: 'ignored' },
        assistant({ id: 'alternate', parentId: 'user-one' }),
      ],
      context,
    )
    expect(result).toHaveLength(2)
    expect(result[0].eventId).not.toBe(result[1].eventId)
    expect(parseExtendedCli('pi', [header(), assistant()], { file: '/copied.jsonl' })[0].eventId).toBe(
      result[0].eventId,
    )
  })
  it('skips copied entries preceding a fork header and retains subsequent usage', () => {
    const parentId = '01900000-0000-7000-8000-000000000001'
    const result = parseExtendedCli(
      'pi',
      [
        header({ timestamp: later, parentSession: `/pi/2026-09-29T10-00-00-000Z_${parentId}.jsonl` }),
        assistant({ timestamp: stamp }),
        assistant({ id: 'new-entry', timestamp: '2026-09-29T10:02:00.000Z' }),
      ],
      context,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ parentSessionId: parentId, kind: 'cli' })
    expect(
      parseExtendedCli(
        'pi',
        [header({ parentSession: '/renamed.jsonl', timestamp: 'bad-date' }), assistant()],
        context,
      ),
    ).toEqual([])
  })
  it('supports verified Pi usage, compaction and branch summary counters without reading summaries', () => {
    const records = parseExtendedCli(
      'pi',
      [
        header(),
        {
          type: 'usage',
          id: 'warm',
          timestamp: later,
          model: 'warm-model',
          kind: 'cache_warm',
          usage: usage(),
          note: 'PRIVATE_NOTE',
        },
        {
          type: 'compaction',
          id: 'compact',
          timestamp: later,
          usage: usage(),
          summary: 'PRIVATE_SUMMARY',
          tokensBefore: 999999,
        },
        { type: 'branch_summary', id: 'branch', timestamp: later, usage: usage(), summary: 'PRIVATE_SUMMARY' },
      ],
      context,
    )
    expect(records).toHaveLength(3)
    expect(records[0].model).toBe('warm-model')
    expect(records[1].model).toBeNull()
    expect(JSON.stringify(records)).not.toContain('PRIVATE')
  })
  it('preserves unknown counters and activity-only assistant messages', () => {
    const result = parseExtendedCli(
      'pi',
      [header({ cwd: null }), assistant({ message: { role: 'assistant', model: 'custom', usage: { output: 2 } } })],
      context,
    )
    expect(result[0]).toMatchObject({
      cwd: '/work/fallback',
      tokens: { input: null, cached: null, output: '2', reasoning: null, total: null },
    })
    expect(
      parseExtendedCli('pi', [header(), assistant({ message: { role: 'assistant' } })], context)[0].tokens,
    ).toEqual({ input: null, cached: null, output: null, reasoning: null, total: null })
  })
  it.each([
    { totalTokens: 121 },
    { reasoning: 21 },
    { input: -1 },
    { cacheRead: '30' },
    { output: 1.5 },
    { input: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed or inconsistent Pi counters %j', (extra) => {
    expect(
      parseExtendedCli('pi', [header(), assistant({ message: { role: 'assistant', usage: usage(extra) } })], context),
    ).toEqual([])
  })
  it('rejects missing/conflicting headers, unsupported versions and timestamp-free messages', () => {
    expect(parseExtendedCli('pi', [assistant()], context)).toEqual([])
    expect(parseExtendedCli('pi', [header({ version: 1 }), assistant()], context)).toEqual([])
    expect(parseExtendedCli('pi', [header(), header({ id: 'other' }), assistant()], context)).toEqual([])
    expect(parseExtendedCli('pi', [header(), assistant({ timestamp: undefined })], context)).toEqual([])
  })
  it('fails oversized snapshots rather than returning partial accounting', () => {
    expect(() => parseExtendedCli('pi', [header(), ...Array(100000).fill(null)], context)).toThrow(
      'extended_cli_record_limit',
    )
  })
})

describe('Factory Droid official SDK result exports', () => {
  it('reads per-turn exports with stable message-based identity and actual timestamps', () => {
    const records = parseExtendedCli('factory_droid', [droid(), droid()], context)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionId: 'droid-session',
      timestamp: later,
      cwd: '/work/fallback',
      model: null,
      tokens: { input: '10', output: '5', cached: '0', reasoning: '0', total: null },
    })
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|factoryCredits/)
    expect(parseExtendedCli('factory_droid', droid(), { file: '/moved.json' })[0].eventId).toBe(records[0].eventId)
  })
  it('preserves known cache/reasoning counters without guessing cross-provider overlap', () => {
    const record = parseExtendedCli(
      'factory_droid',
      droid({
        tokenUsage: {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheCreationTokens: 10,
          thinkingTokens: 5,
        },
      }),
      context,
    )[0]
    expect(record.tokens).toEqual({ input: null, output: null, cached: '30', reasoning: '5', total: null })
  })
  it('counts separate turns once and ignores cumulative updates, nested result text and raw CLI result', () => {
    const second = droid({
      messages: [droidMessage('user', 'user-two', later), droidMessage('assistant', 'assistant-two', later)],
    })
    expect(
      parseExtendedCli('factory_droid', [droid(), { type: 'token_usage_update', inputTokens: 9999 }, second], context),
    ).toHaveLength(2)
    expect(
      parseExtendedCli(
        'factory_droid',
        { type: 'result', session_id: 'cli-session', duration_ms: 20, result: 'PRIVATE' },
        context,
      ),
    ).toEqual([])
  })
  it('keeps absent usage unknown and rejects invalid token values or missing identity/time', () => {
    expect(parseExtendedCli('factory_droid', droid({ tokenUsage: null }), context)[0].tokens).toEqual({
      input: null,
      output: null,
      cached: null,
      reasoning: null,
      total: null,
    })
    expect(parseExtendedCli('factory_droid', droid({ tokenUsage: { inputTokens: -2 } }), context)).toEqual([])
    expect(parseExtendedCli('factory_droid', droid({ messages: [] }), context)).toEqual([])
    expect(
      parseExtendedCli(
        'factory_droid',
        droid({ messages: [{ type: 'assistant', message: { id: 'a', role: 'assistant', createdAt: 'not-a-date' } }] }),
        context,
      ),
    ).toEqual([])
  })
  it('rejects oversized nested result message arrays', () => {
    expect(() => parseExtendedCli('factory_droid', droid({ messages: Array(100001).fill(null) }), context)).toThrow(
      'extended_cli_record_limit',
    )
  })
})
