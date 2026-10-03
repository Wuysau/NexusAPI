import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const resolution = { alias: { '@': resolve(process.cwd(), 'src') } }

export default defineConfig({
  resolve: resolution,
  test: {
    // Integration suites own the same Postgres database and each resets the
    // public schema in beforeAll. Running files in parallel would have them
    // drop each other's schema mid-run, so execute sequentially.
    fileParallelism: false,
    projects: [
      {
        extends: false,
        resolve: resolution,
        test: {
          name: 'shared',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['tests/integration/local-connector.test.ts'],
        },
      },
      {
        extends: false,
        resolve: resolution,
        test: {
          name: 'connector',
          environment: 'node',
          include: ['tests/integration/local-connector.test.ts'],
          // Set before route imports initialize the application database pool.
          env: { DATABASE_URL: process.env.CONNECTOR_TEST_DATABASE_URL || process.env.DATABASE_URL || '' },
        },
      },
    ],
  },
})
