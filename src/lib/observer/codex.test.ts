import { describe, expect, it } from 'vitest'
import { CodexParser } from './codex'
import { matchWorkspace, normalizeWorkspace } from './workspace'

const stamp = '2026-09-18T10:00:00.000Z'
const usage = (extra = {}) => ({
  input_tokens: 20,
  cached_input_tokens: 10,
  output_tokens: 5,
  reasoning_output_tokens: 2,
  total_tokens: 25,
  ...extra,
})
function parser(version = '0.154.0') {
  const p = new CodexParser()
  p.parse({
    type: 'session_meta',
    payload: {
      id: 'session-a',
      cwd: 'D:\\Projects\\Nexus',
      model_provider: 'openai',
      cli_version: version,
      instructions: 'PRIVATE_PROMPT',
    },
  })
  p.parse({ type: 'turn_context', payload: { turn_id: 'turn-a', cwd: 'D:\\Projects\\Nexus', model: 'model-a' } })
  return p
}
function event(last = usage(), total = last) {
  return {
    timestamp: stamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: last, total_token_usage: total },
      assistant_message: 'PRIVATE_ASSISTANT',
      api_key: 'PRIVATE_CREDENTIAL',
    },
  }
}
describe('allowlisted Codex telemetry', () => {
  it.each(['0.149.1', '0.154.0'])('parses observed rollout shape %s with inclusive subsets', (version) => {
    const p = parser(version),
      e = p.parse(event())!
    expect(e.tokens).toEqual({ input: '20', cached: '10', output: '5', reasoning: '2', total: '25' })
    expect(e).toMatchObject({
      sessionId: 'session-a',
      turnId: 'turn-a',
      providerIdentifier: 'openai',
      model: 'model-a',
      source: 'codex_local',
      authority: 'client_observed',
    })
    expect(JSON.stringify([e, p.state])).not.toContain('PRIVATE_')
  })
  it('preserves missing fields versus explicit zero', () => {
    expect(
      parser().parse(event({ input_tokens: 20, output_tokens: 5, cached_input_tokens: 0 } as ReturnType<typeof usage>))!
        .tokens,
    ).toEqual({ input: '20', cached: '0', output: '5', reasoning: null, total: null })
  })
  it('ignores repeated quota notifications and alternate usage records', () => {
    const p = parser()
    const e = p.parse(event())!
    expect(p.parse({ ...event(), timestamp: '2026-09-18T10:01:00.000Z' })).toBeNull()
    expect(p.parse({ type: 'token_usage_record', payload: usage() })).toBeNull()
    expect(p.parse({ type: 'future_event', payload: { prompt: 'PRIVATE_PROMPT' } })).toBeNull()
    expect(parser().parse(event())!.eventId).toBe(e.eventId)
  })
  it('identifies another equal-sized usage from cumulative progress', () => {
    const p = parser()
    const one = p.parse(event())!
    const two = p.parse(
      event(
        usage(),
        usage({
          input_tokens: 40,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 50,
        }),
      ),
    )!
    expect(two.eventId).not.toBe(one.eventId)
    expect(two.tokens).toEqual(one.tokens)
  })
  it('rejects unsafe and inconsistent numbers without guessing', () => {
    expect(parser().parse(event(usage({ input_tokens: -1 })))).toBeNull()
    expect(parser().parse(event(usage({ total_tokens: 99 })))).toBeNull()
    expect(parser().parse(event(usage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 })))).toBeNull()
  })
  it('restores only allowlisted state for incremental reads', () => {
    const p = parser()
    p.parse(event())
    const next = new CodexParser(JSON.parse(JSON.stringify(p.state)))
    expect(next.parse(event())).toBeNull()
    expect(next.parse(event(usage(), usage({ input_tokens: 40, output_tokens: 10, total_tokens: 50 })))).not.toBeNull()
  })
})
describe('workspace attribution', () => {
  const roots = [
    { root: 'D:\\Projects', projectId: 'parent', projectName: 'Parent' },
    { root: 'd:/projects/Nexus/', projectId: 'nexus', projectName: 'Nexus' },
    { root: '/home/me/Nexus', projectId: 'linux', projectName: 'Linux' },
  ]
  it.each(['D:\\PROJECTS\\NEXUS', 'd:/projects/nexus/services/../src/'])(
    'uses Windows case-insensitive longest segment root: %s',
    (cwd) => {
      expect(matchWorkspace(cwd, roots)?.projectId).toBe('nexus')
    },
  )
  it('matches POSIX and WSL case sensitively, without drive guessing', () => {
    expect(matchWorkspace('/home/me/Nexus/a', roots)?.projectId).toBe('linux')
    expect(matchWorkspace('/home/me/nexus', roots)).toBeNull()
    expect(matchWorkspace('/mnt/d/projects/nexus', roots)).toBeNull()
    expect(matchWorkspace('D:/Projects/Nexus2', roots)?.projectId).toBe('parent')
  })
  it('rejects relative roots and leaves relative/unknown cwd unassigned', () => {
    expect(() => normalizeWorkspace('../Nexus')).toThrow()
    expect(matchWorkspace('../Nexus', roots)).toBeNull()
    expect(matchWorkspace('/elsewhere', roots)).toBeNull()
  })
  it('rejects ambiguous equal roots rather than using array order', () => {
    expect(() =>
      matchWorkspace('D:/Projects/Nexus', [
        ...roots,
        { root: 'D:/projects/NEXUS', projectId: 'other', projectName: 'Other' },
      ]),
    ).toThrow()
  })
})
