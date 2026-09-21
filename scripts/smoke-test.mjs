// Entry point for `npm run test:e2e`.
//
// Requires a running dev server (TEST_ORIGIN, default http://localhost:3000)
// and a migrated Postgres (DATABASE_URL). The control-plane flows themselves
// live in tests/e2e/control-plane.mjs so they can also be imported by CI.
//
// This replaces the pre-Work-Item-H smoke test, which drove the legacy
// single-file dashboard and the deprecated /api/admin surface.

import 'dotenv/config'
import { runControlPlaneE2E } from '../tests/e2e/control-plane.mjs'

runControlPlaneE2E().catch((error) => {
  console.error('\nE2E FAILED:', error.message)
  process.exitCode = 1
})
