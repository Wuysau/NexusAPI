import { describe, expect, it } from 'vitest'
import { parseExtendedIde } from './extended-ide'

const context = { file: '/home/fixture/.qoder/projects/encoded/transcript/session-1.jsonl' }
const timestamp = '2026-09-29T10:00:00.000Z'
const assistant = {
  type: 'assistant',
  sessionId: 'session-1',
  uuid: 'record-1',
  timestamp,
  cwd: '/work/project',
  message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_MESSAGE' }] },
}
const unknownTokens = { input: null, cached: null, output: null, reasoning: null, total: null }

describe('Qoder documented IDE transcripts', () => {
  it('captures one assistant activity with documented metadata only', () => {
    const [record] = parseExtendedIde('qoder', [assistant], context)
    expect(record).toMatchObject({
      sessionId: 'session-1',
      timestamp,
      cwd: '/work/project',
      model: null,
      kind: 'other',
      tokens: unknownTokens,
    })
    expect(record.eventId).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(record).sort()).toEqual(['cwd', 'eventId', 'kind', 'model', 'sessionId', 'timestamp', 'tokens'])
  })
  it('deduplicates copied records and keeps identities stable across files and content changes', () => {
    const rows = parseExtendedIde(
      'qoder',
      [assistant, { ...assistant, message: { content: 'REPLACED_SECRET' } }],
      context,
    )
    expect(rows).toHaveLength(1)
    expect(parseExtendedIde('qoder', assistant, { file: '/export/copied.jsonl' })).toEqual(rows)
    expect(parseExtendedIde('qoder', { ...assistant, sessionId: 'session-2' }, context)[0].eventId).not.toBe(
      rows[0].eventId,
    )
  })
  it('does not traverse content, credentials, guessed provider usage, model or tool arguments', () => {
    const sensitive = {
      ...assistant,
      model: 'private-model',
      provider: 'private-provider',
      usage: { input_tokens: 999, output_tokens: 888 },
      authorization: 'PRIVATE_TOKEN',
      userId: 'PRIVATE_USER',
      parentSessionId: 'unverified',
    }
    Object.defineProperty(sensitive, 'message', {
      get() {
        throw new Error('content accessed')
      },
    })
    const [record] = parseExtendedIde('qoder', sensitive, context)
    expect(record.tokens).toEqual(unknownTokens)
    expect(record.model).toBeNull()
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE|private|unverified|999|888/)
  })
  it.each(['user', 'session_meta', 'progress', 'result', 'system'])(
    'ignores %s rows including aggregate counters',
    (type) => {
      expect(parseExtendedIde('qoder', { ...assistant, type, usage: { total_tokens: 1000 } }, context)).toEqual([])
    },
  )
  it.each([
    { uuid: undefined },
    { uuid: 'bad id' },
    { uuid: 'a'.repeat(161) },
    { sessionId: undefined },
    { sessionId: 'bad\nidentity' },
    { timestamp: undefined },
    { timestamp: 'invalid' },
    { timestamp: '2026-02-30T10:00:00Z' },
    { timestamp: 1790676000000 },
    { timestamp: '2026-09-29' },
  ])('skips missing or invalid durable identity/time: %j', (override) => {
    expect(parseExtendedIde('qoder', { ...assistant, ...override }, context)).toEqual([])
  })
  it('normalizes explicit offset timestamps and uses only absolute recorded or configured workspaces', () => {
    expect(
      parseExtendedIde('qoder', { ...assistant, timestamp: '2026-09-29T18:00:00+08:00' }, context)[0].timestamp,
    ).toBe(timestamp)
    expect(parseExtendedIde('qoder', { ...assistant, cwd: undefined }, context)[0].cwd).toBeNull()
    expect(
      parseExtendedIde(
        'qoder',
        { ...assistant, cwd: '../relative' },
        { ...context, workspace: 'D:\\work\\configured' },
      )[0].cwd,
    ).toBe('D:\\work\\configured')
    expect(
      parseExtendedIde('qoder', { ...assistant, cwd: '/bad\npath' }, { ...context, workspace: 'relative' })[0].cwd,
    ).toBeNull()
  })
  it('drops conflicting copies of one record instead of choosing a different workspace or timestamp', () => {
    expect(parseExtendedIde('qoder', [assistant, { ...assistant, cwd: '/other/project' }, assistant], context)).toEqual(
      [],
    )
    expect(
      parseExtendedIde('qoder', [assistant, { ...assistant, timestamp: '2026-09-30T10:00:00Z' }], context),
    ).toEqual([])
  })
  it('ignores malformed shapes and bounds the snapshot record count', () => {
    expect(parseExtendedIde('qoder', [null, [], 3, 'secret'], context)).toEqual([])
    expect(() => parseExtendedIde('qoder', Array(50001).fill(assistant), context)).toThrow('extended_ide_record_limit')
  })
})

it('does not invent sessions for Continue dev data or assume undocumented CodeBuddy/AMP native schemas', () => {
  const continueRow = {
    eventName: 'tokensGenerated',
    schema: '0.2.0',
    timestamp,
    model: 'model',
    provider: 'provider',
    promptTokens: 123,
    generatedTokens: 45,
    userId: 'PRIVATE_USER',
    selectedProfileId: 'PRIVATE_PROFILE',
  }
  expect(
    parseExtendedIde('continue', continueRow, { file: '/home/me/.continue/dev_data/0.2.0/tokensGenerated.jsonl' }),
  ).toEqual([])
  expect(
    parseExtendedIde(
      'continue',
      {
        sessionId: 'session-1',
        history: [{ message: { role: 'assistant', content: 'PRIVATE' } }],
        usage: { totalTokens: 100 },
      },
      context,
    ),
  ).toEqual([])
  expect(parseExtendedIde('codebuddy', assistant, context)).toEqual([])
  expect(parseExtendedIde('amp', assistant, context)).toEqual([])
})
