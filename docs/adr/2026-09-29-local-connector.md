# Local connector transport

The remote Gateway routes project API keys to a computer running Ollama without inbound access to that computer. Channel, Connection, Project and the signed bundle remain authoritative. Subscription observation and subscription credentials are excluded.

## Protocol and trust

- An owner/admin configures a local_sidecar Connection's approved model IDs and project, and issues a ten-minute single-use pairing token. Only SHA-256 token hashes are stored. Re-pairing revokes the previous identity and lease.
- Pairing returns a random connector identity credential once. It creates/renews a 90-second lease. Identity rotation invalidates the previous credential and lease; the CLI must pair again after administrative rotation.
- The standalone Go connector uses authenticated outbound HTTPS long polls to the Gateway. Responses stream over separate outbound HTTPS uploads; cancellation uses a bounded wait endpoint. No URL, shell command or path crosses the dispatch interface. The local config pins a private literal IP, fixed OpenAI paths and explicit model IDs. Redirects and proxy environment variables are disabled for the local target.
- The Gateway reuses its existing Router and OpenAI adapter with a connector HTTP transport. It marks dispatch as potentially executed before delivery, forbidding replay after ambiguous failures. Existing v2 attribution/outbox/unknown-price semantics apply.
- Snapshot authorization alone has a revocation window. Connector dispatch adds a fail-closed live control-plane check of key, tenant, organization, active project, connection, channel, model and lease. This deliberately makes connector calls depend on control-plane availability; other transports retain their existing behavior.
- V1 requires a single Gateway endpoint for connector and inference traffic. A PostgreSQL advisory lock rejects a second enabled Gateway; loss of the lock connection stops this Gateway. Operators must not mix enabled/disabled replicas behind that endpoint.

## Interfaces

- `POST /api/connections/:id/connector`: owner/admin model configuration and one-time pairing credential; `GET` returns sanitized state.
- `POST /api/connector/pair`: exchange one-time token for bound identity.
- `POST /api/connector/lease`: identity-authenticated acquire/renew with reported ready models and existing lease token.
- `POST /api/internal/gateway/connector`: internal authenticated live authorization; accepts metadata only.
- `POST /connector/poll`, `POST /connector/result/:id`, `GET /connector/cancel/:id`: lease-authenticated Gateway transport.

## Verification

Disposable PostgreSQL migration and authorization tests; real independent Gateway and connector processes against mock Ollama; normal/SSE responses, model filtering, attribution and unknown pricing; bad pairing, replay, cross-project/tenant, fabricated heartbeat, expiration, revocation, disconnection, timeout, cancellation and truncated streams. Production TLS and single-instance constraints must be explicit and tested.
