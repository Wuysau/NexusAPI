# Extensible mainstream Agent observation

Status: complete

## Intent and design

The user requires newly used mainstream Agent tools to appear in project usage without repeatedly extending a Codex-specific importer. Preserve the existing product/navigation, tenant and project boundaries, privacy, and independent gateway billing. Prior authorization permits autonomous implementation and integration.

Use three complementary paths: native local adapters for documented metadata/token formats, a metadata-only canonical/OTLP/Hook bridge for other tools, and the existing authoritative gateway path when traffic is routed through Nexus. A public tool registry reports actual support and onboarding. Never advertise that arbitrary external traffic can be intercepted, infer tokens from text, or relabel a tool as its upstream subscription.

## Plan

1. Research native formats in primary sources; implement independently tested CLI and IDE adapter modules in parallel.
2. Add agentSources and optional recurring auto-discovery to server-owned observer configuration. Preserve legacy Codex/Claude fields. Discover only documented telemetry paths and the Nexus metadata spool, not credentials or arbitrary private databases.
3. Integrate bounded native snapshot readers with existing transaction, idempotency, workspace attribution and cursor pipeline. New agent:<tool> sources remain client_observed and carry unknown financial/channel fields.
4. Expand SQL source/monotonic revision constraint, analytics contracts and tool labels; show tool readiness/configuration within existing usage UI.
5. Provide canonical stdin CLI and documented Hook/OTLP paths for tools without readable token logs. Activity-only events retain unknown token counts.
6. Verify source parsing, replay, atomic rewrite, authorization, isolation, privacy, migration replay and browser flows; enable discovery in this local instance, commit and push main after verification.

## Acceptance and limitations

- Registry covers Codex, Claude Code, Gemini CLI, Qwen Code, OpenCode, Cline, Roo Code, Kilo Code, GitHub Copilot, Cursor, Windsurf, Kiro, TRAE, Continue, Aider, Kimi CLI, Goose, Amp, Augment and JetBrains Junie with honest per-path capabilities.
- Adding an arbitrary named tool through canonical metadata requires no database migration or new UI code.
- Native adapters use verified fixtures and source references; unsupported formats show a setup/unknown state rather than fabricated successful capture.
- All local I/O remains bounded, explicitly configured or discovered after opt-in, and never sends prompt/response/credentials into PostgreSQL or logs. No new financial effects.
- Rollback disables discovery/new source entries and retains additive schema and historical observations. Legacy sources continue working.

## Evidence

- Unit: 488/488; contract: 261/261; integration: 410/410; security: 49/49. Integration uses disposable local PostgreSQL/Redis on ports 55439/56381, not the running development database.
- Migration verification: 31/31, Drizzle journal check passes. Migration 0024 applied to the local development database with canonical LF bytes; 25 migrations total.
- `npm run check`, `npm run format:check`, `npm run build`, `npm run observer:build`, and `npm run secrets:scan` pass. Existing Next middleware/tracing warnings remain unchanged.
- Fixtures cover native CLI/IDE formats, 20 catalog identities and arbitrary future IDs, activity-only usage, partial counter enrichment, rewritten snapshots, replay, malformed sources, tenant/project boundaries, metadata privacy and zero financial side effects.
- Integration review found and fixed two importer defects: partial counter revisions were dropped; rolled-back file state could suppress healthy subsequent imports. Real PostgreSQL regressions verify both. Session counts include source identity in scan summaries as well as analytics.
- Browser: authenticated local owner sees 20 tool rows, enabled discovery, live worker state and existing Claude/custom-model session details. A browser-only response fixture verifies an arbitrary new tool appears in the source dropdown; no fixture records were written to the live database. No page errors.
- Local deployment preserves existing Codex/Claude source scopes and account mappings, enables recurring discovery, and restarts the observer. Current real sources are Codex and Claude; other installed clients without compatible logs are not claimed as captured.
- Public README, online manual and detailed operations guide document native versus Hook/export/bridge paths and unknown token semantics. Closed tools without an accessible supported export remain a setup limitation, not fabricated telemetry.
