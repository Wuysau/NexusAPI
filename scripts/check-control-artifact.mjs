import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Match private roots in .dockerignore without excluding whole source, config,
// docs or dependency trees. Operator configuration belongs to runtime mounts.
const privateRoots = new Set([
  '.git',
  '.claude',
  '.codex',
  '.superpowers',
  '.test-artifacts',
  '.playwright-mcp',
  'nexus-architecture-harness',
  'evidence',
  'output',
])
const privateFiles = new Set([
  'agents.md',
  'claude.md',
  'docs/current-task.md',
  'docs/project-state.md',
  'nexus-observer.json',
  'config/nexus-observer.json',
])

function privatePath(path) {
  const normalized = path.split(sep).join('/').toLowerCase()
  const parts = normalized.split('/')
  return (
    privateRoots.has(parts[0]) ||
    privateFiles.has(normalized) ||
    normalized === 'docs/superpowers' ||
    normalized.startsWith('docs/superpowers/') ||
    /^config\/nexus-observer\.json\..*\.tmp$/.test(normalized) ||
    parts.some((part) => part.startsWith('.env'))
  )
}

function rejectPrivatePath(path) {
  if (privatePath(path)) throw new Error('Control Plane artifact contains private development or operator files')
}

/** Inspect paths and file metadata only; never read credential or fixture contents. */
export async function checkControlArtifact(directory = '.next/standalone') {
  let root
  try {
    root = await realpath(resolve(directory))
    if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory')
  } catch {
    throw new Error('Control Plane standalone directory is unavailable')
  }

  const visited = new Set()
  async function walk(current) {
    // In-root dependency links may share directories or form cycles.
    if (visited.has(current)) return
    visited.add(current)
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      throw new Error('Control Plane standalone paths could not be inspected')
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      rejectPrivatePath(relative(root, path))
      if (entry.isDirectory()) await walk(path)
      else if (entry.isSymbolicLink()) {
        let target
        let metadata
        try {
          target = await realpath(path)
          metadata = await lstat(target)
        } catch {
          throw new Error('Control Plane artifact contains an unresolved link')
        }
        const targetPath = relative(root, target)
        if (targetPath === '..' || targetPath.startsWith(`..${sep}`) || isAbsolute(targetPath))
          throw new Error('Control Plane artifact contains a link outside the standalone artifact')
        rejectPrivatePath(targetPath)
        if (metadata.isDirectory()) await walk(target)
      }
    }
  }
  await walk(root)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await checkControlArtifact(process.argv[2])
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Control Plane artifact inspection failed')
    process.exitCode = 1
  }
}
