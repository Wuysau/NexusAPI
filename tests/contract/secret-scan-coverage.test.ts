import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scanner = resolve('scripts/secrets-scan.mjs')
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function scan(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-secret-scan-'))
  temporary.push(root)
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, value)
  }
  return spawnSync(process.execPath, [scanner], { cwd: root, encoding: 'utf8' })
}

describe('public source secret scan', () => {
  it('covers Go, dotted test files, workflows, migrations and launch scripts without printing secrets', () => {
    const value = 'sk-' + 'A9b7C2d4'.repeat(7)
    const files = ['gateway.go', 'source.test.ts', '.github/workflows/ci.yml', 'drizzle/0001.sql', 'launch.ps1']
    const result = scan(Object.fromEntries(files.map((file) => [file, value])))
    expect(result.status).toBe(1)
    for (const file of files) expect(result.stderr.replaceAll('\\', '/')).toContain(file)
    expect(result.stderr).not.toContain(value)
    expect(result.stderr).not.toContain(value.slice(0, 12))
  })
  it('checks later matches after a clearly marked placeholder', () => {
    const opaque = 'sk-' + 'B7c3D9e1'.repeat(7)
    const result = scan({ 'source.ts': 'sk-placeholder-' + 'x'.repeat(50) + '\n' + opaque })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('source.ts')
  })
  it('allows explicit synthetic values only in test files', () => {
    const fixture = "const token = 'synthetic-test-token-0123456789'"
    expect(scan({ 'source.test.ts': fixture }).status).toBe(0)
    expect(scan({ 'source.ts': fixture }).status).toBe(1)
  })
})
