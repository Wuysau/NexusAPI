import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Configuration-only fixture. Never starts services or reads real deployment secrets.
const fixture = {
  ...process.env,
  COMPOSE_ENV_FILES: '',
  COMPOSE_DISABLE_ENV_FILE: 'true',
  NEXT_PUBLIC_GATEWAY_BASE_URL: 'https://gateway.example.test/v1',
  APP_BASE_URL: 'https://console.example.test',
  SNAPSHOT_SIGNING_KEY: 'compose-fixture-routing-key-not-a-real-secret',
  ADMIN_TOKEN: 'compose-fixture-admin-token-not-a-real-secret',
  GATEWAY_INTERNAL_TOKEN: 'compose-fixture-control-token-not-a-real-secret',
  BUDGET_SERVICE_TOKEN: 'compose-fixture-budget-token-not-a-real-secret',
  DB_OWNER_PASSWORD: 'compose-fixture-owner-not-a-real-secret',
  KMS_PROVIDER: 'vault',
  VAULT_ADDR: 'https://vault.example.test:8200',
  SECRET_REGISTRY_ID: 'fixture',
  SECRET_VAULT_RESOURCES: 'transit/fixture',
  SECRET_ALLOWED_ORIGINS: 'https://api.example.com',
  GATEWAY_IDENTITY_DIR: './fixture/identity',
  VAULT_CA_PATH: './fixture/ca.pem',
  SECRET_REGISTRY_DIR: './fixture/registry',
  SECRET_REGISTRY_TRUST_PATH: './fixture/trust.json',
  SECRET_REGISTRY_STATE_DIR: './fixture/state',
}
for (const role of ['CONTROL', 'GATEWAY', 'WORKER', 'BUDGET']) {
  fixture[`DATABASE_URL_${role}`] = `postgresql://nexus_${role.toLowerCase()}:fixture@db/app_db`
}
delete fixture.NEXUS_BUILD_CONTEXT
const file = ['-f', 'infra/docker-compose.prod.yml']
for (const project of [null, 'infra', '.']) {
  const env = { ...fixture, ...(project === '.' ? { NEXUS_BUILD_CONTEXT: '.' } : {}) }
  const args = ['compose', ...(project ? ['--project-directory', project] : []), ...file, 'config', '--format', 'json']
  const result = spawnSync('docker', args, { env, encoding: 'utf8' })
  assert.equal(result.status, 0, 'Compose fixture config failed')
  const config = JSON.parse(result.stdout)
  for (const name of ['app', 'gateway', 'worker', 'budget']) {
    assert.equal(resolve(config.services[name].build.context), process.cwd())
    assert.equal(config.services[name].user, '1001:1001')
    assert.equal(config.services[name].read_only, true)
  }
  assert.equal(config.services.budget.ports, undefined)
  assert.equal(config.services.app.volumes, undefined)
  assert.equal(config.services.app.environment.VAULT_TOKEN_FILE, undefined)
  assert.equal(config.services.app.environment.UPSTREAM_ENCRYPTION_KEY, undefined)
  assert.equal(config.services.gateway.volumes.length, 5)
  console.log(`Compose context verified: ${project ?? 'default'}`)
}
for (const missing of ['KMS_PROVIDER', 'DATABASE_URL_BUDGET']) {
  const env = { ...fixture }
  delete env[missing]
  const result = spawnSync('docker', ['compose', ...file, 'config', '--quiet'], { env, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(missing))
  console.log(`Compose missing ${missing} rejected`)
}
