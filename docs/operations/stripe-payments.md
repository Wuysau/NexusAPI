# Stripe hosted checkout operations

NexusAPI now supports Stripe hosted **one-time platform plan purchases**. This does not purchase a Claude/Codex/other upstream subscription or add managed wallet credits. A verified paid event posts clearing → revenue and activates the published plan for one month/year. Access expires at the recorded period end. There is no automatic renewal; buying another plan replaces current access immediately without proration or carrying over unused time. Only owner/admin/billing roles can purchase.

## Merchant configuration

Set server-only variables in the control-plane service environment (never `NEXT_PUBLIC_*`, browser storage, Git, or logs):

| Variable | Required value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Merchant `sk_test_…` or `sk_live_…` secret key |
| `STRIPE_WEBHOOK_SECRET` | Endpoint-specific `whsec_…` signing secret |
| `STRIPE_MODE` | Explicit `test` or `live`, matching the key and webhook events |
| `STRIPE_CHECKOUT_ORIGIN` | Fixed public origin such as `https://nexus.example`; HTTPS required except localhost/127.0.0.1 in test mode |

Configure these on the running control-plane container as well as your deployment secret store; merely editing a host env file does not inject undeclared Compose variables. Missing/inconsistent configuration disables checkout. Historical order metadata and the billing table retain test/live labels. **Use separate databases/deployments for test and live**: test webhooks exercise the same ledger and entitlement workflow; they are test evidence, not cash. Changing mode does not migrate existing orders. No actual merchant keys or charges were used during implementation validation.

Register `POST https://nexus.example/api/webhooks/payments/stripe` with snapshot events using API version `2025-02-24.acacia`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. The current purchase flow enables cards only. Preserve the exact raw body and `Stripe-Signature` header through any proxy. The server bounds the raw body to 1 MiB, authenticates HMAC-SHA256 with a 300-second clock-skew window, and checks mode, order, tenant, hosted session, amount and currency before settlement. Keep host time synchronized. Signing-secret rotation uses a coordinated update/retry; there is no multi-secret rollover setting.

The Checkout API request pins `2025-02-24.acacia`, disables Adaptive Pricing and adds no tax, discount, or shipping adjustments. Publish a final payable price consistent with your merchant/tax setup. Supported currencies are USD, EUR, GBP, CNY, HKD, SGD, AUD, CAD, CHF (two decimal places), JPY and KRW (zero decimal places). Conversion is exact integer arithmetic; fractional minor units, zero/negative prices, unsupported currencies and amounts above 99,999,999 minor units are rejected. Stripe additionally applies merchant/currency minimums and eligibility; the API fails closed if the merchant cannot accept the configured amount/currency.

## Publish an immutable plan

The catalog reads published plan versions; there are no default paid products or hardcoded prices. Choose your own prices and entitlements. Create a JSON file with this schema (replace placeholder strings with your actual values):

```json
{
  "code": "your-plan-code",
  "name": "Your plan name",
  "description": "Your plan description",
  "currency": "USD",
  "price": "YOUR_DECIMAL_PRICE",
  "interval": "month",
  "entitlements": [
    { "key": "members", "kind": "limit", "value": "YOUR_INTEGER_LIMIT" },
    { "key": "advanced_routing", "kind": "boolean", "value": true }
  ]
}
```

Allowed entitlement keys: `members`, `api_keys`, `byok_channels`, `audit_retention_days`, `advanced_routing`, `managed_credits`. Limits are integer strings; descriptions are optional. A `managed_credits` entitlement does not bypass the separate compliance/feature gates or expose a wallet top-up in this UI.

```powershell
# Preview/validate only; no database connection or payment.
npx tsx scripts/publish-billing-plan.ts path/to/your-plan.json
# Supply the intended operator database URL through your secure environment.
# This command intentionally publishes a NEW immutable version each time.
npx tsx scripts/publish-billing-plan.ts path/to/your-plan.json --publish
```

The script never automatically loads `.env.local`. `DATABASE_URL` must be explicitly present for `--publish`. An existing code gets a new version; its prior versions remain reconstructable for orders. The billing catalog shows the latest currently effective published version per plan. Failed validation/transactions publish nothing. Refresh Billing after publishing. Operators should retain the publish command output as the change record.

## Retry and reconciliation

Browser purchase calls `/api/billing/purchase` with a session cookie, CSRF token, plan version and stable purchase key. The server derives tenant, organization and actor, and rejects client amounts/providers/identity fields. A sessionStorage key survives refresh/return to prevent accidental repeated purchases in that tab. The deterministic Stripe idempotency key is tied to the immutable order, and the hosted URL is retained for retries. Ambiguous checkout creation can retry the same order for 23 hours; after that it requires operator reconciliation to avoid recreating a charge after Stripe prunes idempotency keys. Expired persisted sessions return no redirect. If the order is still pending/unknown, the UI retains its purchase key and asks for reconciliation; expiry alone never releases the key for a new purchase. Only a confirmed terminal order releases that browser key.

Neither returning to `/billing` nor a successful checkout-creation response marks an order paid. Refresh Orders to see verified settlement. Unpaid `checkout.session.completed` is ignored until confirmed paid. Duplicate delivery uses a locked order and deterministic ledger key; payment, ledger, subscription and outbox updates commit together. If a webhook races ahead of session persistence, it receives 409 and must retry; if processing fails, Stripe receives non-2xx. A late failure cannot regress a paid order.

Distinct paid plan orders use deterministic **server purchase creation precedence** (`created_at`, then order ID on exact ties), under a tenant subscription lock. Processor callback arrival order and second-resolution event timestamps do not decide which plan wins. A newer unpaid checkout does not block a paid one. If an older purchase is paid/delivered after a newer paid purchase, both payments remain recorded exactly once, the newer plan remains in force, and the older order is visibly marked for fulfillment/refund review with an open `subscription_payment_superseded` reconciliation case. Review the case's note for both order IDs; this deliberately does not discard the money or promise an automatic refund. Monthly/yearly access uses UTC calendar periods clamped to the target month's last day (January 31 → February 28/29; February 29 annual renewal → February 28).

For an unresolved pending order, inspect the matching Checkout session in Stripe and server order/event records, repair configuration/connectivity, and resend the original event through Stripe. Do not grant credits from a browser return or manually overwrite ledger postings. Retry with the original order/key; do not create new checkout attempts while processor outcome is unknown.

Automatic Stripe refunds intentionally return `refund_not_supported` and leave the order/ledger unchanged. Dashboard refunds, disputes and chargebacks are **not automatically reconciled**; an operator must track them and arrange reviewed compensating ledger/entitlement handling. Do not claim a refund completed merely because an API request was accepted. Recurring billing, coupons, tax automation, customer portal, prorations and managed-credit checkout remain outside this implementation.

## Verification and official references

Tests mock Stripe HTTP and signed events; integration runs against a disposable test database, never a live merchant or user database. The new integration suite refuses a database name without `test`/`ci`; all integration suites still require operator-selected disposable infrastructure.

- [Create Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create)
- [Webhook signatures and raw bodies](https://docs.stripe.com/webhooks/signature)
- [Stripe idempotency behavior](https://docs.stripe.com/api/idempotent_requests)
- [Currency minor-unit rules](https://docs.stripe.com/currencies)
- [Stripe's version-pinned generated API types](https://github.com/stripe/stripe-node/blob/v17.7.0/types/Checkout/SessionsResource.d.ts) and [matching API version](https://github.com/stripe/stripe-node/blob/v17.7.0/src/apiVersion.ts): `adaptive_pricing.enabled` is supported in `2025-02-24.acacia`; no SDK code was copied.
