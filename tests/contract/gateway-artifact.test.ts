import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Gateway deployment artifact', () => {
  it('builds a standalone nonroot production binary from source', () => {
    const docker = readFileSync('services/gateway/Dockerfile', 'utf8')
    expect(docker).toContain('FROM golang:1.27-alpine AS builder')
    expect(docker).toContain('CGO_ENABLED=0')
    expect(docker).toContain('GATEWAY_ENV=production')
    expect(docker).toContain('USER 1001:1001')
    expect(docker).toContain('/readyz')
    expect(docker).toContain('.checks.database == true and .checks.redis == true')
    expect(docker).toContain('COPY --from=builder')
    expect(docker).not.toContain('ALLOW_LOCAL_KMS_IN_PRODUCTION')
  })
  it('fails formatting gate for unformatted Go and passes once corrected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-format-'))
    const script = resolve('scripts/check-go-format.mjs')
    try {
      writeFileSync(join(dir, 'fixture.go'), 'package fixture\nfunc answer()int{return 42}\n')
      const bad = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
      expect(bad.status, bad.stderr).toBe(1)
      expect(bad.stdout).toContain('fixture.go')
      writeFileSync(join(dir, 'fixture.go'), 'package fixture\n\nfunc answer() int { return 42 }\n')
      const good = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
      expect(good.status, good.stderr).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
