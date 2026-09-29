# Broaden verified Agent coverage

Status: done

The user points out that the existing 20-entry registry is not a complete representation of popular Agent tools. Expand coverage across terminal, IDE and hosted tools, prioritizing real adapters over names. Continue the existing observer design and user-authorized autonomous implementation; preserve product navigation, account mappings, namespace isolation, metadata-only records and gateway billing boundaries.

## Design and acceptance

- Research official documentation/source for omitted tools, including Factory Droid, Pi, Qoder, CodeBuddy, Crush, OpenHands, Zed, Antigravity, OpenClaw and hosted agents. Distinguish tool identity from upstream model/subscription.
- Add independently tested native parsers and official Hook/export adapters where stable session/event metadata exists. Missing counters stay unknown; no guessing token semantics or parsing prompt text.
- Extend recurring discovery only to verified default telemetry locations. Explicit paths remain supported. Unknown proprietary formats or unavailable cloud exports must be labelled unsupported, not counted as implemented integrations.
- Keep common tools already registered under review too: a generic bridge label alone is not a native integration.
- Show actual capture capability and documented setup in the existing panel/manual. Cover mixed tooling, stable replay identities, privacy canaries, partial records and workspace attribution in tests.
- Do not read credential stores, redirect traffic, install client hooks without preserving user configuration, or add financial writers. No schema change is expected; accepted extensible-agent ADR applies.
- Run unit, contract, integration, security, type/lint, build and browser checks; preserve the active local service and commit/push main after validation.

## Evidence

- Implemented Pi v2/v3 and Qoder IDE discovery/parsers; explicit single-turn Factory SDK and legacy OpenClaw exports; official Windsurf, CodeBuddy, Factory, Qoder CLI, Kiro lifecycle and Antigravity hooks. Pinned official evidence and configuration examples accompany adapters. No claim of live validation in every vendor client.
- Registry has 42 identities: 11 native, 3 export, 5 primary Hook, 7 generic bridge and 16 explicitly unavailable. Qoder/Factory also have Hook options. The panel supports text/category/capture filtering; manuals distinguish activity-only records and unsupported current storage versions.
- Fixed persisted telemetry spools failing above 4096 rows; bounded normalization now merges stable identities across payloads, rejects conflicts and retains the 50000-event/64MiB limits. Parser version v2 invalidates stale scan cursors safely.
- Passed 564 unit, 261 contract, 411 integration and 49 security tests. Following the reader fix/version bump, reran all unit tests plus 16 focused reader/database tests. Typecheck/ESLint, secret scan, production and observer builds passed. Existing Next middleware/tracing warnings remain.
- Browser verified 42 entries, name/Chinese search, category/capture filters and empty results with no page errors. Native Pi/Qoder/Factory/OpenClaw integration fixtures prove project attribution, unknown counters, replay deduplication and no financial/content writes. Hook CLI tests use isolated homes, not user tool settings.
- Restarted only the active observer child. Live observer completed sync without errors; control-plane health, gateway health and readiness each returned 200. Disposable PostgreSQL/Redis test containers stopped; real services and user mappings preserved.
