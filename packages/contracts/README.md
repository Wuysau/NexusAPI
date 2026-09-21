# Shared contracts

This package contains the public schemas and TypeScript bindings shared by the
control plane, gateway, budget service, and usage processors.

| Contract | Schema or documentation | Bindings |
| --- | --- | --- |
| Usage event v1 | `schemas/usage-event.schema.json` | `usage-event.ts`, `services/gateway/contracts.go` |
| Usage event v2 | `schemas/usage-event-v2.schema.json` | `usage-event-v2.generated.ts`, `services/gateway/contracts_v2_generated.go` |
| Usage analytics | `schemas/usage-analytics-query.schema.json`, `schemas/usage-analytics-response.schema.json` | `usage-analytics.ts` |
| Quota observations | `schemas/quota-observation.schema.json`, `schemas/quota-metadata.schema.json` | `quota.ts` |
| Budget requests | `schemas/budget-request.schema.json` | `budget.ts` |
| Price records | `schemas/price-record.schema.json` | `src/lib/pricing/components.ts` |
| Signed secret registry | `schemas/secret-registry.schema.json` | Gateway secret registry validation |
| Connector capabilities | `connector-capability.schema.json` | `connector.ts` |
| Public API errors | [`api-errors.md`](../../docs/contracts/api-errors.md) | `api-errors.ts`, `services/gateway/errors.go` |
| Provider adapters | [`provider-adapter.md`](../../docs/contracts/provider-adapter.md) | `services/gateway/provider/adapter.go` |

Schema paths are relative to this package; service and source paths are relative
to the repository root. JSON Schema identifiers remain stable across file moves.

## Validation and generated bindings

The runtime validators enforce schema constraints and domain relationships.
Contract tests in `tests/contract` check required fields, valid and invalid
fixtures, analytics queries, quota shapes, and public error mappings. Gateway
tests check the Go bindings against the same cross-service contracts.

Usage event v2 bindings are generated from the canonical schema:

```sh
node scripts/generate-usage-v2.mjs
node scripts/generate-usage-v2.mjs --check
npm run test:contract
```

Generation requires Go's `gofmt`; the drift check also runs in Node-only CI.
When changing a contract, update all consumers and their fixtures together.
Usage event v1 rejects unknown schema versions while tolerating extra fields;
usage event v2 validates its closed shape and cross-field relationships.
