# Live functional acceptance with configured subscriptions and coding plan

Status: done

The user authorizes exercising the existing Nexus project and fixing defects, asking questions where needed. Preserve its real connections, credentials, project roots, immutable usage and ledger. Use temporary clearly labelled resources for reversible CRUD; revoke test keys afterwards. Do not reset/reseed the live database or create real payment charges. A few bounded diagnostic inference requests through the configured channel are within this test authorization.

## Scope and acceptance

- Inventory and exercise authenticated console pages, API authorization, projects/connections/channels, models/routing/resources, subscriptions/quotas, tasks, observer/analytics, gateway streaming/nonstreaming, key revocation, logs/worker/reconciliation and payment readiness.
- Record actual request/usage outcomes and distinguish live verified, fixture verified, unavailable configuration and upstream failures. Do not claim every external vendor or real purchase has been tested.
- Create regression tests before focused fixes. Preserve snapshot, tenant, unknown-usage, credential and immutable-financial boundaries. Use the public main worktree and keep private root changes untouched.
- Database-resetting suites run only on disposable local PostgreSQL/Redis; real service testing is scoped and non-destructive. No vendor credential or authorization content in evidence.
- Run relevant checks and real-flow rechecks, update a sanitized acceptance report, commit/push main and keep local services running.

## Initial inventory

Live control plane/gateway run on 3000/8080. Nexus has one Codex subscription connection and one custom connection linked to an enabled Anthropic-protocol Kingstar channel with three model IDs. Observer is healthy and has Codex/Claude records. Stripe is unconfigured and has no published plans. Task/runtime and subscription capabilities require additional checks before any execution.

## Evidence

See the [sanitized acceptance report](../operations/live-acceptance-2026-09-29.md) for real requests, fixture-only coverage, cleanup and remaining configuration gaps.

- Real console: 18 primary routes, project/connection/model CRUD, channel lifecycle against a local mock, viewer/CSRF rejection and key revocation passed.
- Real configured upstream: three model calls and one stream passed after the authenticated model-list repair; completed requests and published outbox events were checked in the live database. Codex account refresh and a new Claude Code local observation passed.
- Tasks were fixture-only at the user's explicit request because no independent logged-in Profile exists. Stripe is unconfigured; no real charge was attempted. The browser playground remains an explicitly labelled placeholder.
- Final unit suite: 575 tests / 58 files passed. Contract suite: 263 tests / 24 files passed. Git auto-sync hook suite: 6 passed.
- Disposable-database integration: 412 tests / 37 files passed. Security: 49 tests / 5 files passed. Final quota/analytics focused recheck: 22 passed. No destructive suite used the live database.
- `npm run check`, production build, observer build, changed-file Prettier check and `git diff --check` passed. Secret scanning after staging all 24 intended files found no secrets.
- `npm run gateway:check` passed Go formatting, vet, Linux Docker race tests and golangci-lint (0 issues). Native `go test ./...` also passed.
- Independent review identified a standard JSON Schema constraint gap for absent money facts; it was fixed with `if/then` and an Ajv2020 regression. The final Go lint identified two unchecked test cleanup calls; both were corrected and the full gate rerun successfully.
- Test-environment retries: an initial database-startup attempt was rerun after readiness; a final focused command briefly used a nonexistent disposable database name, then passed against the verified `convergence_ci15` fixture. Neither touched live data.

Final control-plane health, gateway health and gateway readiness returned 200. Disposable test containers were stopped; live services remain running.

The four fixes and quota presentation correction preserve the existing product structure. Remaining live acceptance requires independently authenticated task resources/policy and configured Stripe merchant credentials/plans; simulated tests do not establish those external capabilities.
