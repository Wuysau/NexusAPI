# Gateway resilience: design and acceptance

## Intent

Continue improving NexusAPI with independently implemented ideas from established open-source gateways. Keep project authorization, signed snapshots, upstream credentials and immutable usage attribution authoritative. Work in small verified rounds, as requested by the user.

Base: clean `origin/main` at `a1bf222`; branch `codex/gateway-resilience`. The existing post-commit workflow merges verified commits to main and pushes them.

## Round 1 design

1. Respect bounded upstream cooldown hints. Parse `Retry-After` seconds/HTTP dates and the millisecond variants, clamp to 60 seconds and discard malformed values. A 429 immediately excludes that channel/model for later requests; a 503 with a positive hint also cools it down. Recovery uses the existing half-open admission guard. A concurrent older success must not clear an active cooldown. No sleeping or broader replay of the current request.
2. Count provider health failures by their meaning. Invalid input and content-policy refusals do not poison shared channel health. Quota, authentication, transient transport and server errors retain their explicit handling. Unknown execution and missing usage stay unknown.
3. Make readiness reflect dependency checks. Require a fresh signed snapshot and responsive database; production also requires a successful live Redis check. Development can explicitly report local admission. Bound probes to two seconds and do not publish raw errors. Public version output exposes aggregate breaker counts without channel/model identifiers.
4. Correct startup concurrency initialization. Apply the configured process cap before admission; startup must not permanently consume a slot or fix the cap to 256.
5. Replace the HTTP-only container probe with a compiled local readiness command. Reuse configured port and TLS mode, verify certificates, optionally trust an operator-supplied CA and DNS name, and bound the probe to three seconds/64 KiB.

No schema changes, provider source copying, new upstream secret paths, subscription credential usage, or relaxed authorization are needed.

## Primary references

- [LiteLLM routing and error-specific cooldown](https://docs.litellm.ai/docs/routing)
- [Portkey automatic retries and bounded retry hints](https://portkey.ai/docs/product/ai-gateway/automatic-retries)
- [LiteLLM health checks](https://docs.litellm.ai/docs/proxy/health)
- [Bifrost provider routing](https://github.com/maximhq/bifrost/blob/dev/docs/providers/provider-routing.mdx)

These references inform behavior; NexusAPI keeps its stricter replay and financial rules. Repository source code is not copied.

## Validation plan

- Parser tests for seconds/dates/ms, missing/negative/malformed/overflow input, and maximum duration.
- Breaker tests for per-channel/model isolation, concurrent success, expiry, half-open probe limits and release.
- Gateway requests prove current calls are not replayed, later traffic can use another eligible channel, and bad input cannot trip shared health.
- HTTP readiness tests for startup, fresh/stale snapshot, database/Redis failure and recovery, timeout, and development profile.
- Public diagnostics test that channel and model identifiers never appear.
- Startup admission tests below and above 256 concurrent slots, release and reuse.
- Full Go tests, vet, formatting; relevant TypeScript contracts and secret scan before commit.

## Results

- `go test ./...` and `go vet ./...` passed, including real HTTP/TLS probe servers, cooldown, routing/streaming, admission, and platform-directory freshness regressions.
- Five related TypeScript contract files passed: 67 tests (`gateway-contracts`, `gateway-callers`, `gateway-artifact`, `usage-event-v2`, `owned-access-accounting`).
- Go format, changed document/test formatting, diff whitespace and secret scan passed.
- Healthcheck binary builds with `CGO_ENABLED=0`; no new dependencies or migration.
- Docker image build and container race validation were unavailable because Docker Desktop's Linux engine was not running. Host Go race still needs a C compiler/CGO. No production rollout was performed.
- Review found and fixed readiness accepting an expired platform key directory when a tenant bundle remained fresh. Tests first reproduced the false-ready response and now require 503.
- Existing local-connector framing does not forward upstream retry headers; local 429 uses the configured default cooldown. Per-provider hints currently apply to direct API channels.

## Next round

Investigate and fix server request identity versus client correlation, plus two-phase shutdown that allows terminal persistence to finish. Both defects have been reproduced with real HTTP requests. Keep these changes separate from the first verified commit.
