import path from 'node:path'
export interface WorkspaceRoot {
  root: string
  projectId: string
  projectName: string
}
/** Lexical only: never follow filesystem links supplied in external telemetry. */
export function normalizeWorkspace(value: string): string {
  if (!value || /[\x00-\x1f]/.test(value) || value.length > 4096) throw new Error('Invalid workspace root')
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return path.win32.normalize(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  }
  if (!value.startsWith('/') || value.startsWith('//')) throw new Error('Workspace root must be absolute')
  return path.posix.normalize(value).replace(/\/$/, '') || '/'
}
export function matchWorkspace(cwd: string | null, roots: WorkspaceRoot[]): WorkspaceRoot | null {
  const normalized = new Map<string, WorkspaceRoot>()
  for (const root of roots) {
    const key = normalizeWorkspace(root.root)
    if (normalized.has(key) && normalized.get(key)!.projectId !== root.projectId)
      throw new Error('Ambiguous workspace root')
    normalized.set(key, { ...root, root: key })
  }
  let target: string
  try {
    target = normalizeWorkspace(cwd ?? '')
  } catch {
    return null
  }
  return (
    [...normalized.entries()]
      .filter(([root]) => target === root || target.startsWith(root === '/' ? '/' : root + '/'))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? null
  )
}
