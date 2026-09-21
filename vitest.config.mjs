import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(process.cwd(), 'src') },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Integration suites own the same Postgres database and each resets the
    // public schema in beforeAll. Running files in parallel would have them
    // drop each other's schema mid-run, so execute sequentially.
    fileParallelism: false,
  },
})
