import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const modulePath = '../../scripts/ci-gate.mjs'
const { captureSource } = await import(modulePath)
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'nexus-ci-source-'))
  temporary.push(path)
  execFileSync('git', ['init', '--quiet', path])
  mkdirSync(join(path, 'src'))
  writeFileSync(join(path, 'src/app.ts'), 'export const value = 1\n')
  writeFileSync(join(path, '.gitignore'), '.test-artifacts/\n.env.local\n')
  execFileSync('git', ['add', '.'], { cwd: path })
  return path
}
describe('CI source identity', () => {
  it('binds modified and untracked product sources without requiring a commit', () => {
    const root = fixture()
    const before = captureSource(root)
    expect(before.algorithm).toBe('sha256-source-tree-v1')
    expect(before.dirty).toBe(true)
    writeFileSync(join(root, 'src/app.ts'), 'export const value = 2\n')
    const changed = captureSource(root)
    expect(changed.sha256).not.toBe(before.sha256)
    writeFileSync(join(root, 'src/new.ts'), 'export const added = 1\n')
    expect(captureSource(root).sha256).not.toBe(changed.sha256)
  })
  it('excludes receipts, task status and private files from the build fingerprint', () => {
    const root = fixture()
    const before = captureSource(root)
    for (const path of ['evidence', '.test-artifacts', 'docs', 'local-notes/tasks'])
      mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, 'evidence/gate.json'), '{"passed":true}')
    writeFileSync(join(root, '.test-artifacts/private-key'), 'fixture-only')
    writeFileSync(join(root, '.env.local'), 'DO_NOT_READ=fixture-only')
    writeFileSync(join(root, 'docs/current-task.md'), 'status')
    writeFileSync(join(root, 'local-notes/tasks/TASK.md'), 'status')
    expect(captureSource(root)).toEqual(before)
    mkdirSync(join(root, 'packages/contracts/schemas'), { recursive: true })
    writeFileSync(join(root, 'packages/contracts/schemas/event.json'), '{}')
    expect(captureSource(root).sha256).not.toBe(before.sha256)
  })
})
