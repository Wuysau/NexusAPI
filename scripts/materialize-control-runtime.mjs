import { cp, lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

async function boundedDirectory(path, message) {
  try {
    const target = await realpath(path)
    if (relative(path, target) !== '' || !(await lstat(path)).isDirectory()) throw new Error(message)
    return target
  } catch {
    throw new Error(message)
  }
}

/** Repair Next's absolute pg external-package alias using only traced runtime files. */
export async function materializeControlRuntime(workspace = process.cwd()) {
  const workspaceRoot = await realpath(resolve(workspace))
  const artifact = await boundedDirectory(
    join(workspaceRoot, '.next/standalone'),
    'Standalone artifact is not a bounded directory',
  )
  const aliases = join(artifact, '.next/node_modules')
  let entries
  try {
    await lstat(aliases)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error('Runtime alias directory could not be inspected')
  }
  await boundedDirectory(aliases, 'Runtime alias directory is not a bounded directory')
  entries = await readdir(aliases, { withFileTypes: true })
  for (const entry of entries) {
    // pg is the only external package needing this repair. Other links must
    // pass the artifact guard; never materialize arbitrary filesystem targets.
    if (!entry.isSymbolicLink() || !/^pg-[a-f0-9]{16}$/.test(entry.name)) continue
    const alias = join(aliases, entry.name)
    const artifactPg = await boundedDirectory(
      join(artifact, 'node_modules/pg'),
      'Artifact runtime package is not a bounded directory',
    )
    let originalTarget
    try {
      originalTarget = await realpath(alias)
    } catch {
      throw new Error('Unexpected pg runtime alias target')
    }
    // Linux traces can preserve a relative link that already resolves to the
    // traced package inside standalone. That portable link needs no repair.
    if (relative(artifactPg, originalTarget) === '') continue
    const installedPg = await boundedDirectory(
      join(workspaceRoot, 'node_modules/pg'),
      'Installed pg package is not a bounded directory',
    )
    if (relative(installedPg, originalTarget) !== '') throw new Error('Unexpected pg runtime alias target')
    // Unlink the generated alias itself, never its external target. The copy
    // source and destination are both checked inside this standalone artifact.
    await unlink(alias)
    await cp(artifactPg, alias, { recursive: true, dereference: false, force: false, errorOnExist: true })
  }
}
