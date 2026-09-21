import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve, basename } from 'node:path'

// Build inputs only. Evidence, generated output, docs and Task state are
// excluded so recording a receipt cannot change its own source identity.
function included(path) {
  if (/^\.env(?:\.|$)/.test(basename(path)) && basename(path) !== '.env.example') return false
  if (/^(?:src|services|packages|scripts|tests|infra|drizzle|\.github)\//.test(path)) return true
  return (
    !path.includes('/') &&
    (/\.(?:json|[cm]?js|[cm]?ts|ya?ml)$/.test(path) ||
      /^\.(?:dockerignore|gitignore|npmrc|nvmrc|prettierignore|prettierrc(?:\..+)?|env\.example)$/.test(path))
  )
}

export function captureSource(root = process.cwd()) {
  const git = (args) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    if (result.status !== 0) throw new Error('Cannot identify CI source tree')
    return result.stdout
  }
  const paths = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter((path) => path && included(path))
    .sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    let type, digest
    try {
      const absolute = resolve(root, path)
      const stat = lstatSync(absolute)
      type = stat.isSymbolicLink() ? 'symlink' : 'file'
      if (!stat.isSymbolicLink() && !stat.isFile()) throw new Error('Unsupported CI source input')
      digest = createHash('sha256')
        .update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute))
        .digest('hex')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      type = 'deleted'
      digest = null
    }
    hash.update(JSON.stringify([path, type, digest]) + '\n')
  }
  const dirty = git(['status', '--porcelain=v1', '--no-renames', '--untracked-files=all', '-z'])
    .split('\0')
    .some((line) => line && included(line.slice(3)))
  return { algorithm: 'sha256-source-tree-v1', sha256: hash.digest('hex'), file_count: paths.length, dirty }
}
