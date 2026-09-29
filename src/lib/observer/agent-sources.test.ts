import { afterAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { agentSourceFiles, discoverAgentSources, validateAgentSource } from './agent-sources'
import { isUsageSource, agentSourceLabel } from './agent-tools'
const home = await mkdtemp(path.join(tmpdir(), 'nexus-agents-'))
afterAll(() => rm(home, { recursive: true, force: true }))
it('discovers newly installed native paths and arbitrary metadata tools without reading credentials', async () => {
  expect(await discoverAgentSources(home, {})).toEqual([])
  const projects = path.join(home, '.qwen', 'projects')
  await mkdir(projects, { recursive: true })
  await writeFile(path.join(home, '.qwen', 'credentials.json'), 'PRIVATE_SECRET')
  const spool = path.join(home, '.nexusapi', 'usage')
  await mkdir(spool, { recursive: true })
  await writeFile(path.join(spool, 'future_agent.jsonl'), '{}\n')
  const found = await discoverAgentSources(home, {})
  expect(found.map((x) => x.tool)).toEqual(['qwen_code', 'future_agent'])
  expect(found.some((x) => x.path.endsWith('credentials.json'))).toBe(false)
})
it('accepts future tools for telemetry and rejects unavailable native parsers or relative paths', () => {
  expect(validateAgentSource({ tool: 'future_agent', path: home, format: 'telemetry' }).tool).toBe('future_agent')
  expect(() => validateAgentSource({ tool: 'future_agent', path: home, format: 'native' })).toThrow(
    'native_adapter_unavailable',
  )
  expect(() => validateAgentSource({ tool: 'cursor', path: '../../secrets', format: 'telemetry' })).toThrow()
  expect(isUsageSource('agent:future_agent')).toBe(true)
  expect(isUsageSource('agent:../../evil')).toBe(false)
  expect(agentSourceLabel('agent:future_agent')).toBe('future_agent')
})
it('selects native telemetry filenames and ignores unrelated JSON files', async () => {
  const task = path.join(home, 'task', 'abc')
  await mkdir(task, { recursive: true })
  await writeFile(path.join(task, 'ui_messages.json'), '[]')
  await writeFile(path.join(task, 'api_configuration.json'), '{"secret":"private"}')
  const files = await agentSourceFiles({ tool: 'cline', path: path.dirname(task), format: 'native' })
  expect(files.map((x) => path.basename(x))).toEqual(['ui_messages.json'])
})
it('discovers Pi and Qoder without opening sibling config/credentials and honors a Pi override', async () => {
  const root = await mkdtemp(path.join(home, 'more-tools-'))
  const pi = path.join(root, 'pi-profile', 'sessions')
  const qoder = path.join(root, '.qoder', 'projects', 'project', 'transcript')
  await mkdir(pi, { recursive: true })
  await mkdir(qoder, { recursive: true })
  await writeFile(path.join(pi, 'session.jsonl'), '{}\n')
  await writeFile(path.join(qoder, 'session.jsonl'), '{}\n')
  await writeFile(path.join(root, '.qoder', 'projects', 'credentials.jsonl'), 'PRIVATE')
  const found = await discoverAgentSources(root, { PI_CODING_AGENT_DIR: path.dirname(pi) })
  expect(found.map((source) => source.tool).sort()).toEqual(['pi', 'qoder'])
  expect(await agentSourceFiles(found.find((source) => source.tool === 'qoder')!)).toEqual([
    path.join(qoder, 'session.jsonl'),
  ])
  expect(validateAgentSource(found.find((source) => source.tool === 'pi'))).toMatchObject({ tool: 'pi' })
})
it('discovers supported extensions in macOS Application Support', async () => {
  const root = await mkdtemp(path.join(home, 'mac-tools-'))
  const tasks = path.join(
    root,
    'Library',
    'Application Support',
    'Code',
    'User',
    'globalStorage',
    'saoudrizwan.claude-dev',
    'tasks',
  )
  await mkdir(tasks, { recursive: true })
  expect((await discoverAgentSources(root, {}, 'darwin')).map((source) => source.tool)).toEqual(['cline'])
})
