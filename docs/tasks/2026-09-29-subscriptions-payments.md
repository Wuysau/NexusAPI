# Subscription coverage, pool monitoring and real checkout

Status: complete

## Design and intended outcome

Preserve NexusAPI's project-centric control plane and existing navigation. Extend Connections with a capability-based subscription catalog and onboarding. Extend Resources with account-pool health derived from actual connection/quota facts. Extend Billing with published plans, Stripe hosted checkout, order status and verified settlement. No browser return may grant credit. No subscription credential is repurposed as a universal API credential.

The user explicitly authorizes autonomous design and implementation without further confirmation. Implementation runs in the existing public main checkout; the private development checkout and its uncommitted edits remain untouched.

## Decisions

- Reuse existing channels/protocol adapters for authorized Coding Plan API keys and independently operated compatible proxy endpoints. OAuth-only services get native/observation guidance and explicit capability limits, never fictional gateway readiness.
- Catalog covers Codex, Claude Code, Gemini/Google AI, GitHub Copilot, Cursor, Windsurf, Kiro, JetBrains AI, Trae, Qwen Code, Kimi, GLM/Z.ai, MiniMax, Alibaba Bailian, Volcengine, Tencent, DeepSeek, Grok and Perplexity where applicable. Verify official sources; no hardcoded current prices or unverified quota endpoints.
- Pool readiness separates revoked, disabled, unknown, stale, exhausted and healthy states. A missing or expired observation is never an unlimited account. Show reset time and source. Do not rotate accounts to defeat provider limits.
- Stripe Checkout uses server-side published plan amount, exact integer currency conversion, idempotency, signed raw-body webhooks with timestamp checks and amount/currency/order verification. No payment secrets enter browser responses. Test/live modes are explicit. Merchant credentials remain operator-supplied.
- Third-party code is not copied: independently implement ideas from CLIProxyAPI (MIT), CodexBar (MIT), cc-switch (MIT), Sub2API/New API (inspect respective licenses). Existing gateway remains separate from control plane.

## Implementation plan

Uses writing-plans and dispatching-parallel-agents skills. Independent implementation boundaries:

1. Payments: `src/lib/payments`, `src/lib/orders`, billing purchase routes/component; tests for signatures, replay, wrong amount/currency, checkout retries and tenant/role enforcement. Existing ledger settlement remains authoritative.
2. Subscriptions: catalog, connections API/page and onboarding; tests for supported products, unknown IDs, no credential acceptance and truthful capability labels. Existing Codex behavior remains compatible.
3. Pool monitoring and gateway onboarding: `src/lib/resources`, resource page, channel presets/proxy guidance; tests for stale/exhausted/unknown and tenant scope. No probing or credentials copied from local subscription clients.
4. Documentation and integration: user manual, operational setup, research provenance; run unit/contract/typecheck/lint/build and disposable integration tests. Browser verify onboarding and billing configuration states. Commit/push only after verification.

## Acceptance and review focus

- [x] Existing Codex connection and account sync retain behavior.
- [x] Non-Codex subscriptions can be registered with honest documented capabilities and useful setup steps.
- [x] Account pool shows quota freshness, exhaustion/reset, and usable/unknown counts without conflating local tokens and subscription quota.
- [x] Real Stripe checkout works against mocked processor contract and fails closed without merchant configuration; forged/stale callbacks and duplicate credits rejected.
- [x] Browser cannot override prices, currency, tenant or grant credit via redirect.
- [x] Existing project/channel/billing UI remains recognizable; documentation explains production setup and provider limitations.

## Rollout and rollback

Additive capability catalog and payment adapter. Stripe remains unavailable until environment configured. No automatic purchases, real charges, provider login or destructive data migration. Roll back code to disable new checkout; keep settled ledger immutable. Integration tests use disposable PostgreSQL, never the user's development database.

## Evidence

Verified locally on 2026-09-29:

- Unit: 387 tests in 46 files; contract: 261 tests in 24 files.
- Integration: 401 tests in 35 files; security: 49 tests in 5 files. Schema-resetting suites used disposable PostgreSQL on port 55439 and Redis on port 56381, not the development database.
- Production build, TypeScript/ESLint, formatting, secret scan and whitespace checks passed.
- Authenticated browser inspection covered Resources pool/source labels, Billing's unconfigured merchant state, the 19-product subscription selector, Claude API onboarding and CLIProxyAPI template selection. Existing development data remained intact; browser forms were cancelled without creating orders or connections.
- Independent payment review fixed expired-checkout retry keys, reversed payment delivery precedence, month-end/leap-year entitlement expiry and concurrent ledger account initialization. Monitor review added seven real-database authorization/persistence tests and prevented non-admin shared collector reads.

Coverage is capability-based: 19 catalog products, native Codex observation and 14 additional explicit CodexBar provider mappings. External observation is separately labeled and does not authorize gateway routing or spend. No live merchant charge, provider account login, external collector deployment or universal native provider support is claimed. Recurring billing, automatic refunds, disputes and tax automation remain outside this release; operational setup and limitations are documented.
