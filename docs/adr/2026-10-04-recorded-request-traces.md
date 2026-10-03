# Recorded request trace explorer

Date: 2026-10-04. Decision: independently adapt metadata-only trace navigation.

## Problem and existing behavior

The Gateway durably records logical requests, ordered attempts, provider request IDs and frozen pricing/configuration versions. `/api/logs` and `LogTable` show a request summary and the latest attempt, not the complete recorded attempt sequence. Operators cannot inspect a pre-dispatch failover and its eventual completion together. Existing OpenTelemetry export is a separate diagnostic channel, not the accounting source of truth.

## References and why Nexus needs this

[Langfuse's project-scoped trace route](https://github.com/langfuse/langfuse/blob/f75c661dbe8c6b85523c81486b39e8403ac2c141/web/src/pages/api/public/traces/%5BtraceId%5D.ts), OpenLLMetry's span lifecycle and [AxonHub's trace flow](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/frontend/src/features/traces/components/trace-flow-timeline.tsx) illustrate trace navigation. Borrow the relationship and scope checks; implement a bounded original read model over Nexus facts. No content capture SDK, arbitrary query language or graph dependency is introduced. This belongs in the control plane because it explains a project's actual resource execution and preserves accounting provenance.

## Ownership, source of truth and write authority

Gateway owns execution facts; Worker owns validated metering and settlement. Control Plane reads these tables in a repeatable-read, read-only transaction. It cannot change attempts, recover requests or write accounting through this endpoint. Historical `request_project_facts` governs visibility and project identity, independently from a connection's current project.

## Data model and API contract

Add `GET /api/logs/:id/trace`, a typed contract in `packages/contracts/request-trace.ts`, a query service in `src/lib/billing/request-trace.ts` and an on-demand detail panel linked from request logs. Return a versioned, content-redacted projection: request/trace ID, historical project, requested model, status/timing, ordered attempts, actual provider/model/channel/connection, fixed error code, provider request ID, frozen policy/catalog/price IDs, canonical nullable usage and known settlement amounts. Strings represent exact token/money integers. An ordered request-to-attempt timeline is sufficient; no generic tracing backend is needed.

Unrecorded task/session relations, TTFT, streaming duration, inferred replay and missing usage/price remain `null`/unknown. State clearly that the view covers recorded attempts, including in-flight rows if persisted, not rejected ingress calls. Legacy zero-valued default counters are not asserted as observed usage. If attempts exceed the bounded page, report truncation and total instead of silently suggesting completeness.

## Security boundary and failure semantics

Require `request:read` plus existing historical AnalyticsAccess organization/project visibility. Missing, foreign-tenant and hidden requests all return the same 404. Scope every attempt and usage join by tenant and request; foreign injected rows cannot appear. Use explicit column allowlists and bound SQL parameters. Do not return prompt/response bodies, event payloads, error messages, secret references or arbitrary metadata. Disable response caching. No writes, automatic refresh replay, model calls or arbitrary SQL.

Resolve detail across the caller's permitted tenant organizations, so links from tenant-wide analytics remain usable. Missing historical attribution facts grant visibility only to `allProjects` roles. Prefer Worker's `authoritative_metering` over captured events; event trust requires matching tenant/request/attempt/schema plus frozen v2 project facts. Associate each attempt with its own actual usage anchor. Request `charge_amount=0` without a settled usage-record anchor is unknown, not a known zero charge.

Unknown canonical usage stays unknown; this projection does not synthesize authoritative evidence from legacy counters. Storage failure returns the existing fixed error. Browser scope changes clear prior details, and request ownership prevents stale responses replacing a newer selection. Concurrent reads use a coherent transaction; cancellation is observational and performs no recovery.

## Compatibility, migration and rollback

Additive API/UI only. Existing request/log/analytics contracts and RBAC stay intact. No schema migration, new dependency or Gateway hot-path lookup is necessary. Query a single authorized request and its bounded attempts in a fixed number of round trips; no N+1. Roll back the API/UI independently without deleting historical facts.

## Testing strategy

Unit/contract tests cover projection bounds, nullable/exact usage and fixed fields. Real disposable PostgreSQL with actual session routes covers tenant/project/RBAC, multiple attempts, historical reassignment/archive, zero vs unknown, malicious payload canaries, hidden/missing uniformity and unchanged accounting/audit facts. Browser tests cover selecting, closing, replacing and failing details. Existing Gateway interruption/cancellation/storage tests remain required; no real-provider acceptance is inferred from fixtures.
