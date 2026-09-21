import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import config from '../../next.config'

describe('Control Plane production artifact', () => {
  function fixture(run: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-control-start-'))
    try {
      run(directory)
    } finally {
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup path')
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it.each([undefined, 'development'])(
    'validates production before loading the listener when NODE_ENV=%s',
    (nodeEnv) => {
      fixture((directory) => {
        buildSync({
          entryPoints: ['src/lib/config.ts'],
          outfile: join(directory, 'control-config.cjs'),
          bundle: true,
          platform: 'node',
          format: 'cjs',
        })
        copyFileSync('scripts/start-control.cjs', join(directory, 'start-control.cjs'))
        writeFileSync(join(directory, 'server.js'), 'console.log("LISTENER_STARTED")')
        const env: Record<string, string | undefined> = {
          ...process.env,
          DATABASE_URL: '',
          UPSTREAM_ENCRYPTION_KEY: '',
          ADMIN_TOKEN: '',
          APP_BASE_URL: '',
        }
        if (nodeEnv === undefined) delete env.NODE_ENV
        else env.NODE_ENV = nodeEnv
        const result = spawnSync(process.execPath, [join(directory, 'start-control.cjs')], {
          // Intentionally violate Next's required NODE_ENV type to test native
          // Node startup without that variable.
          env: env as NodeJS.ProcessEnv,
          encoding: 'utf8',
          timeout: 5000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('missing required env in production')
        expect(result.stdout).not.toContain('LISTENER_STARTED')
      })
    },
  )

  it('uses the guarded standalone entry for npm start', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts.start).toBe(
      'node .next/standalone/start-control.cjs',
    )
  })

  it('copies emitted static assets into the runnable standalone artifact', () => {
    fixture((directory) => {
      for (const path of ['node_modules/next/dist/bin', 'src/lib', 'scripts'])
        mkdirSync(join(directory, path), { recursive: true })
      copyFileSync('src/lib/config.ts', join(directory, 'src/lib/config.ts'))
      copyFileSync('scripts/start-control.cjs', join(directory, 'scripts/start-control.cjs'))
      writeFileSync(
        join(directory, 'node_modules/next/dist/bin/next'),
        `
        const fs = require('node:fs');
        fs.mkdirSync('.next/standalone', { recursive: true });
        fs.mkdirSync('.next/static/chunks', { recursive: true });
        fs.writeFileSync('.next/static/chunks/fixture.js', 'static-build-fixture');
      `,
      )
      const result = spawnSync(process.execPath, [resolve('scripts/build-control.mjs')], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(directory, '.next/standalone/.next/static/chunks/fixture.js'), 'utf8')).toBe(
        'static-build-fixture',
      )
    })
  })
  it('emits standalone output and copies only files produced by the build', () => {
    expect(config.output).toBe('standalone')
    const docker = readFileSync('infra/Dockerfile', 'utf8')
    expect(docker).not.toContain('/app/public')
    expect(docker).not.toContain('/app/services/worker')
    expect(docker).toContain('USER nexus')
    expect(existsSync('public')).toBe(false)
  })
  it('excludes host dependencies, secrets and worktrees from Docker context', () => {
    const ignore = readFileSync('.dockerignore', 'utf8')
    for (const rule of ['node_modules', '.next', '.git', '.env*', '.claude', '.test-artifacts'])
      expect(ignore).toContain(rule)
  })
})
