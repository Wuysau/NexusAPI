# Open-source integration decisions

Research date: 2026-09-29. These are independently implemented design ideas; no third-party project source has been copied into NexusAPI.

| Primary source | Useful pattern | NexusAPI implementation |
| --- | --- | --- |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its [configuration](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml) | Compatible provider endpoint behind independently managed accounts | Existing gateway plus explicit proxy channel templates; provider authentication stays with the external service. |
| [CodexBar](https://github.com/steipete/CodexBar) and [dashboard-v1](https://github.com/steipete/CodexBar/blob/main/docs/dashboard-api.md) | Multiple quota windows, freshness and account-specific monitoring | Sanitized dashboard snapshot importer and configured read-only collector bridge; explicit account selection, expired/unknown state, no financial or routing authority. |
| [cc-switch](https://github.com/farion1231/cc-switch) | Clear provider setup and compatible endpoint presets | Capability-based product catalog and channel templates; no automatic rewriting of users' client configuration. |
| [New API](https://github.com/QuantumNous/new-api) | Separate plan catalog, orders and hosted checkout | Published server-side plans and Stripe PaymentProvider integrated into Billing, preserving NexusAPI's existing immutable ledger. |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | Account status and pooled capacity visibility | Per-product account counts and separate monitoring of healthy, near-limit, exhausted, disabled and unknown states. |

Repository licenses are governed by their own LICENSE files. Integration here is through documented protocols and original code; listing a project does not relicense its code. NexusAPI remains MIT. OAuth impersonation, copying browser cookies and treating subscription pools as unlimited API credits were not adopted.

## External contracts

- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment): complete orders via verified server callbacks, not browser redirects.
- [Stripe webhook signatures](https://docs.stripe.com/webhooks/signature): verify the original raw payload and timestamp; keep settlement idempotent.
- Provider-specific links are retained in `src/lib/subscriptions/catalog.ts` and the subscription coverage document. Source endpoints, product availability and limits may change; no current model prices are hardcoded into payment plans.

The scope is operational visibility and authorized access within the existing control plane. Collectors and payment merchant credentials must be configured by the operator. Automated mocked-protocol tests do not establish that every vendor account or a live merchant charge was exercised.
