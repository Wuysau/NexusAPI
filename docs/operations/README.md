# Operations Runbooks

Executable runbooks for NexusAPI production operations. Each runbook is a
markdown file with step-by-step procedures and, where possible, a companion
script under `scripts/ops/`.

## SLO and error budget

See [slo.md](./slo.md) for service-level objectives, error-budget policy and alert thresholds.

## Runbooks

| Runbook | When | Script |
|---|---|---|
| [release.md](./release.md) | Deploying a new version | `scripts/ops/release.sh` |
| [rollback.md](./rollback.md) | Reverting a deployment | `scripts/ops/rollback.sh` |
| [key-rotation.md](./key-rotation.md) | Rotating credentials | `scripts/ops/rotate-key.sh` |
| [incident.md](./incident.md) | Active incident | — |
| [backup-restore.md](./backup-restore.md) | PITR recovery drill | `scripts/ops/pitr-verify.mjs` |
| [reconciliation.md](./reconciliation.md) | Billing variance | `scripts/ops/reconcile-check.mjs` |

## PITR recovery drill

The backup-restore runbook includes a scripted verification
(`scripts/ops/pitr-verify.mjs`) that checks ledger balance, outbox continuity,
price version references, and KMS recovery after a restore. Run it quarterly
in an isolated environment.
