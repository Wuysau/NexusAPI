import { mkdtemp, readFile, rm, writeFile, mkdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { appendTelemetry, parseArguments, readTelemetryInput } from '../../../../scripts/agent-usage'
import { parseTelemetry } from './telemetry'

const context = { file: 'fixture.json', workspace: 'D:/Projects/Demo' }
const canonical = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  tool: 'cursor',
  sessionId: 'session-1',
  eventId: 'event-1',
  timestamp: '2026-09-29T12:00:00Z',
  tokens: { input: '20', cached: '10', output: '8', reasoning: '3', total: '28' },
  ...extra,
})
const attr = (key: string, value: unknown) => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
})
const ns = '1790683200123456789'
const otlp = (attributes: ReturnType<typeof attr>[], extra: Record<string, unknown> = {}) => ({
  resourceLogs: [
    {
      resource: { attributes: [attr('service.name', 'gemini-cli')] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: ns,
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              attributes,
              ...extra,
            },
          ],
        },
      ],
    },
  ],
})
const genericAttrs = [
  attr('session.id', 'session-1'),
  attr('gen_ai.usage.input_tokens', 20),
  attr('gen_ai.usage.output_tokens', 8),
  attr('gen_ai.request.model', 'gemini-model'),
]

describe('metadata-only agent telemetry', () => {
  it('projects canonical metadata and never copies prompts, credentials, identities or file contents', () => {
    const input = canonical({
      prompt: 'private-prompt',
      response: 'private-response',
      apiKey: 'private-key',
      user_email: 'private-email',
      messages: [{ text: 'private-text' }],
    })
    const result = parseTelemetry('cursor', input, context)
    expect(result).toEqual([
      {
        sessionId: 'session-1',
        eventId: 'event-1',
        timestamp: '2026-09-29T12:00:00.000Z',
        cwd: context.workspace,
        model: null,
        tokens: { input: '20', cached: '10', output: '8', reasoning: '3', total: '28' },
      },
    ])
    expect(JSON.stringify(result)).not.toContain('private-')
  })
  it('keeps unknown dimensions null and preserves safe decimal counters beyond Number.MAX_SAFE_INTEGER', () => {
    const [result] = parseTelemetry('cursor', canonical({ tokens: { input: '9007199254740993', output: 0 } }), context)
    expect(result.tokens).toEqual({
      input: '9007199254740993',
      output: '0',
      cached: null,
      reasoning: null,
      total: null,
    })
    expect(parseTelemetry('cursor', canonical({ tokens: undefined }), context)[0].tokens.input).toBeNull()
  })
  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '1e3', '01', '9223372036854775808', {}, true])(
    'rejects unsafe integer %j',
    (value) => {
      expect(() => parseTelemetry('cursor', canonical({ tokens: { input: value } }), context)).toThrow(
        'invalid_telemetry_tokens',
      )
    },
  )
  it.each([
    { input: '2', cached: '3' },
    { output: '1', reasoning: '2' },
    { input: '5', output: '7', total: '13' },
  ])('rejects inconsistent counter semantics %j', (tokens) => {
    expect(() => parseTelemetry('cursor', canonical({ tokens }), context)).toThrow('invalid_telemetry_tokens')
  })
  it('rejects cross-tool payloads, malformed identities, relative workspaces and unknown schemas', () => {
    expect(() => parseTelemetry('github_copilot', canonical(), context)).toThrow('telemetry_tool_mismatch')
    expect(() => parseTelemetry('../cursor', canonical(), context)).toThrow('invalid_telemetry_tool')
    expect(() => parseTelemetry('cursor', canonical({ eventId: 'secret\nheader' }), context)).toThrow(
      'invalid_telemetry_identity',
    )
    expect(() => parseTelemetry('cursor', canonical({ cwd: '../outside' }), context)).toThrow(
      'invalid_telemetry_workspace',
    )
    expect(() => parseTelemetry('cursor', canonical({ schemaVersion: 2 }), context)).toThrow('telemetry_tool_mismatch')
  })
  it('deduplicates stable event identity across array replay and rejects changed counters', () => {
    expect(parseTelemetry('cursor', [canonical(), canonical()], context)).toHaveLength(1)
    expect(() => parseTelemetry('cursor', [canonical(), canonical({ tokens: { input: '1' } })], context)).toThrow(
      'telemetry_replay_conflict',
    )
  })
  it('decodes OTLP typed attrs and nanosecond time while dropping body, prompt, command and auth attrs', () => {
    const input = otlp(
      [
        ...genericAttrs,
        attr('gen_ai.input.messages', 'secret-prompt'),
        attr('authorization', 'secret-key'),
        attr('process.command_line', 'secret-command'),
      ],
      { body: { stringValue: 'secret-response' } },
    )
    const result = parseTelemetry('gemini_cli', input, context)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionId: 'session-1',
      model: 'gemini-model',
      timestamp: '2026-09-29T12:00:00.123Z',
      tokens: { input: '20', output: '8', cached: null, reasoning: null, total: null },
    })
    expect(JSON.stringify(result)).not.toContain('secret-')
    expect(parseTelemetry('gemini_cli', input, { file: 'renamed.json', workspace: context.workspace })).toEqual(result)
  })
  it('accepts resourceSpans and deduplicates replay by trace/span identifiers', () => {
    const span = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      endTimeUnixNano: ns,
      attributes: genericAttrs,
    }
    const payload = {
      resourceSpans: [
        { resource: { attributes: [attr('nexus.tool', 'aider')] }, scopeSpans: [{ spans: [span, span] }] },
      ],
    }
    expect(parseTelemetry('aider', payload, context)).toHaveLength(1)
    expect(() => parseTelemetry('cursor', payload, context)).toThrow('telemetry_tool_mismatch')
  })
  it('rejects ambiguous attributes and target-tool mismatch even if local attrs try to override resource attrs', () => {
    expect(() => parseTelemetry('claude_code', otlp(genericAttrs), context)).toThrow('telemetry_tool_mismatch')
    expect(() =>
      parseTelemetry('gemini_cli', otlp([...genericAttrs, attr('session.id', 'session-2')]), context),
    ).toThrow('ambiguous_telemetry_attribute')
    expect(() =>
      parseTelemetry('claude_code', otlp([...genericAttrs, attr('service.name', 'claude-code')]), context),
    ).toThrow('telemetry_tool_mismatch')
  })
  it('normalizes Claude cache-inclusive input without guessing absent cache components', () => {
    const payload = otlp([
      attr('session.id', 's'),
      attr('event.name', 'api_request'),
      attr('request_id', 'req_1'),
      attr('input_tokens', 5),
      attr('cache_read_tokens', 20),
      attr('cache_creation_tokens', 10),
      attr('output_tokens', 7),
    ])
    payload.resourceLogs[0].resource.attributes = [attr('service.name', 'claude-code')]
    expect(parseTelemetry('claude_code', payload, context)[0].tokens).toEqual({
      input: '35',
      cached: '20',
      output: '7',
      reasoning: null,
      total: null,
    })
    payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes = [
      attr('session.id', 's'),
      attr('event.name', 'api_request'),
      attr('input_tokens', 5),
      attr('output_tokens', 7),
    ]
    expect(parseTelemetry('claude_code', payload, context)[0].tokens.input).toBeNull()
  })
  it('normalizes Gemini candidate output plus reasoning without counting cached input twice', () => {
    const payload = otlp([
      attr('session.id', 's'),
      attr('event.name', 'gemini_cli.api_response'),
      attr('input_token_count', 20),
      attr('cached_content_token_count', 10),
      attr('output_token_count', 5),
      attr('thoughts_token_count', 3),
      attr('total_token_count', 28),
    ])
    expect(parseTelemetry('gemini_cli', payload, context)[0].tokens).toEqual({
      input: '20',
      cached: '10',
      output: '8',
      reasoning: '3',
      total: '28',
    })
  })
  it('skips content-only OTLP events and token records missing stable identity or session metadata', () => {
    expect(parseTelemetry('gemini_cli', otlp([attr('session.id', 's'), attr('prompt', 'secret')]), context)).toEqual([])
    expect(
      parseTelemetry('gemini_cli', otlp(genericAttrs, { traceId: undefined, spanId: undefined }), context),
    ).toEqual([])
    expect(parseTelemetry('gemini_cli', otlp([attr('gen_ai.usage.input_tokens', 5)]), context)).toEqual([])
  })
  it('handles official Cursor response and stop hooks without copying response text or inventing usage', () => {
    const hook = {
      conversation_id: 'conversation',
      generation_id: 'generation',
      hook_event_name: 'afterAgentResponse',
      model: 'claude-model',
      workspace_roots: ['D:/Repo'],
      text: 'private-response',
      user_email: 'private-user',
    }
    const [first] = parseTelemetry('cursor', hook, { file: 'stdin' })
    const [replay] = parseTelemetry('cursor', { ...hook, text: 'changed-private-response' }, { file: 'stdin' })
    expect(first.eventId).toBe(replay.eventId)
    expect(first.tokens).toEqual({ input: null, cached: null, output: null, reasoning: null, total: null })
    expect(JSON.stringify(first)).not.toContain('private-')
    expect(first.cwd).toBe('D:/Repo')
    expect(parseTelemetry('cursor', { ...hook, hook_event_name: 'stop' }, context)[0].eventId).not.toBe(first.eventId)
    expect(() => parseTelemetry('cursor', { ...hook, generation_id: undefined }, context)).toThrow(
      'invalid_telemetry_identity',
    )
    expect(
      parseTelemetry('cursor', { ...hook, workspace_roots: ['D:/One', 'D:/Two'] }, { file: 'stdin' })[0].cwd,
    ).toBeNull()
  })
})

const temporaryHomes: string[] = []
afterEach(async () => {
  for (const directory of temporaryHomes.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('nexus-telemetry-'))
      throw new Error('unsafe test cleanup')
    await rm(directory, { recursive: true, force: true })
  }
})
async function tempHome() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-telemetry-'))
  temporaryHomes.push(directory)
  return directory
}
describe('agent-usage local spool', () => {
  it('validates arguments and limits stdin without printing input payloads', async () => {
    expect(parseArguments(['--tool', 'github_copilot', '--format', 'canonical'])).toMatchObject({
      tool: 'github_copilot',
    })
    expect(() => parseArguments(['--tool', '../cursor', '--format', 'canonical'])).toThrow('invalid_arguments')
    expect(() => parseArguments(['--tool', 'cursor', '--format', 'canonical', '--tool', 'cursor'])).toThrow(
      'invalid_arguments',
    )
    await expect(readTelemetryInput([Buffer.from('sensitive-invalid-json')])).rejects.toThrow(
      /^invalid_telemetry_json$/,
    )
    await expect(readTelemetryInput([Buffer.alloc(1_048_577)])).rejects.toThrow('telemetry_input_too_large')
  })
  it('appends only canonical metadata, suppresses repeated events, and rejects conflicting replay', async () => {
    const home = await tempHome()
    const row = parseTelemetry('cursor', canonical({ secret: 'never-persist' }), context)[0]
    expect(await appendTelemetry('cursor', [row], undefined, home)).toEqual({ appended: 1, duplicates: 0 })
    expect(await appendTelemetry('cursor', [{ ...row, timestamp: '2026-09-29T12:01:00Z' }], undefined, home)).toEqual({
      appended: 0,
      duplicates: 1,
    })
    const text = await readFile(path.join(home, '.nexusapi', 'usage', 'cursor.jsonl'), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
    expect(text).not.toContain('never-persist')
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, tool: 'cursor' })
    await expect(appendTelemetry('cursor', [{ ...row, model: 'different' }], undefined, home)).rejects.toThrow(
      'telemetry_replay_conflict',
    )
  })
  it('serializes concurrent replay appends', async () => {
    const home = await tempHome()
    const records = parseTelemetry('cursor', canonical(), context)
    const results = await Promise.all([
      appendTelemetry('cursor', records, undefined, home),
      appendTelemetry('cursor', records, undefined, home),
    ])
    expect(results.reduce((count, result) => count + result.appended, 0)).toBe(1)
  })
  it('appends monotonic revisions and retains the original event timestamp', async () => {
    const home = await tempHome()
    const initial = parseTelemetry('cursor', canonical({ tokens: {} }), context)[0]
    await appendTelemetry('cursor', [initial], undefined, home)
    const complete = parseTelemetry('cursor', canonical(), context)[0]
    expect(
      await appendTelemetry('cursor', [{ ...complete, timestamp: '2026-09-29T12:05:00Z' }], undefined, home),
    ).toEqual({ appended: 1, duplicates: 0 })
    const updated = { ...complete, tokens: { ...complete.tokens, output: '10', total: '30' } }
    expect(await appendTelemetry('cursor', [updated], undefined, home)).toEqual({ appended: 1, duplicates: 0 })
    expect(await appendTelemetry('cursor', [initial], undefined, home)).toEqual({ appended: 0, duplicates: 1 })
    await expect(appendTelemetry('cursor', [complete], undefined, home)).rejects.toThrow('telemetry_replay_conflict')
    const rows = (await readFile(path.join(home, '.nexusapi', 'usage', 'cursor.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.timestamp))).toEqual(new Set([initial.timestamp]))
    expect(parseTelemetry('cursor', rows, context)[0].tokens.total).toBe('30')
  })
  it('runs the real CLI with isolated home and emits Cursor hook JSON without persisting response text', async () => {
    const home = await tempHome()
    const env = { ...process.env, USERPROFILE: home, HOME: home }
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
      env,
      encoding: 'utf8',
    })
    expect(probe.stdout).toBe(home)
    const script = fileURLToPath(new URL('../../../../scripts/agent-usage.ts', import.meta.url))
    const hook = {
      conversation_id: 'session',
      generation_id: 'generation',
      hook_event_name: 'stop',
      workspace_roots: [home],
      model: 'model',
      text: 'private-response',
      user_email: 'private-email',
    }
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', script, '--tool', 'cursor', '--format', 'cursor-hook'], {
        env,
        input: JSON.stringify(hook),
        encoding: 'utf8',
        timeout: 10_000,
      })
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout.trim()).toBe('{}')
    expect(run().status).toBe(0)
    const saved = await readFile(path.join(home, '.nexusapi', 'usage', 'cursor.jsonl'), 'utf8')
    expect(saved.trim().split('\n')).toHaveLength(1)
    expect(saved).not.toContain('private-')
    const invalid = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, '--tool', 'cursor', '--format', 'canonical'],
      { env, input: '{"secret":"private-credential",', encoding: 'utf8', timeout: 10_000 },
    )
    expect(invalid.status).toBe(1)
    expect(invalid.stderr.trim()).toBe('invalid_telemetry_json')
  })
  it('refuses credential paths, traversal, unsafe extensions and hard-linked files', async () => {
    const home = await tempHome()
    const records = parseTelemetry('cursor', canonical(), context)
    for (const output of [
      path.join(home, '.codex', 'auth.json'),
      path.join(home, 'outside.jsonl'),
      path.join(home, '.nexusapi', 'usage', 'auth.json'),
    ]) {
      await expect(appendTelemetry('cursor', records, output, home)).rejects.toThrow('unsafe_telemetry_output')
    }
    await mkdir(path.join(home, '.nexusapi', 'usage'), { recursive: true })
    const secret = path.join(home, 'credential-fixture')
    await writeFile(secret, 'do-not-alter')
    await link(secret, path.join(home, '.nexusapi', 'usage', 'cursor.jsonl'))
    await expect(appendTelemetry('cursor', records, undefined, home)).rejects.toThrow('unsafe_telemetry_output')
    expect(await readFile(secret, 'utf8')).toBe('do-not-alter')
  })
})
