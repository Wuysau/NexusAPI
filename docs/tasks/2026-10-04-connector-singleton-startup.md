# Bound connector singleton acquisition

## Source and scope

`connectorSingleton` opens a dedicated PostgreSQL connection and acquires the existing advisory lock before main constructs the listener. Both steps currently use only the process signal context. In installed [pgx v5.7.6](https://github.com/jackc/pgx/blob/v5.7.6/pgconn/pgconn.go#L244-L260), an omitted connect_timeout leaves connection establishment governed by that caller context. A peer that accepts TCP and stops responding can leave connector-enabled startup waiting indefinitely.

Use the same existing two-second dependency budget for acquisition only: derive a startup context from the caller and apply it to Connect, the initial lock query and failed-acquisition Close. Keep the original root context for the lifetime heartbeat, the existing lock tuple, static errors, stop callback and cleanup. No acquisition retry or multi-instance relaxation is added. This carries forward the established bounded-dependency and cancellation design already applied to the Gateway storage probe.

## Characterization ownership

Before production changes, a new Go test uses actual pgx against a bounded loopback synthetic PostgreSQL peer to expose startup-handshake and initial-query stalls. Controls cover cancellation at both phases, a held lock and a successful lease with heartbeats beyond the acquisition deadline. Driver configuration uses only explicit synthetic credentials and owned service/pass files. No real PostgreSQL, application environment or subscription authentication is read. The peer must bound frames, deadlines and worker cleanup, including CancelRequest and Terminate/EOF.

[pgx canceled-connection cleanup](https://github.com/jackc/pgx/blob/v5.7.6/pgconn/pgconn.go#L645-L718) may finish asynchronously. A returned Close does not establish that every driver goroutine has stopped; tests must observe their owned peer cleanup and report the proven boundary. This test is prepared independently of the preceding policy-preview round. Root will stage only the completed round's explicit paths. The auto-sync hook merges and pushes through a separate main worktree, preserving future work in this source checkout.

## Actual OLD evidence

`go test . -run '^TestConnectorSingletonStartup' -count=1 -v` has exactly two intended RED and four passing controls in 11.092s. The bounded peer observes real Startup then stalls, or completes authentication/Prepare and observes Execute of the exact advisory-lock query then stalls. Each original call exceeds the two-second budget plus 500ms; only fixture parent cancellation unwinds it, with its original static error. This proves the acquisition wait, not merely a source pattern.

The controls verify parent cancellation at both phases, held-lock rejection with exactly one acquisition query and no heartbeat/stop, and successful acquisition with three actual one-second Pings beyond the acquisition deadline. Normal close does not cancel the parent. Tests use default pgx cache_statement protocol, explicit synthetic password, connect_timeout=0 and owned service/pass files. CancelRequest, Terminate/EOF, listener/socket/frame/worker joins are bounded. All owned singleton invocations, lifetime loops and peer resources close before handoff; immediate closure of every internal driver goroutine is not claimed.

## Implemented result and validation

`connectorSingleton` now creates one acquisition context with the existing two-second readiness budget, uses it for Connect/initial lock query/failed-acquisition Close, and cancels it on return. The lifetime lease still derives from the original root context. Existing lock identity, one-second heartbeat, stop callback, static errors and lifetime close remain; acquisition is never retried automatically.

- Fresh native scoped tests pass all six leaves in 9.742s, and minimum Go 1.24.13 passes the same six in 7.079s. Both actual stalled phases return in approximately two seconds. The three-heartbeat control proves a healthy lease survives the acquisition deadline. OLD artifacts remain preserved and the formal test is unchanged since OLD. All owned processes/loops/peer resources and the minimum-version container close.
- `go test ./... -count=1` passes all packages, main package 91.225s. `go vet ./...` passes.
- Full Linux Go 1.27 race checks pass, main package 200.755s. Gateway formatting, secret scan and diff checks pass.
- `node .test-artifacts/resilience/verify-connector.mjs` passes all nineteen actual private-TLS lifecycle/forwarding cases in 31.99s against the canonical-migration fixture, with separate Gateway and CLI processes. Its clients and processes close. This confirms normal acquisition does not break real connector pairing/discovery/streaming/attribution; the synthetic protocol tests separately exercise startup stalls.

TypeScript and UI behavior are unchanged; Round58's fresh compiler and 141 unit/contract checks remain applicable. No migration, model/routing policy, credential material, price or settlement rule changed. The startup budget is for singleton acquisition, not a promise that all Gateway initialization completes within two seconds.

Independent six-file read-only review is clear, including the prior task document's wording correction that distinguishes full native/race checks from scoped minimum-version checks. It verified context ownership, protocol evidence, cleanup, unchanged deployment boundaries and the documented limits. All verification processes and clients are closed. Git integration uses explicit-path commits and the separate-main-worktree automatic sync.
