import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const syncScript = path.join(projectRoot, 'scripts/git-auto-sync.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-git-auto-sync-'))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  const mainWorktree = path.join(root, 'main-worktree')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Nexus Test')
  git(repo, 'config', 'user.email', 'nexus-test@example.invalid')
  writeFileSync(path.join(repo, 'README.md'), 'initial\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-m', 'initial')
  git(root, 'init', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', 'origin', 'main')
  git(repo, 'switch', '-c', 'feature')
  git(repo, 'worktree', 'add', mainWorktree, 'main')
  return { root, repo, remote, mainWorktree }
}

function cleanup(root) {
  const resolved = path.resolve(root)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.match(path.basename(resolved), /^nexus-git-auto-sync-/)
  rmSync(resolved, { recursive: true, force: true })
}

test('merges a feature commit into main and pushes the merge commit', () => {
  const { root, repo, remote, mainWorktree } = fixture()
  try {
    writeFileSync(path.join(repo, 'feature.txt'), 'change\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-m', 'feature')
    const featureHead = git(repo, 'rev-parse', 'HEAD')

    const result = spawnSync(process.execPath, [syncScript], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const parents = git(mainWorktree, 'rev-list', '--parents', '-n', '1', 'main').split(' ')
    assert.equal(parents.length, 3)
    assert.equal(parents[2], featureHead)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), parents[0])
    assert.equal(git(repo, 'rev-parse', 'HEAD'), featureHead)
  } finally {
    cleanup(root)
  }
})

test('does not move main when origin is absent', () => {
  const { root, repo, mainWorktree } = fixture()
  try {
    git(repo, 'remote', 'remove', 'origin')
    writeFileSync(path.join(repo, 'feature.txt'), 'change\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-m', 'feature')
    const originalMain = git(mainWorktree, 'rev-parse', 'main')

    const result = spawnSync(process.execPath, [syncScript], { cwd: repo, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /origin/i)
    assert.equal(git(mainWorktree, 'rev-parse', 'main'), originalMain)
  } finally {
    cleanup(root)
  }
})

test('does not overwrite uncommitted changes in the main worktree', () => {
  const { root, repo, remote, mainWorktree } = fixture()
  try {
    writeFileSync(path.join(mainWorktree, 'README.md'), 'local change\n')
    writeFileSync(path.join(repo, 'feature.txt'), 'change\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-m', 'feature')
    const originalMain = git(mainWorktree, 'rev-parse', 'main')

    const result = spawnSync(process.execPath, [syncScript], { cwd: repo, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /clean|dirty|uncommitted/i)
    assert.equal(git(mainWorktree, 'rev-parse', 'main'), originalMain)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), originalMain)
  } finally {
    cleanup(root)
  }
})

test('post-commit hook merges and pushes without recursing on the merge commit', () => {
  const { root, repo, remote, mainWorktree } = fixture()
  try {
    const hooksDir = path.join(repo, '.githooks')
    const scriptsDir = path.join(repo, 'scripts')
    mkdirSync(hooksDir)
    mkdirSync(scriptsDir)
    cpSync(path.join(projectRoot, '.githooks', 'post-commit'), path.join(hooksDir, 'post-commit'))
    cpSync(syncScript, path.join(scriptsDir, 'git-auto-sync.mjs'))
    cpSync(path.join(projectRoot, 'scripts', 'install-git-hooks.mjs'), path.join(scriptsDir, 'install-git-hooks.mjs'))
    const install = spawnSync(process.execPath, [path.join(scriptsDir, 'install-git-hooks.mjs')], {
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(install.status, 0, install.stderr)
    assert.equal(git(repo, 'config', '--local', '--get', 'core.hooksPath'), hooksDir)
    writeFileSync(path.join(repo, 'feature.txt'), 'change\n')
    git(repo, 'add', 'feature.txt')

    const commit = spawnSync('git', ['commit', '-m', 'feature'], { cwd: repo, encoding: 'utf8' })
    assert.equal(commit.status, 0, commit.stderr)

    const featureHead = git(repo, 'rev-parse', 'HEAD')
    const parents = git(mainWorktree, 'rev-list', '--parents', '-n', '1', 'main').split(' ')
    assert.equal(parents.length, 3, `${commit.stdout}\n${commit.stderr}`)
    assert.equal(parents[2], featureHead)
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), parents[0])
  } finally {
    cleanup(root)
  }
})
