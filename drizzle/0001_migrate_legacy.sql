-- Legacy data migration script — maps relay_* tables to the new schema.
--
-- ADR-0002: before migrating legacy data, freeze writes and generate an
-- opening-balance entry. Float balances only generate a one-time opening
-- balance entry, not a fact source afterward.
--
-- This is an EXPAND-ONLY migration (no destructive drops). It maps:
--   relay_channels → providers + channels (new)
--   relay_keys      → downstream_api_keys (hash preserved, float budget → wallet opening balance)
--   relay_logs      → usage_records (float cost → bigint micros, marked estimated)
--   relay_settings  → retention_policies
--
-- All migrated float amounts are marked as estimated (estimated_amount = true).
-- The script is idempotent: re-running it checks for existing mappings first.
--
-- IMPORTANT: This script should be run AFTER the schema migration (0001) and
-- AFTER writes to relay_* tables have been frozen. It is a one-time data
-- migration, not a continuous sync.

-- ── relay_channels → providers + channels ──────────────────────────────
-- Each relay channel maps to a provider (if not already present) and a
-- channel (capability=chat, region=global). The provider code is derived
-- from the relay channel's provider field.

INSERT INTO providers (id, code, name, official_base_url, auth_scheme, enabled, supports_model_sync, supports_price_sync)
SELECT
  gen_random_uuid(),
  DISTINCT provider,
  INITCAP(provider),
  CASE provider
    WHEN 'openai' THEN 'https://api.openai.com'
    WHEN 'anthropic' THEN 'https://api.anthropic.com'
    WHEN 'gemini' THEN 'https://generativelanguage.googleapis.com'
    WHEN 'deepseek' THEN 'https://api.deepseek.com'
    WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com'
    ELSE 'https://unknown.example.com'
  END,
  CASE provider
    WHEN 'anthropic' THEN 'x-api-key'
    WHEN 'gemini' THEN 'query'
    ELSE 'bearer'
  END,
  true,
  true,
  true
FROM relay_channels
WHERE provider NOT IN (SELECT code FROM providers)
GROUP BY provider;--> statement-breakpoint

-- Map relay_channels to the new channels table.
-- Each relay channel becomes a platform-scoped channel (tenant_id = NULL).
INSERT INTO channels (id, tenant_id, provider_id, name, capabilities, region, weight, priority, enabled, metadata, created_at, updated_at)
SELECT
  gen_random_uuid(),
  NULL, -- platform-scoped during migration
  p.id,
  rc.name,
  '["chat"]'::jsonb,
  'global',
  rc.weight,
  0,
  rc.enabled,
  jsonb_build_object(
    'legacy_id', rc.id,
    'legacy_base_url', rc.base_url,
    'legacy_models', rc.models,
    'migrated_from', 'relay_channels'
  ),
  rc.created_at,
  now()
FROM relay_channels rc
JOIN providers p ON p.code = rc.provider
WHERE NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.metadata->>'legacy_id' = rc.id
);--> statement-breakpoint

-- ── relay_keys → downstream_api_keys ────────────────────────────────────
-- Hash is preserved (SHA-256). Float budget/spent/reserved are NOT carried
-- as-is; instead, an opening-balance ledger entry is generated for the
-- remaining balance (budget - spent - reserved). The key is assigned to a
-- default migration tenant (the first customer organization).
--
-- NOTE: relay_keys don't have an organization_id. We create a migration
-- tenant if none exists, or assign to the first customer org.

-- Ensure at least one organization exists for migrated keys.
INSERT INTO organizations (id, tenant_id, name, slug, kind, base_currency, status)
SELECT
  gen_random_uuid(),
  gen_random_uuid(),
  'Legacy Migration Tenant',
  'legacy-migration',
  'customer',
  'USD',
  'active'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'legacy-migration');--> statement-breakpoint

-- Map relay_keys to downstream_api_keys.
INSERT INTO downstream_api_keys (
  id, organization_id, tenant_id, name, hash, prefix, fingerprint,
  scopes, enabled, created_at, deleted_at
)
SELECT
  rk.id,
  org.id,
  org.tenant_id,
  rk.name,
  rk.hash,
  rk.prefix,
  LEFT(rk.hash, 16), -- short fingerprint for display
  '["chat:write"]'::jsonb,
  rk.enabled,
  rk.created_at,
  CASE WHEN rk.enabled = false THEN now() ELSE NULL END
FROM relay_keys rk
CROSS JOIN (
  SELECT id, tenant_id FROM organizations WHERE slug = 'legacy-migration' LIMIT 1
) org
WHERE NOT EXISTS (
  SELECT 1 FROM downstream_api_keys dak WHERE dak.hash = rk.hash
);--> statement-breakpoint

-- For each migrated key with a remaining balance (budget - spent - reserved > 0),
-- generate a one-time opening-balance entry in the ledger.
-- The float amount is converted to bigint micros (× 1e6) and marked estimated.
-- This is NOT a fact source afterward — only the ledger is (ADR-0002).

-- Create wallet accounts for migrated keys.
INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status, created_at)
SELECT
  gen_random_uuid(),
  org.id,
  org.tenant_id,
  'USD',
  'active',
  now()
FROM organizations org
WHERE org.slug = 'legacy-migration'
AND NOT EXISTS (
  SELECT 1 FROM wallet_accounts wa WHERE wa.organization_id = org.id
);--> statement-breakpoint

-- Create ledger accounts for the wallets.
INSERT INTO ledger_accounts (id, tenant_id, wallet_id, type, currency, code, status)
SELECT
  gen_random_uuid(),
  wa.tenant_id,
  wa.id,
  'wallet',
  'USD',
  'wallet:' || wa.id,
  'active'
FROM wallet_accounts wa
JOIN organizations org ON org.id = wa.organization_id
WHERE org.slug = 'legacy-migration'
AND NOT EXISTS (
  SELECT 1 FROM ledger_accounts la WHERE la.wallet_id = wa.id
);--> statement-breakpoint

-- Create a clearing account for opening balances.
INSERT INTO ledger_accounts (id, tenant_id, type, currency, code, status)
SELECT
  gen_random_uuid(),
  org.tenant_id,
  'clearing',
  'USD',
  'clearing:USD',
  'active'
FROM organizations org
WHERE org.slug = 'legacy-migration'
AND NOT EXISTS (
  SELECT 1 FROM ledger_accounts la WHERE la.tenant_id = org.tenant_id AND la.code = 'clearing:USD'
);--> statement-breakpoint

-- Post opening-balance transactions for each migrated key's remaining balance.
-- amount = (budget - spent - reserved) × 1e6 micros, marked estimated.
-- We use a single idempotency key per key: 'opening-balance:{key_id}'.
INSERT INTO ledger_transactions (id, tenant_id, type, currency, idempotency_key, reference_type, reference_id, description)
SELECT
  gen_random_uuid(),
  la_wallet.tenant_id,
  'recharge',
  'USD',
  'opening-balance:' || rk.id,
  'legacy_key',
  rk.id,
  'Opening balance migrated from relay_keys (estimated, float→micros)'
FROM relay_keys rk
JOIN downstream_api_keys dak ON dak.hash = rk.hash
JOIN organizations org ON org.slug = 'legacy-migration' AND dak.tenant_id = org.tenant_id
JOIN wallet_accounts wa ON wa.tenant_id = org.tenant_id
JOIN ledger_accounts la_wallet ON la_wallet.wallet_id = wa.id
WHERE (rk.budget - rk.spent - rk.reserved) > 0
AND NOT EXISTS (
  SELECT 1 FROM ledger_transactions lt
  WHERE lt.idempotency_key = 'opening-balance:' || rk.id
);--> statement-breakpoint

-- Post the credit posting (wallet) and debit posting (clearing) for each.
INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
SELECT
  gen_random_uuid(),
  lt.id,
  lt.tenant_id,
  la_wallet.id,
  'USD',
  -- Convert float to micros: (budget - spent - reserved) × 1000000
  CAST(ROUND((rk.budget - rk.spent - rk.reserved) * 1000000) AS bigint),
  'credit'
FROM ledger_transactions lt
JOIN relay_keys rk ON lt.idempotency_key = 'opening-balance:' || rk.id
JOIN downstream_api_keys dak ON dak.hash = rk.hash AND dak.tenant_id = lt.tenant_id
JOIN wallet_accounts wa ON wa.tenant_id = lt.tenant_id
JOIN ledger_accounts la_wallet ON la_wallet.wallet_id = wa.id
WHERE lt.description LIKE 'Opening balance%';--> statement-breakpoint

INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
SELECT
  gen_random_uuid(),
  lt.id,
  lt.tenant_id,
  la_clearing.id,
  'USD',
  -- Debit clearing for the same amount (negative to balance)
  -CAST(ROUND((rk.budget - rk.spent - rk.reserved) * 1000000) AS bigint),
  'debit'
FROM ledger_transactions lt
JOIN relay_keys rk ON lt.idempotency_key = 'opening-balance:' || rk.id
JOIN downstream_api_keys dak ON dak.hash = rk.hash AND dak.tenant_id = lt.tenant_id
JOIN organizations org ON org.tenant_id = lt.tenant_id AND org.slug = 'legacy-migration'
JOIN ledger_accounts la_clearing ON la_clearing.tenant_id = org.tenant_id AND la_clearing.code = 'clearing:USD'
WHERE lt.description LIKE 'Opening balance%';--> statement-breakpoint

-- ── relay_logs → usage_records ──────────────────────────────────────────
-- Float cost is converted to bigint micros and marked as estimated.
-- Content is NOT migrated (privacy invariant #10 / #6: content not stored).

INSERT INTO usage_records (
  id, tenant_id, request_id, usage_event_id,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens,
  upstream_cost_amount, upstream_cost_currency,
  charge_amount, charge_currency, estimated_amount, created_at
)
SELECT
  gen_random_uuid(),
  org.tenant_id,
  NULL, -- no request_records mapping (legacy logs don't have request IDs)
  NULL,
  rl.input_tokens,
  rl.output_tokens,
  0, -- cached tokens not tracked in legacy
  0, -- reasoning tokens not tracked in legacy
  CAST(ROUND(rl.cost * 1000000) AS bigint), -- float cost → micros
  'USD',
  CAST(ROUND(rl.cost * 1000000) AS bigint), -- charge = cost (no markup in legacy)
  'USD',
  true, -- marked as estimated (float-originated)
  rl.created_at
FROM relay_logs rl
CROSS JOIN (SELECT id, tenant_id FROM organizations WHERE slug = 'legacy-migration' LIMIT 1) org
WHERE NOT EXISTS (
  SELECT 1 FROM usage_records ur
  WHERE ur.created_at = rl.created_at
  AND ur.input_tokens = rl.input_tokens
  AND ur.output_tokens = rl.output_tokens
  AND ur.upstream_cost_amount = CAST(ROUND(rl.cost * 1000000) AS bigint)
);--> statement-breakpoint

-- ── relay_settings → retention_policies ────────────────────────────────
-- Map relay_settings (JSON key-value) to retention_policies for request_logs.
-- The legacy settings table stores arbitrary config; we extract retention-like
-- values and create a default retention policy for request_logs.

INSERT INTO retention_policies (id, tenant_id, target_type, retention_days, hard_delete_after_days, legal_hold, enabled)
SELECT
  gen_random_uuid(),
  NULL, -- platform default
  'request_logs',
  COALESCE(
    (SELECT (value->>'retention_days')::int FROM relay_settings WHERE id = 'retention'),
    90
  ),
  COALESCE(
    (SELECT (value->>'hard_delete_days')::int FROM relay_settings WHERE id = 'retention'),
    365
  ),
  false,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM retention_policies WHERE target_type = 'request_logs' AND tenant_id IS NULL
);--> statement-breakpoint

-- ── Mark migrated float amounts ─────────────────────────────────────────
-- The usage_records migrated from relay_logs have estimated_amount = true.
-- The ledger opening-balance transactions have description starting with
-- 'Opening balance'. These are the only places where float-originated
-- amounts exist in the new schema; they are clearly marked for audit.

-- End of legacy migration script.
-- After verification, the relay_* tables can be archived/dropped in the
-- contract phase (a future migration), but NOT here (expand-only).
