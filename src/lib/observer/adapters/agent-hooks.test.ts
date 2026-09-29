import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseAgentHook } from './agent-hooks'
import { mergeTelemetryRecord } from './telemetry'

const context = { file: 'never-open-transcript.jsonl', workspace: '/workspace/project' }
const time = '2026-09-29T10:00:00Z'
const nullTokens = { input: null, cached: null, output: null, reasoning: null, total: null }
const fixtures = [
  [
    'windsurf',
    {
      agent_action_name: 'post_cascade_response',
      trajectory_id: 'conversation',
      execution_id: 'turn-1',
      timestamp: time,
      model_name: 'Claude Sonnet 4',
      tool_info: { response: 'PRIVATE_RESPONSE' },
    },
  ],
  [
    'codebuddy',
    {
      session_id: 'conversation',
      hook_event_name: 'Stop',
      generation_id: 'turn-1',
      cwd: '/workspace/project',
      stop_hook_active: false,
    },
  ],
  [
    'factory_droid',
    {
      session_id: 'conversation',
      hook_event_name: 'Stop',
      message_id: 'message-1',
      cwd: '/workspace/project',
      stop_hook_active: false,
      tool_execution_count: 3,
      elapsed_time: 500,
    },
  ],
  [
    'qoder',
    {
      session_id: 'conversation',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: '/workspace/project',
      model: 'Auto',
    },
  ],
  ['kiro', { session_id: 'conversation', hook_event_name: 'agentSpawn', cwd: '/workspace/project' }],
  [
    'antigravity',
    {
      conversationId: 'conversation',
      stepIdx: 0,
      workspacePaths: ['/workspace/project'],
      modelName: 'gemini-3.6-flash-medium',
      toolCall: { name: 'run_command', args: { CommandLine: 'PRIVATE_COMMAND' } },
    },
  ],
] as const

afterEach(() => vi.useRealTimers())
describe('official agent hook metadata', () => {
  it.each(fixtures)(
    'captures %s official identity without retaining sensitive fields or inferring tokens',
    (tool, input) => {
      const [record] = parseAgentHook(
        tool,
        {
          ...input,
          transcript_path: 'PRIVATE_TRANSCRIPT',
          transcriptPath: 'PRIVATE_TRANSCRIPT',
          last_assistant_message: 'PRIVATE_RESPONSE',
          prompt: 'PRIVATE_PROMPT',
          credentials: 'PRIVATE_SECRET',
          tokens: { input: 100, output: 200, total: 300 },
        },
        context,
      )
      expect(record.sessionId).toBe('conversation')
      expect(record.cwd).toBe('/workspace/project')
      expect(record.tokens).toEqual(nullTokens)
      expect(JSON.stringify(record)).not.toContain('PRIVATE_')
      expect(record.model).toBe(tool === 'antigravity' ? 'gemini-3.6-flash-medium' : null)
    },
  )
  it.each(fixtures)('deduplicates %s retries despite capture-time changes', (tool, input) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(time))
    const [first] = parseAgentHook(tool, input, context)
    vi.setSystemTime(new Date('2026-09-29T10:01:00Z'))
    const [retry] = parseAgentHook(tool, input, context)
    expect(mergeTelemetryRecord(first, retry)).toEqual(first)
    expect(parseAgentHook(tool, [input, input], context)).toHaveLength(1)
  })
  it.each(['codebuddy', 'factory_droid', 'qoder', 'kiro'])(
    'never invents %s turn identity from text, trace or time',
    (tool) => {
      const input = {
        session_id: 'conversation',
        hook_event_name: 'Stop',
        timestamp: time,
        messageId: 'wrong-id',
        traceId: 'wrong-id',
        prompt: 'same text',
      }
      expect(parseAgentHook(tool, input, context)).toEqual([])
      const records = parseAgentHook(
        tool,
        [
          { ...input, nexus_event_id: 'turn-1' },
          { ...input, nexus_event_id: 'turn-2' },
        ],
        context,
      )
      expect(records).toHaveLength(2)
    },
  )
  it('does not collapse different native turns', () => {
    for (const [tool, key] of [
      ['windsurf', 'execution_id'],
      ['codebuddy', 'generation_id'],
      ['factory_droid', 'message_id'],
      ['antigravity', 'stepIdx'],
    ] as const) {
      const fixture = fixtures.find(([name]) => name === tool)![1]
      expect(
        parseAgentHook(tool, [{ ...fixture }, { ...fixture, [key]: key === 'stepIdx' ? 1 : 'turn-2' }], context),
      ).toHaveLength(2)
    }
  })
  it('limits Qoder lifecycle to session starts/ends and skips resume/compaction/pre-tool hooks', () => {
    const base = { session_id: 'session', cwd: '/workspace/project' }
    expect(
      parseAgentHook(
        'qoder',
        ['resume', 'compact'].map((source) => ({ ...base, hook_event_name: 'SessionStart', source })),
        context,
      ),
    ).toEqual([])
    expect(
      parseAgentHook(
        'qoder',
        ['SessionStart', 'SessionEnd'].map((hook_event_name) => ({ ...base, hook_event_name })),
        context,
      ),
    ).toHaveLength(2)
    expect(parseAgentHook('qoder', { ...base, hook_event_name: 'PreToolUse', tool_use_id: 'id' }, context)).toEqual([])
    expect(
      parseAgentHook(
        'kiro',
        [
          { ...base, hook_event_name: 'SessionStart' },
          { ...base, hook_event_name: 'agentSpawn' },
        ],
        context,
      ),
    ).toHaveLength(1)
  })
  it('does not assign Antigravity multi-root work to the capture working directory', () => {
    expect(
      parseAgentHook('antigravity', { ...fixtures[5][1], workspacePaths: ['/first', '/second'] }, context)[0].cwd,
    ).toBeNull()
    expect(parseAgentHook('antigravity', { conversationId: 'id', executionNum: 1, fullyIdle: true }, context)).toEqual(
      [],
    )
  })
  it('captures Qoder PostToolUse using the official stable tool_use_id without tool input/output', () => {
    const base = {
      session_id: 'session',
      hook_event_name: 'PostToolUse',
      cwd: '/workspace/project',
      tool_name: 'Write',
      tool_input: { content: 'PRIVATE_CONTENT' },
      tool_response: { text: 'PRIVATE_RESPONSE' },
    }
    expect(parseAgentHook('qoder', base, context)).toEqual([])
    const records = parseAgentHook(
      'qoder',
      ['toolu_01', 'toolu_02'].map((tool_use_id) => ({ ...base, tool_use_id })),
      context,
    )
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('PRIVATE_')
  })
  it('rejects invalid stable identifiers, unsafe indices, canonical input and cross-tool payloads', () => {
    expect(() => parseAgentHook('codebuddy', { ...fixtures[1][1], generation_id: 'secret\ntext' }, context)).toThrow(
      'invalid_telemetry_identity',
    )
    for (const stepIdx of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(() => parseAgentHook('antigravity', { ...fixtures[5][1], stepIdx }, context)).toThrow(
        'invalid_telemetry_identity',
      )
    }
    expect(() => parseAgentHook('codebuddy', fixtures[0][1], context)).toThrow('telemetry_tool_mismatch')
    expect(() => parseAgentHook('qoder', fixtures[5][1], context)).toThrow('telemetry_tool_mismatch')
    expect(() => parseAgentHook('cursor', {}, context)).toThrow('unsupported_agent_hook_tool')
    expect(() => parseAgentHook('qoder', { schemaVersion: 1 }, context)).toThrow('unsupported_agent_hook_format')
  })
  it('runs the real CLI with neutral stdout and stable metadata-only replay in an isolated home', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-agent-hook-'))
    try {
      const env = { ...process.env, USERPROFILE: home, HOME: home }
      const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
        env,
        encoding: 'utf8',
      })
      expect(probe.stdout).toBe(home)
      const script = fileURLToPath(new URL('../../../../scripts/agent-usage.ts', import.meta.url))
      const runner = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
      for (const [tool, input] of fixtures) {
        const run = () =>
          spawnSync(process.execPath, [runner, script, '--tool', tool, '--format', 'agent-hook'], {
            env,
            cwd: home,
            input: JSON.stringify(input),
            encoding: 'utf8',
            timeout: 10_000,
          })
        const first = run()
        expect(first.status, first.stderr).toBe(0)
        expect(first.stdout.trim()).toBe('{}')
        expect(run().status).toBe(0)
        const saved = await readFile(path.join(home, '.nexusapi', 'usage', `${tool}.jsonl`), 'utf8')
        expect(saved.trim().split('\n')).toHaveLength(1)
        expect(saved).not.toContain('PRIVATE_')
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
