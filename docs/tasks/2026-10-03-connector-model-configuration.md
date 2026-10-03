# Connector model configuration validation

## Evidence and scope

The connector's local model validation rejects empty/oversized IDs and four whitespace characters, while the existing Control Plane requires an ASCII letter or digit first, followed by letters, digits or `._:/-`, with at most 200 characters. The CLI constructs its client before reading a pairing token, reserving an identity file or sending network requests.

An isolated real CLI/HTTP/file probe accepts leading-hyphen, NUL and Unicode model configurations, redeems a simulated one-time pairing and saves identity. Subsequent local model discovery returns the exact name, but renewal receives 400 under the mock Control Plane's existing model policy; polling never starts. Three leaves fail and a valid arbitrary custom-model control passes (3.415 seconds). The one-time token is implemented by the mock fixture; this is not a PostgreSQL pairing proof.

[Envoy's startup validation](https://www.envoyproxy.io/docs/envoy/latest/operations/cli#cmdoption-mode) checks configuration before serving, with a separate validation mode that generates no network traffic. Apply the same early-validation principle to the connector's existing constructor, using NexusAPI's own model policy. No new dry-run command is introduced; the existing `check` continues its bounded health probes for valid configurations.

## Minimal implementation

Apply the existing Control Plane model-ID rule in `Config.Validate`, retaining the 1–64 model count, duplicate behavior, existing fixed error message, local addresses and upstream credentials. Do not change ordinary compatible-provider custom model handling or the Control Plane policy. Keep arbitrary compliant custom IDs; no vendor/model catalog assumptions are added.

Use a shared static positive/negative fixture from both Go CLI tests and TypeScript `modelIDs` tests. The fixture documents examples and length boundaries rather than inventing a second executable regex implementation. Actual CLI tests must show invalid configuration fails before HTTP, pairing input/state or identity creation; valid custom models continue through pairing, checks and runtime authorization.

## Validation and workflow

Capture formal old failures before production edits. Keep this round's Go production unchanged until R49's actual Gateway/CLI attribution run completes, so that earlier evidence has a clear baseline. Then run the focused CLI/model contract, full native Go, vet, Linux race, TypeScript and real connector TLS regression. Complete formatting, secret/diff checks and independent review before committing. No schema, migration, protocol, provider catalog, billing or deployment change is planned.

## Results

- The formal old pairing subset has three failures and two passing controls (3.444 seconds). Each invalid case actually redeems the mock pairing and writes identity before the desired rejection assertion. Legal custom and duplicate-model configurations complete pairing, three service checks, initial runtime lease/polling and fixture-driven authorization rejection.
- After the production grammar fix, all twenty-six cases pass (3.688 seconds); three repetitions pass seventy-eight cases (3.325 seconds). Invalid pair configurations perform no HTTP, consume no mock pairing and create no identity placeholder. Invalid check/run configurations perform no HTTP and preserve an existing identity byte for byte.
- The shared fixture has six positive and thirteen negative examples, including the 200/201-character boundary. `src/lib/connectors/control.test.ts` checks the same examples against actual `modelIDs`, passing all forty-nine cases including existing authorization controls (0.369 seconds). Targeted ESLint/Prettier pass. R49's fresh non-incremental TypeScript compiler includes these already-written test/JSON changes and passes; no TypeScript runtime changed. Independent review is recorded before committing.
- The Go edit starts only after R49's real old and fixed executions finish and close their processes/pools. It changes only the local model grammar and uses Go's standard compiled regexp; there is no new application dependency or ordinary-provider model restriction.
- An additional ignored actual CLI probe leaves stdin open without a token or EOF; invalid configuration exits in 0.03 seconds, before HTTP or identity reservation. This independent case is separate from the twenty-six formal tests and seventy-eight repeated executions.
- Full native `go test ./... -count=1` passes (Gateway 89.843 seconds, connector client 16.465 seconds, CLI 2.627 seconds); `go vet ./...` passes (3.282 seconds). Full Linux race passes (Gateway 194.288 seconds, connector client 18.964 seconds, CLI 15.803 seconds). All nineteen independent-process private-CA TLS connector scenarios pass (31.55 seconds), applying the existing twenty-eight migrations. Formatting, secrets and diff checks pass.
- Final independent read-only review approves all seven staged files with no remaining findings. It confirms exact ASCII/length consistency and that constructor validation precedes CA loading, pairing input, identity reservation and network use. Mock pairing evidence does not claim PostgreSQL redemption; ordinary-provider IDs and live deployments were outside review. The reviewer did not rerun tests or access private fixture material/databases.
