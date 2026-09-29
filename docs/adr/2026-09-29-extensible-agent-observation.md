# Extensible client-observed Agent sources

Status: Accepted

Replace per-tool persistence enums for new local tools with validated `agent:<id>` names. Existing codex_local and claude_code_local records retain their identities. The tool registry is presentation/onboarding metadata, not an upstream provider or subscription registry. Native snapshots and canonical metadata flow through the existing tenant-scoped observer transaction, cursor, workspace attribution and analytics pipeline. No direct financial writer is introduced.

New agent observations may be activity-only with unknown tokens. Documented later usage can fill unknowns and monotonically revise the same stable event; scope, source, identity and attributed project remain immutable. Replayed, copied and rewritten files cannot create duplicate events. A file modification is a new snapshot, not an appended token delta.

Server-owned agentSources select tool, path, optional explicit workspace and format. Recurring default-path discovery is opt-in and local-admin/CSRF protected. Discovery only reads known telemetry files and Nexus's metadata-only spool. It does not scan secrets, reverse engineer arbitrary encrypted stores, install hooks into another client, or redirect client traffic. Unsupported tools can export canonical metadata or supported OTLP/Hook payloads. Tool installation alone does not promise telemetry availability.

Expand API source validation to accept the same bounded agent namespace; labels and selectors come from the shared registry plus actual source facts. Unknown/custom tool IDs remain visible. Preserve separate gateway authoritative accounting and local client-observed records even if the same external activity appears in both.
