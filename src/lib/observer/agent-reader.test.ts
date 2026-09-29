import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { readAgentSnapshot } from './agent-reader'

const dir = await mkdtemp(path.join(tmpdir(), 'nexus-agent-reader-'))
afterAll(() => rm(dir, { recursive: true, force: true }))
const time = '2026-09-29T10:00:00.000Z'
const event = (index: number, tokens?: Record<string, string>) => ({
  schemaVersion: 1,
  tool: 'codebuddy',
  sessionId: 'session-1',
  eventId: `event-${index}`,
  timestamp: time,
  cwd: '/workspace/project',
  model: null,
  tokens,
  prompt: 'PRIVATE_PROMPT',
  authorization: 'PRIVATE_TOKEN',
})
async function read(name: string, rows: unknown[], format = 'jsonl') {
  const file = path.join(dir, `${name}.${format}`)
  await writeFile(
    file,
    format === 'jsonl' ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(rows),
  )
  return readAgentSnapshot(file, { tool: 'codebuddy', path: file, format: 'telemetry' })
}

it('imports a real hook spool larger than a single 4096-record input batch without losing records', async () => {
  const result = await read(
    'large-spool',
    Array.from({ length: 5000 }, (_, i) => event(i)),
  )
  expect(result.events).toHaveLength(5000)
  expect(new Set(result.events.map((row) => row.eventId)).size).toBe(5000)
  expect(result.events.every((row) => Object.values(row.tokens).every((token) => token === null))).toBe(true)
  expect(result.warnings).toBe(0)
  expect(JSON.stringify(result.events)).not.toContain('PRIVATE_')
})

it.each(['jsonl', 'json'])(
  'merges cross-batch duplicate partial counters in %s while preserving first event time',
  async (format) => {
    const rows = [
      event(0, { input: '100', cached: '10' }),
      ...Array.from({ length: 4096 }, (_, i) => event(i + 1)),
      { ...event(0, { output: '20' }), timestamp: '2026-09-29T10:01:00Z' },
      event(0, { total: '120' }),
      event(0),
    ]
    const result = await read('partial-' + format, rows, format)
    expect(result.events).toHaveLength(4097)
    expect(result.events[0]).toMatchObject({
      timestamp: time,
      tokens: { input: '100', cached: '10', output: '20', reasoning: null, total: '120' },
    })
    expect(result.events[0].eventId).toBe((await read('single-' + format, [event(0)], format)).events[0].eventId)
  },
)

it.each([{ tokens: { input: '99' } }, { cwd: '/other/workspace' }, { model: 'different-model' }])(
  'rejects conflicting cross-batch replays rather than returning partial records: %j',
  async (override) => {
    const rows = [
      event(0, { input: '100' }),
      ...Array.from({ length: 4096 }, (_, i) => event(i + 1)),
      { ...event(0), ...override },
    ]
    await expect(read('conflict', rows)).rejects.toThrow('telemetry_replay_conflict')
  },
)

it('rejects inconsistent merged totals and nested record batches without hiding their failure', async () => {
  await expect(
    read('inconsistent', [event(0, { input: '100', total: '120' }), event(0, { output: '21' })]),
  ).rejects.toThrow('invalid_telemetry_tokens')
  await expect(read('nested', [[event(0)]])).rejects.toThrow('telemetry_batch_too_large')
})

it('enforces the overall unique-event bound after merging instead of the raw line count', async () => {
  await expect(
    read(
      'too-many',
      Array.from({ length: 50001 }, (_, i) => event(i)),
    ),
  ).rejects.toThrow('agent_event_limit')
  const repeated = await read('many-replays', Array(50001).fill(event(0)))
  expect(repeated.events).toHaveLength(1)
})

it('fails malformed completed telemetry lines but leaves an incomplete trailing write for the next snapshot', async () => {
  const file = path.join(dir, 'malformed.jsonl')
  const source = { tool: 'codebuddy', path: file, format: 'telemetry' as const }
  await writeFile(file, JSON.stringify(event(0)) + '\n{broken}\n' + JSON.stringify(event(1)) + '\n')
  await expect(readAgentSnapshot(file, source)).rejects.toThrow('invalid_telemetry_json')
  await writeFile(file, JSON.stringify(event(0)) + '\n{"unfinished":')
  expect((await readAgentSnapshot(file, source)).events).toHaveLength(1)
})
