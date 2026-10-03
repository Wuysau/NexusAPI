# Connector result method admission

## Evidence

An isolated actual HTTP probe uses a Control Plane authorization fixture, real connector polling, `ConnectorHub` and `connectorTransport`. Authenticated GET, HEAD and OPTIONS requests to a valid result path return 404 but mark the job claimed. The owner's subsequent first POST also returns 404. Three regression leaves fail; normal POST, unauthenticated GET, another authorized lease and a wrong-method cancellation request pass (3.178 seconds). This proves a request-state defect, without claiming an authorization bypass, local inference or accounting coverage.

[Caddy's method matcher](https://caddyserver.com/docs/caddyfile/matchers#method) scopes handlers by both method and path. Apply that principle before the connector's state transition, retaining NexusAPI's existing routing and authorization rather than importing a matcher framework.

## Minimal change

- Add the existing supported POST method to the result-claim predicate under the same mutex.
- Retain live lease authorization, tenant/connection/token binding and the current unsupported-method 404 response.
- Keep one accepted POST per job. Invalid or interrupted POST uploads still consume their claim; execution and output cannot be replayed through a second upload.
- Leave polling, cancellation watches, frame validation, deadlines and terminal accounting unchanged.

No schema, migration, connector wire version, credential or deployment change is needed. The single-Gateway constraint remains in force.

## Verification

Add actual HTTP/verified-TLS regressions for wrong methods followed by a successful first POST, with existing ownership and single-claim controls. Capture formal old failures before changing production, then run focused tests, native Go tests/vet, Linux race checks and the existing independent-process connector TLS regression. Verify formatting, secrets and diff scope; obtain independent review before committing.

## Results

- The new formal private-CA TLS suite runs both HTTP/1 and HTTP/2. The old implementation fails six GET/HEAD/OPTIONS regressions and passes eighteen controls (4.018 seconds). Assertions observe actual upload status and transport metadata/EOF, rather than the internal claimed flag.
- The controls retain normal POST, unauthenticated and independently changed lease/tenant/connection bindings, wrong-method cancellation, overlapping POST uploads, malformed frames and interrupted uploads. A consumed accepted POST cannot upload again. A delegated body reader synchronizes the overlap/cancellation cases while retaining actual network I/O.
- The focused suite passes all twenty-four cases (1.692 seconds), then seventy-two executions across three repetitions (3.828 seconds). `go test ./... -count=1` passes the complete native suite (Gateway 84.102 seconds); `go vet ./...` passes (1.538 seconds).
- Eighty-six TypeScript contracts pass (6.18 seconds). The nineteen independent-process private-CA TLS connector scenarios pass (31.96 seconds), applying all twenty-eight canonical migrations. Full Linux `go test -race ./...` passes (Gateway 195.059 seconds). Formatting, secret scan and diff checks pass. Independent-review results follow before commit. TypeScript runtime and types are unchanged; R47's fresh non-incremental compiler remains the current baseline.
- Final independent read-only review approves the six staged files with no remaining findings. The reviewer did not rerun tests, access private fixture configuration/databases or assess live deployment. The method-specific suite establishes transport state behavior; inference/accounting remain separately exercised by the real connector end-to-end suite.
