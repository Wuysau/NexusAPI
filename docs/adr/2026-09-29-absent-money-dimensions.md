# Absent financial dimensions in usage analytics

Status: Accepted

Task: [Live functional acceptance](../tasks/2026-09-29-live-functional-acceptance.md).

## Context

Live read-only acceptance found a BYOK request displayed zero margin and zero amounts under unrelated currency buckets. SQL produces separate charge, upstream-cost and managed-margin facts. The response assembler initialized every missing currency/dimension combination to a known zero even when no such fact existed. This made absence look like free service or zero profit.

## Decision

Extend the public analytics money metric with optional `hasFacts: false`. This marker is valid only alongside `knownSum: "0"`, `unknownRequests: "0"`, and `total: null`. It denotes no facts for that currency/dimension. It is not allowed on token metrics. `true`, strings, nonzero sums/counts or a numeric total with this marker are rejected.

Existing metrics omit the field and retain the established exact-total invariant: any unknown observation makes total null; otherwise total equals knownSum. Actual recorded zero stays zero. The response assembler uses the absence marker only for missing SQL dimensions, then replaces it with actual aggregated metrics when present. No extra unknown requests are invented.

The UI omits absent currency entries within a financial column and displays an em dash when the whole column has no facts. Unknown reported prices remain “未知”. The strict response schema and its runtime validator accept existing payloads and the new optional money-only marker. Old strict clients need the updated contract to accept the extended payload; there is no claim that they can consume new fields unchanged.

## Boundaries and validation

No database schema, usage facts, prices, ledger or financial writers change. This is response/read-model and presentation behavior only. Regression tests cover contract rejection, absent BYOK margin, independent currencies, an unsettled request, real zero cost, group/total agreement, and rendered unknown/zero/dash states. Integration tests use a disposable database; the configured live database is read-only during acceptance.
