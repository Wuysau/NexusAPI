import { describe, expect, it } from 'vitest'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import config from '../../next.config'

const script = resolve('scripts/check-control-artifact.mjs')
const scriptModule = pathToFileURL(script).href
const materializerModule = pathToFileURL(resolve('scripts/materialize-control-runtime.mjs')).href
const picomatch = createRequire(import.meta.url)('next/dist/compiled/picomatch')

const privatePaths = [
  '.git/config',
  '.claude/settings.local.json',
  '.codex/config.toml',
  '.superpowers/session.json',
  '.test-artifacts/vault-reference/tls/admin-secrets.json',
  '.playwright-mcp/browser.json',
  'nexus-architecture-harness/config.json',
  'evidence/fixture.json',
  'output/report.json',
  'docs/superpowers/plan.md',
  'docs/current-task.md',
  'docs/project-state.md',
  'AGENTS.md',
  'CLAUDE.md',
  'nexus-observer.json',
  'config/nexus-observer.json',
  'config/nexus-observer.json.123.tmp',
  '.env.local',
  'src/nested/.env.production',
  'node_modules/example/.env.fixture',
]

const runtimePaths = [
  'server.js',
  'control-config.cjs',
  'start-control.cjs',
  '.next/server/app/api/health/route.js',
  '.next/static/chunks/app.js',
  'node_modules/@next/env/dist/index.js',
  'node_modules/example/output.js',
  'src/lib/config.ts',
  'config/nexus-observer.example.json',
  'docs/operations/local-connector.md',
  'packages/contracts/config.schema.json',
]

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-artifact-isolation-'))
  try {
    await run(directory)
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
}

async function addFile(directory: string, path: string) {
  const destination = join(directory, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, 'PRIVATE_FIXTURE_CONTENT_MUST_NOT_BE_READ_OR_PRINTED')
}

async function pgAliasFixture(directory: string) {
  const artifact = join(directory, '.next/standalone')
  const installedPg = join(directory, 'node_modules/pg')
  const artifactPg = join(artifact, 'node_modules/pg')
  const alias = join(artifact, '.next/node_modules/pg-587764f78a6c7a9c')
  await mkdir(installedPg, { recursive: true })
  await mkdir(artifactPg, { recursive: true })
  await mkdir(dirname(alias), { recursive: true })
  await writeFile(join(installedPg, 'index.js'), "module.exports = { origin: 'EXTERNAL_SOURCE_MUST_NOT_COPY' }")
  await writeFile(join(artifactPg, 'index.js'), "module.exports = { origin: 'STANDALONE_RUNTIME' }")
  return { artifact, installedPg, artifactPg, alias }
}

describe('Control Plane artifact isolation', () => {
  it('excludes private traced paths while preserving runtime assets', () => {
    const excludes = config.outputFileTracingExcludes?.['/*'] ?? []
    const excluded = picomatch(
      excludes.map((pattern) => resolve(pattern).replaceAll('\\', '/')),
      { dot: true, contains: true },
    )
    for (const path of privatePaths) expect(excluded(resolve(path).replaceAll('\\', '/')), path).toBe(true)
    for (const path of runtimePaths) expect(excluded(resolve(path).replaceAll('\\', '/')), path).toBe(false)
  })

  it('accepts ordinary standalone assets without reading their contents', async () => {
    await fixture(async (directory) => {
      for (const path of runtimePaths) await addFile(directory, path)
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(directory)).resolves.toBeUndefined()
      const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8', timeout: 5000 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout + result.stderr).not.toContain('PRIVATE_FIXTURE_CONTENT')
    })
  })

  it.each(privatePaths)('rejects copied private path %s', async (path) => {
    await fixture(async (directory) => {
      await addFile(directory, path)
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(directory)).rejects.toThrow('private development or operator files')
    })
  })

  it('fails the command without exposing fixture contents', async () => {
    await fixture(async (directory) => {
      await addFile(directory, '.test-artifacts/vault-reference/tls/admin-secrets.json')
      const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8', timeout: 5000 })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('private development or operator files')
      expect(result.stdout + result.stderr).not.toContain('PRIVATE_FIXTURE_CONTENT')
    })
  })

  it.each([
    '.next/standalone/.test-artifacts/vault-reference/tls/admin-secrets.json',
    '.next/static/chunks/.env.fixture',
  ])('fails the build when copied output includes %s', async (privateOutput) => {
    await fixture(async (directory) => {
      for (const path of ['node_modules/next/dist/bin', 'src/lib', 'scripts'])
        await mkdir(join(directory, path), { recursive: true })
      await copyFile('src/lib/config.ts', join(directory, 'src/lib/config.ts'))
      await copyFile('scripts/start-control.cjs', join(directory, 'scripts/start-control.cjs'))
      await copyFile('LICENSE', join(directory, 'LICENSE'))
      await writeFile(
        join(directory, 'node_modules/next/dist/bin/next'),
        `
          const fs = require('node:fs');
          const path = require('node:path');
          fs.mkdirSync('.next/standalone', { recursive: true });
          fs.mkdirSync('.next/static/chunks', { recursive: true });
          const privateOutput = ${JSON.stringify(privateOutput)};
          fs.mkdirSync(path.dirname(privateOutput), { recursive: true });
          fs.writeFileSync(privateOutput, 'PRIVATE_FIXTURE_CONTENT_MUST_NOT_BE_READ_OR_PRINTED');
        `,
      )
      const result = spawnSync(process.execPath, [resolve('scripts/build-control.mjs')], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('private development or operator files')
      expect(result.stdout + result.stderr).not.toContain('PRIVATE_FIXTURE_CONTENT')
    })
  })

  it('rejects empty private directories and case variants', async () => {
    await fixture(async (directory) => {
      await mkdir(join(directory, '.test-artifacts'))
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(directory)).rejects.toThrow('private development or operator files')
    })
    await fixture(async (directory) => {
      await addFile(directory, 'config/.ENV.local')
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(directory)).rejects.toThrow('private development or operator files')
    })
  })

  it('allows internal dependency links and rejects links outside the artifact', async () => {
    await fixture(async (directory) => {
      await addFile(directory, 'packages/runtime/index.js')
      await mkdir(join(directory, 'node_modules'))
      await symlink(join(directory, 'packages/runtime'), join(directory, 'node_modules/runtime'), 'junction')
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(directory)).resolves.toBeUndefined()
      await fixture(async (externalDirectory) => {
        await symlink(externalDirectory, join(directory, 'node_modules/external'), 'junction')
        await expect(checkControlArtifact(directory)).rejects.toThrow('link outside the standalone artifact')
      })
    })
  })

  it('materializes a Windows-style pg alias from the traced in-artifact runtime package', async () => {
    await fixture(async (directory) => {
      const { artifact, installedPg, alias } = await pgAliasFixture(directory)
      await symlink(installedPg, alias, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await materializeControlRuntime(directory)
      expect((await lstat(alias)).isDirectory()).toBe(true)
      expect((await lstat(alias)).isSymbolicLink()).toBe(false)
      expect(await readFile(join(alias, 'index.js'), 'utf8')).toContain('STANDALONE_RUNTIME')
      const result = spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write(require(process.argv[1]).origin)', alias],
        {
          encoding: 'utf8',
          timeout: 5000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('STANDALONE_RUNTIME')
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(artifact)).resolves.toBeUndefined()
    })
  })

  it('rejects a pg alias pointing to an unexpected external directory without changing it', async () => {
    await fixture(async (directory) => {
      const { alias } = await pgAliasFixture(directory)
      const unexpected = join(directory, 'node_modules/unexpected')
      await mkdir(unexpected)
      await symlink(unexpected, alias, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await expect(materializeControlRuntime(directory)).rejects.toThrow('Unexpected pg runtime alias target')
      expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    })
  })

  it('preserves a pg alias that already resolves to the traced package inside standalone', async () => {
    await fixture(async (directory) => {
      const { artifact, artifactPg, alias } = await pgAliasFixture(directory)
      await symlink(artifactPg, alias, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await materializeControlRuntime(directory)
      expect((await lstat(alias)).isSymbolicLink()).toBe(true)
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(artifact)).resolves.toBeUndefined()
    })
  })

  it('rejects an escaping alias parent without modifying external links', async () => {
    await fixture(async (directory) => {
      const { artifact, installedPg, alias } = await pgAliasFixture(directory)
      await rmdir(dirname(alias))
      const externalAliases = join(directory, 'external-aliases')
      await mkdir(externalAliases)
      const externalAlias = join(externalAliases, 'pg-587764f78a6c7a9c')
      await symlink(installedPg, externalAlias, 'junction')
      await symlink(externalAliases, join(artifact, '.next/node_modules'), 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await expect(materializeControlRuntime(directory)).rejects.toThrow(
        'Runtime alias directory is not a bounded directory',
      )
      expect((await lstat(externalAlias)).isSymbolicLink()).toBe(true)
    })
  })

  it('rejects an escaping artifact package source without unlinking the original alias', async () => {
    await fixture(async (directory) => {
      const { installedPg, artifactPg, alias } = await pgAliasFixture(directory)
      await rm(join(artifactPg, 'index.js'))
      await rmdir(artifactPg)
      await symlink(installedPg, artifactPg, 'junction')
      await symlink(installedPg, alias, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await expect(materializeControlRuntime(directory)).rejects.toThrow(
        'Artifact runtime package is not a bounded directory',
      )
      expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    })
  })

  it('leaves unknown external runtime links for the artifact guard to reject', async () => {
    await fixture(async (directory) => {
      const { artifact, installedPg, alias } = await pgAliasFixture(directory)
      const unknown = join(dirname(alias), 'unexpected-587764f78a6c7a9c')
      await symlink(installedPg, unknown, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await materializeControlRuntime(directory)
      expect((await lstat(unknown)).isSymbolicLink()).toBe(true)
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(artifact)).rejects.toThrow('link outside the standalone artifact')
    })
  })

  it('leaves unresolved runtime links for the artifact guard to reject', async () => {
    await fixture(async (directory) => {
      const { artifact, alias } = await pgAliasFixture(directory)
      const unknown = join(dirname(alias), 'unexpected-587764f78a6c7a9c')
      await symlink(join(directory, 'missing'), unknown, 'junction')
      const { materializeControlRuntime } = await import(materializerModule)
      await materializeControlRuntime(directory)
      expect((await lstat(unknown)).isSymbolicLink()).toBe(true)
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(artifact)).rejects.toThrow('unresolved link')
    })
  })

  it('fails closed when the standalone directory is missing', async () => {
    await fixture(async (directory) => {
      const { checkControlArtifact } = await import(scriptModule)
      await expect(checkControlArtifact(join(directory, 'missing'))).rejects.toThrow(
        'standalone directory is unavailable',
      )
    })
  })
})
