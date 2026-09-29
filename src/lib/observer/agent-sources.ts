import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { AGENT_TOOL_ID } from './agent-tools'
import type { AgentSource } from './agent-types'

export function validateAgentSource(value: unknown): AgentSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_agent_source')
  const s = value as Record<string, unknown>
  if (
    Object.keys(s).some((k) => !['tool', 'path', 'format', 'workspace'].includes(k)) ||
    typeof s.tool !== 'string' ||
    !AGENT_TOOL_ID.test(s.tool) ||
    typeof s.path !== 'string' ||
    s.path.length > 4096 ||
    /[\x00-\x1f]/.test(s.path) ||
    !path.isAbsolute(s.path) ||
    !['native', 'telemetry'].includes(String(s.format)) ||
    (s.workspace !== undefined &&
      (typeof s.workspace !== 'string' ||
        !path.isAbsolute(s.workspace) ||
        /[\x00-\x1f]/.test(s.workspace) ||
        s.workspace.length > 4096))
  )
    throw new Error('invalid_agent_source')
  if (
    s.format === 'native' &&
    !['gemini_cli', 'qwen_code', 'opencode', 'cline', 'roo_code', 'kilo_code', 'github_copilot', 'kimi_cli'].includes(
      s.tool,
    )
  )
    throw new Error('native_adapter_unavailable')
  return {
    tool: s.tool,
    path: s.path,
    format: s.format as AgentSource['format'],
    ...(s.workspace ? { workspace: s.workspace as string } : {}),
  }
}
export async function sourceExists(file: string) {
  try {
    const st = await lstat(file)
    return !st.isSymbolicLink() && (st.isDirectory() || st.isFile())
  } catch {
    return false
  }
}
export async function discoverAgentSources(
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<AgentSource[]> {
  const candidates: AgentSource[] = [
    { tool: 'gemini_cli', path: path.join(home, '.gemini', 'tmp'), format: 'native' },
    { tool: 'qwen_code', path: path.join(home, '.qwen', 'projects'), format: 'native' },
    { tool: 'github_copilot', path: path.join(home, '.copilot', 'session-state'), format: 'native' },
    { tool: 'kimi_cli', path: path.join(home, '.kimi', 'sessions'), format: 'native' },
  ]
  const userData = env.APPDATA || path.join(home, '.config')
  for (const app of ['Code', 'Code - Insiders', 'Cursor', 'Windsurf']) {
    for (const [tool, extension] of [
      ['cline', 'saoudrizwan.claude-dev'],
      ['roo_code', 'rooveterinaryinc.roo-cline'],
      ['kilo_code', 'kilocode.kilo-code'],
    ])
      candidates.push({
        tool,
        path: path.join(userData, app, 'User', 'globalStorage', extension, 'tasks'),
        format: 'native',
      })
  }
  const spool = path.join(home, '.nexusapi', 'usage')
  if (await sourceExists(spool))
    for (const entry of await readdir(spool, { withFileTypes: true })) {
      const tool = entry.name.replace(/\.jsonl$/, '')
      if (entry.isFile() && entry.name.endsWith('.jsonl') && AGENT_TOOL_ID.test(tool))
        candidates.push({ tool, path: path.join(spool, entry.name), format: 'telemetry' })
    }
  const found = []
  for (const candidate of candidates) if (await sourceExists(candidate.path)) found.push(candidate)
  return found
}
export function matchesAgentFile(source: AgentSource, file: string) {
  const name = path.basename(file)
  if (source.format === 'telemetry') return /\.(json|jsonl)$/.test(name)
  if (source.tool === 'gemini_cli' || source.tool === 'qwen_code')
    return /\.(json|jsonl)$/.test(name) && (file.replace(/\\/g, '/').includes('/chats/') || /^session-/.test(name))
  if (['cline', 'roo_code', 'kilo_code'].includes(source.tool)) return name === 'ui_messages.json'
  if (source.tool === 'github_copilot') return name === 'events.jsonl'
  if (source.tool === 'kimi_cli') return name === 'wire.jsonl'
  return source.tool === 'opencode' && name.endsWith('.json')
}
export async function agentSourceFiles(source: AgentSource) {
  const files: string[] = []
  let visited = 0
  const walk = async (file: string, depth: number): Promise<void> => {
    if (depth > 12 || ++visited > 20000) throw new Error('agent_source_limit')
    const st = await lstat(file)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const entry of await readdir(file, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['node_modules', '.git', 'tool-results', 'checkpoints'].includes(entry.name))
          continue
        await walk(path.join(file, entry.name), depth + 1)
      }
    } else if (st.isFile() && matchesAgentFile(source, file)) files.push(await realpath(file))
  }
  await walk(source.path, 0)
  return files.sort()
}
