# Claude Code local usage capture

Status: done

## Cause and scope

The observer only scans Codex JSONL and the database/API constrain local sources to Codex. Claude Code direct custom-endpoint calls never reach the Nexus gateway. Add explicit Claude transcript sources, allowlisted metadata/token parsing, replay-safe message updates and source-aware analytics/session cards. Preserve existing navigation, Codex behavior, tenant/project isolation and billing separation. Never infer a historical channel or paid subscription from a model name or today's client settings.

## Acceptance

- Parse Claude Code assistant usage from explicitly configured local transcript directories; never persist prompt, response, settings credentials or arbitrary raw fields.
- Repeated message blocks and file replays count once; later complete usage revises the same local observation without ledger effects.
- Attribute by recorded cwd; preserve unknown provider/connection/subscription and distinguish Claude from Codex sessions.
- Expand the source constraint and analytics contracts compatibly; preserve Claude sources when saving existing Codex configuration.
- Test parser, actual SQL import/replay/filtering/isolation and migration replay; verify the user's recent session appears after a non-destructive migration and worker restart.

## References and rollback

ADR: ../adr/2026-09-29-claude-local-observation.md. Observer operational guide and usage-analytics machine schemas are updated with this task. Existing architecture invariants remain in force. Roll back the worker/UI code and remove claudeSources from local configuration to stop scanning; retain the expanded source constraint and imported records for compatibility. Do not delete user observations to roll back.

## Evidence

- Unit suite: 390 passed; after adding the project-link regression, its focused component file passed all 4 tests.
- Contract suite: 261 passed. Integration suite: 404 passed across 36 files. Security suite: 49 passed. Final importer adjustment rechecked both Claude and Codex suites (15 passed).
- TypeScript/ESLint, formatting, secret scan, whitespace check, Drizzle journal check and final production build passed. Migration bootstrap, checksum preservation and idempotent replay passed in the canonical migration suite.
- All schema-resetting tests used disposable local PostgreSQL port 55439. The development database received only the canonical additive migration (1 applied; 24 total).
- Enabled only the user's NexusAPI Claude transcript directory in ignored local configuration; preserved Codex sources and mappings. Restarted the existing Observer child under its launcher.
- Live SQL and authenticated browser verification confirmed the previously missing 10:29 session: glm-5.2, two observations, 54,946 tokens, project Nexus, provider/connection/subscription unknown. Project link filtering now retains claude_code_local; expanded card displays Agent 工具：Claude Code. No browser page errors. Billing's purchase panel is visible and correctly reports missing merchant configuration/published plans.
- Public main checkout only; private development changes are untouched. No live charge, upstream test call, client credential/config replacement or ledger mutation was performed.
