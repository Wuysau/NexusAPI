import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const remote = 'origin'
const targetBranch = 'main'
const childEnv = { ...process.env, NEXUS_AUTO_SYNC_RUNNING: '1' }
for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split(/\r?\n/)) {
  if (name) delete childEnv[name]
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitResult(cwd, ...args) {
  return spawnSync('git', args, { cwd, env: childEnv, encoding: 'utf8' })
}

function worktreeForBranch(cwd, branch) {
  const entries = git(cwd, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/)
  for (const entry of entries) {
    const lines = entry.split(/\r?\n/)
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    }
  }
  return null
}

function assertClean(cwd) {
  const changes = git(cwd, 'status', '--porcelain', '--untracked-files=normal')
  if (changes) {
    throw new Error(`main worktree has uncommitted changes: ${cwd} (${changes})`)
  }
}

function isAncestor(cwd, ancestor, descendant) {
  return gitResult(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).status === 0
}

function run() {
  if (process.env.NEXUS_AUTO_SYNC_RUNNING === '1') return

  const sourcePath = process.cwd()
  const commonDir = path.resolve(sourcePath, git(sourcePath, 'rev-parse', '--git-common-dir'))
  const lockPath = path.join(commonDir, 'nexus-auto-sync.lock')
  let lock
  let temporaryRoot
  let temporaryWorktree
  try {
    lock = openSync(lockPath, 'wx')
    const sourceBranch = git(sourcePath, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    const sourceHead = git(sourcePath, 'rev-parse', 'HEAD')
    if (!gitResult(sourcePath, 'remote', 'get-url', remote).stdout?.trim()) {
      throw new Error(`Git remote "${remote}" is not configured; main was not changed or pushed`)
    }
    git(sourcePath, 'show-ref', '--verify', `refs/heads/${targetBranch}`)

    let mainPath = worktreeForBranch(sourcePath, targetBranch)
    if (!mainPath) {
      temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nexus-main-sync-'))
      temporaryWorktree = path.join(temporaryRoot, 'main')
      git(sourcePath, 'worktree', 'add', temporaryWorktree, targetBranch)
      mainPath = temporaryWorktree
    }
    assertClean(mainPath)

    const remoteMain = git(sourcePath, 'ls-remote', '--heads', remote, targetBranch)
    if (remoteMain) {
      git(sourcePath, 'fetch', remote, `refs/heads/${targetBranch}:refs/remotes/${remote}/${targetBranch}`)
      const remoteRef = `refs/remotes/${remote}/${targetBranch}`
      if (!isAncestor(sourcePath, remoteRef, targetBranch)) {
        if (!isAncestor(sourcePath, targetBranch, remoteRef)) {
          throw new Error('Local and remote main have diverged; resolve the divergence manually')
        }
        git(mainPath, 'merge', '--ff-only', remoteRef)
      }
    }

    if (sourceBranch !== targetBranch && !isAncestor(sourcePath, sourceHead, targetBranch)) {
      const merge = gitResult(mainPath, 'merge', '--no-ff', '--no-edit', sourceHead)
      if (merge.status !== 0) {
        gitResult(mainPath, 'merge', '--abort')
        throw new Error(`Could not merge ${sourceBranch} into main: ${(merge.stderr || merge.stdout).trim()}`)
      }
    }

    git(mainPath, 'push', remote, `${targetBranch}:${targetBranch}`)
    process.stdout.write(`Nexus auto-sync: ${sourceBranch} -> ${targetBranch} -> ${remote}/${targetBranch}\n`)
  } finally {
    if (temporaryWorktree) {
      const remove = gitResult(sourcePath, 'worktree', 'remove', temporaryWorktree)
      if (remove.status !== 0) {
        process.stderr.write(`Nexus auto-sync: temporary worktree retained at ${temporaryWorktree}\n`)
      } else if (temporaryRoot && path.dirname(temporaryRoot) === path.resolve(os.tmpdir())) {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    }
    if (lock !== undefined) {
      closeSync(lock)
      rmSync(lockPath, { force: true })
    }
  }
}

try {
  run()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Nexus auto-sync: ${message}\n`)
  process.exitCode = 1
}
