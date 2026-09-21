// Dev-only demo data for the NexusAPI control plane.
//
// HARD GATE: this script refuses to run when NODE_ENV=production. Demo data
// must never reach a production database, and the application itself no longer
// seeds on request (the legacy `seed()` call was removed from /api/admin in
// Work Item H).
//
// It is idempotent: every insert is ON CONFLICT DO NOTHING / DO UPDATE against
// a fixed id, so re-running is safe.
//
// Usage:  node scripts/seed-dev.mjs
// Account names are printed at the end; passwords are never logged.

import { randomBytes, scryptSync, createHash } from 'node:crypto'
import pg from 'pg'

if (process.env.NODE_ENV === 'production') {
  console.error('[seed-dev] refusing to run with NODE_ENV=production')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('[seed-dev] DATABASE_URL is required')
  process.exit(1)
}

const SCRYPT_N = 1 << 14
const SCRYPT_R = 8
const SCRYPT_P = 1

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const OWNER_EMAIL = (process.env.DEV_ADMIN_EMAIL || 'dev@nexus.local').toLowerCase()
const OWNER_PASSWORD = process.env.DEV_ADMIN_PASSWORD
const VIEWER_EMAIL = (process.env.DEV_VIEWER_EMAIL || 'viewer@nexus.local').toLowerCase()
const VIEWER_PASSWORD = process.env.DEV_VIEWER_PASSWORD
if (!OWNER_PASSWORD || !VIEWER_PASSWORD) throw new Error('DEV_ADMIN_PASSWORD and DEV_VIEWER_PASSWORD are required')

const TENANT = 'tenant-dev'
const ORG = 'org-dev'
const PLATFORM_ORG = 'org-platform'
const OWNER_ID = 'user-dev-owner'
const VIEWER_ID = 'user-dev-viewer'
const WALLET = 'wallet-dev'

const PROVIDERS = [
  { code: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', models: 'https://api.openai.com/v1/models' },
  { code: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com/v1', models: null },
  {
    code: 'gemini',
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: 'https://generativelanguage.googleapis.com/v1beta/models',
  },
  { code: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', models: 'https://api.deepseek.com/models' },
  {
    code: 'qwen',
    name: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: null,
  },
]

const MODELS = [
  { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', ctx: 128000, input: '2.50000000', output: '10.00000000' },
  {
    provider: 'openai',
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    ctx: 128000,
    input: '0.15000000',
    output: '0.60000000',
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    ctx: 200000,
    input: '3.00000000',
    output: '15.00000000',
  },
  {
    provider: 'gemini',
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    ctx: 1000000,
    input: '0.30000000',
    output: '2.50000000',
  },
  {
    provider: 'deepseek',
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    ctx: 64000,
    input: '0.27000000',
    output: '1.10000000',
  },
  {
    provider: 'deepseek',
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    ctx: 64000,
    input: '0.55000000',
    output: '2.19000000',
  },
  { provider: 'qwen', id: 'qwen-plus', name: '通义千问 Plus', ctx: 128000, input: '0.40000000', output: '1.20000000' },
]

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
const q = (sql, params = []) => client.query(sql, params)

async function main() {
  await client.connect()

  // ── Identity ────────────────────────────────────────────────────────
  await q(
    `INSERT INTO organizations (id, tenant_id, name, slug, kind, base_currency, status)
     VALUES ($1,$2,$3,$4,'platform','USD','active'), ($5,$6,$7,$8,'customer','USD','active')
     ON CONFLICT (id) DO NOTHING`,
    [
      PLATFORM_ORG,
      'tenant-platform',
      'NexusAPI Platform',
      'nexus-platform',
      ORG,
      TENANT,
      '开发工作空间',
      'dev-workspace',
    ],
  )
  await q(
    `INSERT INTO users (id, email, password_hash, name, status) VALUES
       ($1,$2,$3,'开发管理员','active'),
       ($4,$5,$6,'只读观察者','active')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID, OWNER_EMAIL, hashPassword(OWNER_PASSWORD), VIEWER_ID, VIEWER_EMAIL, hashPassword(VIEWER_PASSWORD)],
  )
  await q(
    `INSERT INTO organization_memberships (id, organization_id, tenant_id, user_id, role) VALUES
       ('mem-dev-owner', $1, $2, $3, 'owner'),
       ('mem-dev-viewer', $1, $2, $4, 'viewer')
     ON CONFLICT (id) DO NOTHING`,
    [ORG, TENANT, OWNER_ID, VIEWER_ID],
  )

  // ── Providers ───────────────────────────────────────────────────────
  for (const p of PROVIDERS) {
    await q(
      `INSERT INTO providers (id, code, name, official_base_url, models_endpoint, auth_scheme, enabled, supports_model_sync, supports_price_sync)
       VALUES ($1,$2,$3,$4,$5,'bearer',true,$6,true)
       ON CONFLICT (id) DO NOTHING`,
      [`prov-${p.code}`, p.code, p.name, p.url, p.models, Boolean(p.models)],
    )
  }

  // ── Catalog: upstream models + ACTIVE price versions + components ────
  for (const m of MODELS) {
    await q(
      `INSERT INTO upstream_models (id, provider_id, upstream_model_id, display_name, context_window, max_output_tokens,
                                     capabilities, lifecycle_status, available, raw_metadata)
       VALUES ($1,$2,$3,$4,$5,8192,'["chat","tools"]'::jsonb,'active',true,'{"demo":true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [`um-${m.id}`, `prov-${m.provider}`, m.id, m.name, m.ctx],
    )
    await q(
      `INSERT INTO provider_price_versions (id, provider_id, upstream_model_id, currency, region, service_tier,
                                             input_price, output_price, unit, source_type, source_url, status, effective_from, fetched_at)
       VALUES ($1,$2,$3,'USD','global','default',$4,$5,'per_million_tokens','official_api',$6,'active', now() - interval '1 day', now())
       ON CONFLICT (id) DO NOTHING`,
      [`pv-${m.id}-1`, `prov-${m.provider}`, m.id, m.input, m.output, `https://example.invalid/pricing/${m.id}`],
    )
    await q(
      `INSERT INTO price_components (id, price_version_id, kind, unit, amount)
       VALUES ($1,$2,'input','per_million_tokens',$3), ($4,$2,'output','per_million_tokens',$5)
       ON CONFLICT (id) DO NOTHING`,
      [`pcomp-${m.id}-in`, `pv-${m.id}-1`, m.input, `pcomp-${m.id}-out`, m.output],
    )
  }

  // ── A pending price candidate (something for the approval screen) ────
  await q(
    `INSERT INTO price_sources (id, provider_id, upstream_model_id, source_type, source_url, content_sha256, parser_version, region, currency)
     VALUES ('ps-gpt-4o-2','prov-openai','gpt-4o','official_api','https://example.invalid/pricing/gpt-4o',$1,'nexus-price-parser@1','global','USD')
     ON CONFLICT (id) DO NOTHING`,
    [sha256('demo-price-source')],
  )
  await q(
    `INSERT INTO provider_price_versions (id, provider_id, upstream_model_id, currency, region, service_tier,
                                           input_price, output_price, unit, source_type, source_url, status, fetched_at)
     VALUES ('pv-gpt-4o-2','prov-openai','gpt-4o','USD','global','default','2.75000000','11.00000000','per_million_tokens','official_api','https://example.invalid/pricing/gpt-4o','pending', now())
     ON CONFLICT (id) DO NOTHING`,
  )
  await q(
    `INSERT INTO price_candidates (id, provider_id, upstream_model_id, price_source_id, currency, region, status, high_risk_flag, risk_reasons)
     VALUES ('pc-gpt-4o-2','prov-openai','gpt-4o','ps-gpt-4o-2','USD','global','pending_approval',false,'[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  )
  await q(
    `INSERT INTO price_components (id, price_version_id, price_candidate_id, kind, unit, amount)
     VALUES ('pcomp-gpt-4o-2-in','pv-gpt-4o-2','pc-gpt-4o-2','input','per_million_tokens','2.75000000'),
            ('pcomp-gpt-4o-2-out','pv-gpt-4o-2','pc-gpt-4o-2','output','per_million_tokens','11.00000000')
     ON CONFLICT (id) DO NOTHING`,
  )

  // ── Platform channels (no credential: deployment supplies the upstream secret) ──
  for (const p of PROVIDERS) {
    await q(
      `INSERT INTO channels (id, tenant_id, provider_id, provider_credential_id, name, capabilities, region, weight, priority, enabled)
       VALUES ($1, NULL, $2, NULL, $3, '["chat"]'::jsonb, 'global', 10, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [`chan-${p.code}`, `prov-${p.code}`, `${p.name} 官方渠道`],
    )
  }

  // ── Wallet + double-entry opening balance ───────────────────────────
  await q(
    `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
     VALUES ($1,$2,$3,'USD','active') ON CONFLICT (id) DO NOTHING`,
    [WALLET, ORG, TENANT],
  )
  await q(
    `INSERT INTO ledger_accounts (id, tenant_id, wallet_id, type, currency, code, status) VALUES
       ('acct-dev-wallet',$1,$2,'wallet','USD','wallet:USD','active'),
       ('acct-dev-promo',$1,NULL,'promotional','USD','promotional:USD','active')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT, WALLET],
  )
  const rechargeMicros = '250000000' // 250.000000 USD
  await q(
    `INSERT INTO ledger_transactions (id, tenant_id, type, currency, idempotency_key, reference_type, description, created_by)
     VALUES ('ltx-dev-recharge',$1,'promotional_credit','USD','demo:recharge:1','adjustment','开发环境初始额度',$2)
     ON CONFLICT (id) DO NOTHING`,
    [TENANT, OWNER_ID],
  )
  await q(
    `INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type) VALUES
       ('lp-dev-recharge-wallet','ltx-dev-recharge',$1,'acct-dev-wallet','USD',$2,'credit'),
       ('lp-dev-recharge-promo','ltx-dev-recharge',$1,'acct-dev-promo','USD',$3,'debit')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT, rechargeMicros, `-${rechargeMicros}`],
  )
  await q(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, type, amount, balance_after, reference_type, reference_id, idempotency_key, created_by)
     VALUES ('wle-dev-recharge',$1,'promotional_credit',$2,$2,'adjustment','ltx-dev-recharge','demo:recharge:1',$3)
     ON CONFLICT (id) DO NOTHING`,
    [WALLET, rechargeMicros, OWNER_ID],
  )

  // ── Demo downstream key + request history ──────────────────────────
  await q(
    `INSERT INTO downstream_api_keys (id, organization_id, tenant_id, name, hash, prefix, fingerprint, scopes, enabled)
     VALUES ('key-demo-production',$1,$2,'Production Key',$3,'sk-nx-demo••••0001','demo-fingerprint','["chat:write","models:read"]'::jsonb,true)
     ON CONFLICT (id) DO NOTHING`,
    [ORG, TENANT, sha256(`demo-${randomBytes(8).toString('hex')}`)],
  )

  const demoRequests = [
    {
      id: 'req-demo-0001',
      model: 'gpt-4o',
      provider: 'openai',
      in: 1284,
      out: 512,
      charge: '45000',
      cost: '18000',
      status: 'completed',
    },
    {
      id: 'req-demo-0002',
      model: 'deepseek-chat',
      provider: 'deepseek',
      in: 3021,
      out: 890,
      charge: '12600',
      cost: '4200',
      status: 'completed',
    },
    {
      id: 'req-demo-0003',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      in: 2044,
      out: 733,
      charge: '98000',
      cost: '39000',
      status: 'completed',
    },
    {
      id: 'req-demo-0004',
      model: 'gemini-2.5-flash',
      provider: 'gemini',
      in: 990,
      out: 410,
      charge: '7200',
      cost: '2400',
      status: 'failed',
    },
  ]
  for (const r of demoRequests) {
    await q(
      `INSERT INTO request_records (id, organization_id, tenant_id, downstream_key_id, request_model, resolved_provider_id,
                                    resolved_upstream_model_id, channel_kind, status, input_tokens, output_tokens,
                                    charge_amount, charge_currency, cost_in_charge_currency, gross_margin_amount, gross_margin_rate,
                                    reservation_amount, reservation_released, idempotency_key, started_at, completed_at)
       VALUES ($1,$2,$3,'key-demo-production',$4,$5,$4,'platform',$6,$7,$8,$9,'USD',$10,$11,'0.60000000',0,true,$12, now() - interval '2 hours', now() - interval '2 hours')
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        ORG,
        TENANT,
        r.model,
        `prov-${r.provider}`,
        r.status,
        r.in,
        r.out,
        r.charge,
        r.cost,
        String(Number(r.charge) - Number(r.cost)),
        `demo:${r.id}`,
      ],
    )
    await q(
      `INSERT INTO usage_records (id, tenant_id, request_id, input_tokens, output_tokens, upstream_cost_amount, upstream_cost_currency, charge_amount, charge_currency)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,'USD')
       ON CONFLICT (id) DO NOTHING`,
      [`ur-${r.id}`, TENANT, r.id, r.in, r.out, r.cost, r.charge],
    )
  }

  await q(
    `INSERT INTO audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ('ae-demo-seed',$1,$2,'dev.seeded','organization',$3,'{"demo":true}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [TENANT, OWNER_ID, ORG],
  )

  console.log('[seed-dev] demo data ready')
  console.log(`  owner:  ${OWNER_EMAIL}  (role owner)`)
  console.log(`  viewer: ${VIEWER_EMAIL}  (role viewer)`)
  console.log('  Sign in with the passwords configured in your local environment.')
  console.log(`  tenant: ${TENANT}`)
}

main()
  .catch((error) => {
    console.error('[seed-dev] failed:', error.message)
    process.exitCode = 1
  })
  .finally(() => client.end().catch(() => {}))
