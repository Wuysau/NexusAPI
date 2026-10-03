# Connector result acknowledgment cleanup

## Evidence and design

After sending its result, the connector synchronously reads up to 1 KiB of an acknowledgment body that it never uses. The upload has its own parent-based ten-minute deadline so local inference timeouts can still report a sanitized failure. Consequently, the completed inference deadline does not stop a stalled acknowledgment read, and `execute` retains one of the runtime's four worker slots.

An ignored actual HTTP probe sends complete metadata/data/end frames once, then receives a synthetic Gateway/proxy 502 with one byte of an unfinished response. The old client has one failure and two passing controls (2.702 seconds); an ignored candidate removing the unused read passes all three (2.476 seconds). This is a client transport-capacity failure, not evidence of replay or incorrect accounting.

[Cloudflared's response cleanup](https://github.com/cloudflare/cloudflared/blob/f9676c585623c86c0a48dbb6ae80840b4c834718/proxy/proxy.go#L226-L270) makes cancellation and response closure part of one operation's lifecycle. Apply that principle to NexusAPI's existing result upload. The [minimum Go version's response contract](https://github.com/golang/go/blob/go1.24.0/src/net/http/response.go#L49-L60) requires closure and permits HTTP/1 connection reuse to be lost if an error body is not consumed. Normal Gateway acknowledgments are empty 204 responses. No acknowledgment content is needed and no failed upload is replayed.

## Implementation and verification

Keep the existing upload deadline, inference cancellation, frame production and no-replay behavior. Close the unused response without synchronously draining it. Verify early responses while the upload is still running, because HTTP/2 cleanup can also depend on request-body cancellation; adjust cleanup ordering only if that boundary requires it.

Capture formal old failures using actual HTTP/1 and verified TLS HTTP/2. Retain normal empty and finite error controls, cancellation cleanup, exactly one upload/inference, complete framing and a subsequent runtime job that requires a released worker. These transport tests use mock endpoints and do not claim database attribution. Run full native Go, vet, Linux race and the separate nineteen-scenario private-CA connector integration. Finish formatting, secret/diff checks and independent read-only review before the existing Git auto-sync workflow.

No migration, provider capability, billing, deployment mode or new dependency is planned. Channel capability consistency remains a separate read-only investigation.

## Results

- Formal old behavior has five failures and seven passing controls across twelve cases (6.410 seconds). Stalled completed-upload responses and four-worker exhaustion fail under verified TLS HTTP/1 and HTTP/2. An early HTTP/2 response that leaves the response stream open also fails; a genuinely finite early response that returns the handler and delivers END_STREAM passes old behavior. An earlier fixture description was corrected to preserve this distinction.
- Removing only the unused body read passes all twelve cases in the actual production source (2.461 seconds). The existing response closure, subsequent local cancellation, pipe closure and producer join remain. No shorter upload deadline or extra cancellation-order change is needed by the observed pipe-backed HTTP/2 behavior.
- The twelve formal cases plus four existing inference-deadline/process-cancel/lease-expiry controls pass (3.656 seconds); three repetitions of the formal suite pass all thirty-six executions (0.524 seconds). The same sixteen-case selection passes in the cached minimum-version Go 1.24.13 Linux container (2.845 seconds), with verified TLS and actual negotiated protocols.
- Full native `go test ./... -count=1` passes (Gateway 87.471 seconds, connector client 14.526 seconds, CLI 4.853 seconds), and `go vet ./...` passes (3.120 seconds). All nineteen independent-process private-CA connector integration scenarios pass (31.02 seconds), applying the existing twenty-eight migrations and retaining actual attribution/unknown-price checks.
- Full Linux `go test -race ./...` passes (Gateway 197.513 seconds, connector client 19.359 seconds, CLI 15.895 seconds). Transport tests and database integration are separate evidence; mock acknowledgment responses do not imply billing failures or a deployed proxy's behavior.
- Seven related TypeScript protocol/privacy contract files pass all twenty-nine tests (1.92 seconds). There is no TypeScript source/type change; the fresh R49 compiler and R50 test-fixture validation remain applicable. Go formatting, secret scanning and diff checks pass.
- Final independent read-only review approves exactly the five staged files with no findings. It confirms bounded cleanup, synchronized observations, fixed diagnostics and accurate END_STREAM controls. It does not infer database/billing defects from mock acknowledgments or certify a deployed proxy, and excludes the next Chat-eligibility investigation.
