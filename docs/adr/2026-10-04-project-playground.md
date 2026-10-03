# Project-authorized interactive Playground

Date: 2026-10-04. Decision: independently adapt browser chat through the existing Gateway.

## Problem and existing behavior

`/playground` is a static instruction to use an external client. The console already performs a fixed connector test through `/v1/chat/completions`, but it cannot test an arbitrary conversation or discover models with a project Key. Operators need to exercise project resource policy without configuring another client.

## Reference design and value

[AxonHub's Playground](https://github.com/looplj/axonhub/blob/89d36d610dc2ebf6d258e56bd1d051572a8c8449/internal/server/api/playground.go) reuses its orchestrator and scopes selection to a project. Nexus instead forwards to its existing Go Gateway with a user-supplied Nexus API Key. This belongs in the control plane as a governed resource diagnostic. Reject upstream body/error logging, direct-channel override, administrator inference credentials and automatic regenerate/retry. No third-party source is copied.

## Ownership, source of truth and write authority

Control Plane owns session/CSRF/project visibility and checks the Key's tenant/organization/project/lifetime/scopes before forwarding. Go Gateway retains final Key/model/policy/credential authorization, admission, Budget, execution and durable attempt/outbox authority. Worker retains pricing/usage/ledger authority. The console never decrypts provider or subscription credentials and cannot assert model availability independently of Gateway model discovery.

## Data model and API contract

No database additions. Introduce a bounded text-only Playground contract and `POST /api/playground/models` plus `POST /api/playground/chat`. Both accept explicit `projectId` and `apiKey` in a JSON body; neither puts secrets in URLs. Models forwards exactly one authorized `GET /v1/models`; chat forwards exactly one bounded `POST /v1/chat/completions` with text user/assistant messages, selected model, positive output limit and `stream:false`. Deliberately start with fully validated buffered replies; streaming can follow with its own content/framing contract. Unsupported tools, images, reasoning histories and extension parameters are rejected rather than discarded.

The browser can send multi-turn text, clear the conversation and cancel. Key/history/output exist only in component memory; project change, key replacement or unmount discards them. Display the real Gateway request ID and link it to recorded traces. Usage fields are nullable, and no price is fabricated. Empty/refusal/tool-only replies must be explicit; unsupported assistant data must not silently enter subsequent text history.

The response contract marks any assistant reasoning, tool-call or refusal fields (including present empty fields) as requiring a new conversation. Show the returned visible text/refusal and an explicit limitation, disable continuation, and require the user to clear history. Text-only messages with an ordinary complete finish may continue. Do not reconstruct reasoning or flatten refusal into ordinary assistant text. Use a strict scope string-array check and preserve the Gateway's existing explicit/prefix-wildcard operation matching semantics.

## Security boundary

Require the existing `apikey:create` capability for execution and model discovery, then project access and an active project, enabled organization and valid project-bound Nexus Key. Use the Key's exact hashed identity and actual chat/model scopes; Key permission is necessary even for an organization administrator. Viewer/billing read access is insufficient to execute. Existing `requireContext` enforces CSRF on both POSTs. Validate model authorization again in Go, including snapshot freshness and local live authorization.

Only an administrator-configured `NEXUS_GATEWAY_URL` (or the existing public Gateway base fallback) supplies the destination. Reject URL credentials, query/fragment ambiguity and non-HTTP(S); production requires HTTPS. Caller input cannot choose host/path/headers or request identity. Refuse redirects. Forward only Bearer authorization and JSON content type. Do not return raw upstream diagnostics or log user content/Key. Successful replies are intentional interactive content, not persisted trace content. Disable caching. Add metadata-only audit of dispatch intent if following existing mutation audit convention, never success claims before durable Gateway evidence.

Read identity with a scoped SQL query, not `verifyDownstreamKey` (which writes last-used/audit facts). Limit body bytes before JSON parsing and decoded response bytes during reading; Content-Length is not a safety boundary. Convert parse/network/output exceptions to fixed errors before `routeError`, whose generic exception logger must never receive syntax excerpts or user content. Explicit `Cache-Control: no-store` is required on all responses. A malformed 2xx still means inference may have executed; report uncertain delivery and never replay.

## Failure, concurrency and cancellation

Bound JSON input and Gateway output bytes and give forwarding a shared 60-second operation deadline composed with caller cancellation. Never retry an inference after timeout, failed body read, cancellation or uncertain execution. Closing/changing the UI aborts outstanding work; late results cannot update another conversation. A cancellation does not undo incurred usage. Distinguish explicit Gateway refusal from unknown delivery with fixed local error codes. Do not automatically include a failed/canceled user's pending turn in a later resend; user explicitly decides any new request.

## Compatibility, migration and rollback

Additive routes/UI; existing connector test and Gateway contracts remain unchanged. No new dependency or provider request parameter mapping. Outside Gateway hot path, bounded project/Key checks add a fixed number of queries only to console diagnostics. Roll back routes/UI without touching requests/ledger. No migration or credential enrollment is required.

## Testing strategy

Unit/contract tests cover request limits, strict text-only shape, URL policy, response shape and exact/unknown usage. Real disposable PostgreSQL plus real session/CSRF routes and a loopback HTTP Gateway fixture cover scope, expiry/revocation/archive, model/chat scope distinction, fixed errors, response bounds, cancellation, no replay, query/credential privacy and no Control Plane accounting writes. A separate real Go Gateway/mock provider fixture verifies that chat goes through ordinary durable attribution/outbox and Worker semantics. Browser E2E proves multi-turn response, pending/cancel state, key/project reset and links. Real paid-provider/model/account verification remains separate and is never claimed from mocks.
