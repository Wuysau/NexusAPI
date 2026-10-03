import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const yamlModule = 'js-yaml'
const { default: yaml } = await import(yamlModule)

const configModule = '../../vitest.config.mjs'
const { default: config } = await import(configModule)
const fixtureModule = '../../scripts/fixture-database.mjs'
const { connectorTestDatabaseURL, healthRecoveryDatabaseURL, assertFixtureDatabase } = await import(fixtureModule)
const projectFixtureModule = '../../scripts/prepare-project-gateway-fixture.mjs'
const { prepareProjectGatewayFixture } = await import(projectFixtureModule)

it('runs the connector suite in a dedicated project with the configured database before importing routes', () => {
  const projects = config.test.projects
  const shared = projects.find((project: { test: { name: string } }) => project.test.name === 'shared')
  const connector = projects.find((project: { test: { name: string } }) => project.test.name === 'connector')
  expect(shared.extends).toBe(false)
  expect(connector.extends).toBe(false)
  expect(shared.test.exclude).toContain('tests/integration/local-connector.test.ts')
  expect(connector.test.include).toEqual(['tests/integration/local-connector.test.ts'])
  expect(connector.test.env.DATABASE_URL).toBe(
    process.env.CONNECTOR_TEST_DATABASE_URL || process.env.DATABASE_URL || '',
  )
  expect(config.test.fileParallelism).toBe(false)
  const workflow = yaml.load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: {
      verification: {
        env: { DATABASE_URL: string; CONNECTOR_TEST_DATABASE_URL: string; GATEWAY_HEALTH_RECOVERY_DATABASE_URL: string }
      }
    }
  }
  const env = workflow.jobs.verification.env
  const connectorURL = connectorTestDatabaseURL(env.CONNECTOR_TEST_DATABASE_URL)
  expect(connectorURL.pathname).not.toBe(new URL(env.DATABASE_URL).pathname)
  expect(healthRecoveryDatabaseURL(env.GATEWAY_HEALTH_RECOVERY_DATABASE_URL).pathname).toBe(
    '/gateway_test_health_recovery_round57',
  )
  expect(readFileSync('scripts/ci-fixtures.mjs', 'utf8')).toContain('CONNECTOR_TEST_DATABASE_URL')
})

it('refuses nonlocal, ambiguous and ordinary database targets before any connector reset', () => {
  for (const url of [
    '',
    'https://127.0.0.1/connector_test_ci15',
    'postgresql://db.example.invalid/connector_test_ci15',
    'postgresql://127.0.0.1/convergence_ci15',
    'postgresql://127.0.0.1/customer_connector_test',
    'postgresql://127.0.0.1/connector_test_ci15?database=ordinary',
    'postgresql://127.0.0.1/connector_test_ci15#ordinary',
    'postgresql://127.0.0.1/connector_test_ci15?',
    'postgresql://127.0.0.1/connector_test_ci15#',
  ])
    expect(() => connectorTestDatabaseURL(url)).toThrow('Dedicated local connector_test database required')
  expect(connectorTestDatabaseURL('postgresql://127.0.0.1:55439/connector_test_ci15').pathname).toBe(
    '/connector_test_ci15',
  )
})

it('restricts external-process health recovery to its exact independently disposable database', () => {
  const valid = 'postgresql://127.0.0.1:55439/gateway_test_health_recovery_round57'
  expect(healthRecoveryDatabaseURL(valid).pathname).toBe('/gateway_test_health_recovery_round57')
  for (const value of [
    undefined,
    valid.replace('127.0.0.1', 'ordinary.example.invalid'),
    valid.replace(':55439', ':5432'),
    valid.replace('round57', 'round58'),
    valid + '?',
    valid + '#',
  ])
    expect(() => healthRecoveryDatabaseURL(value)).toThrow('Exact local storage recovery fixture required')
})

it('rejects query and fragment ambiguity before the Project Gateway fixture can connect or reset', async () => {
  const prior = process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL
  try {
    for (const suffix of ['?', '#', '?database=ordinary', '#ordinary']) {
      process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL =
        'postgresql://127.0.0.1:55439/convergence_gateway27' + suffix
      await expect(prepareProjectGatewayFixture()).rejects.toThrow('Explicit Gateway service fixture required')
    }
  } finally {
    if (prior === undefined) delete process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL
    else process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL = prior
  }
})

it('checks the connected database identity before a destructive fixture operation', async () => {
  const url = connectorTestDatabaseURL('postgresql://127.0.0.1:55439/connector_test_ci15')
  const queried: string[] = []
  const pool = (name: string) => ({
    query: async (sql: string) => {
      queried.push(sql)
      return { rows: [{ name }] }
    },
  })
  await expect(assertFixtureDatabase(pool('ordinary'), url)).rejects.toThrow(
    'Connected fixture database does not match',
  )
  await expect(assertFixtureDatabase(pool('connector_test_ci15'), url)).resolves.toBeUndefined()
  expect(queried).toEqual(['SELECT current_database() AS name', 'SELECT current_database() AS name'])
})
