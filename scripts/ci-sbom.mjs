import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const args = ['sbom', '--sbom-format=cyclonedx', '--package-lock-only']
const result =
  process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npm sbom --sbom-format=cyclonedx --package-lock-only'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )
    : spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (result.status !== 0) throw new Error('Required npm SBOM generation failed')
const bom = JSON.parse(result.stdout)
if (bom.bomFormat !== 'CycloneDX' || !bom.components?.length) throw new Error('Empty or invalid SBOM')
mkdirSync('.test-artifacts/ci', { recursive: true })
writeFileSync('.test-artifacts/ci/cyclonedx.json', JSON.stringify(bom, null, 2) + '\n')
console.log(`CycloneDX SBOM: ${bom.components.length} components from lockfile`)
