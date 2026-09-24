import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface AgentConfig {
  tenantId: string
  organizationId: string
  profiles: { profileRef: string; connectionId: string; home: string }[]
  workspaces: { projectId: string; cwd: string }[]
}
export class TaskRuntimeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code)
  }
}
const fail = (): never => {
  throw new TaskRuntimeError('invalid_local_agent_configuration')
}
const absolute = (s: string) => path.isAbsolute(s) || path.win32.isAbsolute(s)
export const workspaceKey = (s: string) => {
  const normalized = s.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}
function object(v: unknown, keys: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k))) fail()
  return v as Record<string, unknown>
}
function id(v: unknown): string {
  return typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v) ? v : fail()
}
function directory(v: unknown): string {
  return typeof v === 'string' && absolute(v) && !v.includes('\0') && !v.split(/[\\/]/).includes('..') ? v : fail()
}
export function validateAgentConfig(raw: unknown): AgentConfig {
  const c = object(raw, ['tenantId', 'organizationId', 'profiles', 'workspaces'])
  if (!Array.isArray(c.profiles) || !Array.isArray(c.workspaces) || c.profiles.length > 50 || c.workspaces.length > 50)
    fail()
  const profiles = (c.profiles as unknown[]).map((v) => {
    const p = object(v, ['profileRef', 'connectionId', 'home'])
    return { profileRef: id(p.profileRef), connectionId: id(p.connectionId), home: directory(p.home) }
  })
  const workspaces = (c.workspaces as unknown[]).map((v) => {
    const w = object(v, ['projectId', 'cwd'])
    return { projectId: id(w.projectId), cwd: directory(w.cwd) }
  })
  for (const key of ['profileRef', 'connectionId', 'home'] as const) {
    if (new Set(profiles.map((p) => (key === 'home' ? workspaceKey(p.home) : p[key]))).size !== profiles.length) fail()
  }
  if (new Set(workspaces.map((w) => workspaceKey(w.cwd))).size !== workspaces.length) fail()
  return { tenantId: id(c.tenantId), organizationId: id(c.organizationId), profiles, workspaces }
}
export function matchLocalWorkspace(config: AgentConfig, projectId: string, cwd: string) {
  return config.workspaces.find((w) => w.projectId === projectId && workspaceKey(w.cwd) === workspaceKey(cwd))
}
export async function readAgentConfig(file = process.env.NEXUS_SUPERVISOR_CONFIG): Promise<AgentConfig | null> {
  if (!file) return null
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail()
  const config = validateAgentConfig(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')))
  const homes = new Set<string>()
  for (const profile of config.profiles) {
    profile.home = await realpath(profile.home)
    const canonical = workspaceKey(profile.home)
    if (homes.has(canonical)) fail()
    homes.add(canonical)
  }
  for (const workspace of config.workspaces) workspace.cwd = await realpath(workspace.cwd)
  return config
}
