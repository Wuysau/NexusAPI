# Capability-based subscription access and hosted checkout

Status: Accepted

## Context

NexusAPI currently observes Codex and exposes sandbox payments. Users need broader subscription visibility and a real gateway billing flow without changing the control/data-plane boundary.

## Decision

Subscription products declare registration, native observation and authorized API capabilities separately. Provider subscription credentials remain in their supported authentication environment. Compatible API/proxy channels use the existing encrypted secret plane and gateway adapters. Account-pool health is derived from scoped connection and quota records, never estimated from local token totals.

Stripe is a PaymentProvider implementation using hosted Checkout. Only a verified callback can settle the existing immutable order and append ledger entries. Browser-created orders derive tenant, organization and actor from the authenticated session and price from a published plan version. Callback verification uses raw request body and bounded timestamp, with exact amount/currency matching and existing idempotent ledger keys. Test and live modes must remain visible.

## Consequences

Services without a supported public interface are represented truthfully with setup guidance rather than synthetic quotas or unauthorized protocol impersonation. Real settlement requires operator merchant credentials and reachable webhook configuration. Payment adapter tests do not prove a live charge. Provider prices and customer secrets are not baked into the catalog.
