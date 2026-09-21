# SLO and Error Budget

## Service-level objectives

| SLI | Target | Window | Source |
|---|---:|---:|---|
| Gateway availability (excludes provider failures) | 99.95% | 30d | `nexus_requests_total` / errors |
| Nexus non-provider p95 latency overhead | < 75 ms | 7d | `nexus_request_duration_seconds` |
| Successful request usage event persistence | 99.999% | 30d | outbox `published` / `failed` |
| Ledger visible latency p99 | < 5 min | 7d | `nexus_billing_lag_seconds` |
| Approved config propagation p99 | < 60 s | 7d | `nexus_snapshot_age_seconds` |
| Tenant data leakage | 0 | permanent | security tests |

## Error budget policy

The error budget is `1 - SLO` over the rolling window. For 99.95% availability
over 30 days, the budget is ~22 minutes of downtime.

| Budget consumed | Action |
|---:|---|
| 50% | Review: postmortem on recent errors, no freeze |
| 75% | Freeze: no non-reliability releases until budget recovers |
| 100% | Incident: page on-call, freeze all releases, root-cause |

## Alerting

Alerts fire when:
- Error rate exceeds 1% over 5 minutes (availability).
- p95 latency exceeds 150 ms over 5 minutes (latency).
- Outbox depth grows for 3 consecutive polls (usage persistence).
- Billing lag exceeds 10 minutes (ledger).
- Snapshot age exceeds 120 seconds (config propagation).
- KMS failure count increases (secret plane).
- Dead-letter count increases (outbox).

## Metric sources

All metrics are exposed by the observability package
(`packages/observability/metrics.ts`) and rendered as Prometheus text at
`/api/metrics` (or scraped via the registry snapshot).
