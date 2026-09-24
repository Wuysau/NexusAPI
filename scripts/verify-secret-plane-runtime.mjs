// Required fixture gateway check: setup/enrollment/test errors fail, never skip.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const fixture = resolve('.test-artifacts/vault-reference')
let stage = 'Vault identity fixture'
try {
  for (const [name, script] of [
    ['Vault identity fixture', 'scripts/verify-secret-plane.mjs'],
    ['credential enrollment fixture', 'scripts/verify-secret-plane-enrollment.mjs'],
    ['legacy migration fixture', 'scripts/verify-legacy-secret-migration.mjs'],
  ]) {
    stage = name
    execFileSync(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  }
  stage = 'Gateway isolation tests'
  const output = execFileSync(
    'go',
    ['test', '-json', '-tags=vaultintegration', '-run', '^TestVaultRealIdentity$', '-count=1'],
    {
      cwd: resolve('services/gateway'),
      env: { ...process.env, NEXUS_SECRET_FIXTURE_DIR: fixture },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const events = output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  const passed = events.filter((e) => e.Action === 'pass' && e.Test).map((e) => e.Test)
  const requiredTests = [
    'TestVaultRealIdentity',
    ...[
      'actual_vault_canary_approved_tls_dispatch',
      'tampered_origin_exfiltration_sink_denied',
      'credential_redirect_exfiltration_sink_denied',
      'captured_boundary_logs_have_no_canary',
      'legacy_migration_canary_restored_via_real_vault',
    ].map((name) => `TestVaultRealIdentity/${name}`),
  ]
  if (requiredTests.some((name) => !passed.includes(name)) || events.some((e) => ['fail', 'skip'].includes(e.Action)))
    throw new Error('Missing required real Gateway verification')
  stage = 'receipt assembly'
  const identity = JSON.parse(await readFile(resolve(fixture, 'approle-tls-receipt.json'), 'utf8'))
  const enrollment = JSON.parse(await readFile(resolve(fixture, 'enrollment-receipt.json'), 'utf8'))
  const migration = JSON.parse(await readFile(resolve(fixture, 'legacy-migration-receipt.json'), 'utf8'))
  const receipt = {
    format: 'nexus.secret-plane.runtime.fixture.v1',
    recordedAt: new Date().toISOString(),
    identityChecks: identity.checksPassed,
    enrollmentChecks: enrollment.checksPassed,
    migrationChecks: migration.checksPassed,
    gatewayTestsPassed: passed,
    skipped: 0,
    limitations: [
      ...identity.limitations.filter((item) => !item.startsWith('No browser/provider canary')),
      'Provider dispatch/exfiltration canary uses test-only local DNS/TLS trust injection; production transport has no private-IP bypass. Browser capture and deployment timing/HA remain separate checks.',
    ],
  }
  await writeFile(resolve(fixture, 'runtime-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  const ci = resolve('.test-artifacts/ci')
  await mkdir(ci, { recursive: true })
  for (const [name, value] of [
    ['secret-plane-runtime', receipt],
    ['secret-plane-identity', identity],
    ['secret-plane-enrollment', enrollment],
    ['legacy-secret-migration', migration],
  ])
    await writeFile(resolve(ci, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  const total = identity.checksPassed + enrollment.checksPassed + migration.checksPassed + passed.length
  console.log(`${total}/${total} secret-plane checks passed`)
} catch {
  console.error(
    `Required real Secret Plane runtime verification failed in ${stage}; sensitive process output suppressed`,
  )
  process.exitCode = 1
}
