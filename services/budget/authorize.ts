import type { Pool } from 'pg'
import { isBudgetRequest, type BudgetGrantV1 } from '../../packages/contracts/budget'
import { loadSaleSnapshot, loadExchangeRateSnapshot, computeChargeFromSnapshot, validateSaleSnapshotProvenance } from '@/lib/catalog/sale-snapshot'
import {
  ensureWalletLedgerAccount,
  ensureSystemLedgerAccount,
  getWalletBalance,
  postTransaction,
} from '@/lib/db/ledger'

export class BudgetError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code)
  }
}

/** Private accounting service: reservation only, never final usage or release. */
export async function authorizeBudget(pool: Pool, value: unknown): Promise<BudgetGrantV1> {
  if (!isBudgetRequest(value)) throw new BudgetError('invalid_request', 400)
  const input = value
  // Identifiers/estimates only; no model body or credential.
  const authorizationInput = input.attribution_context
    ? { ...input, attribution_context: Object.fromEntries(Object.entries(input.attribution_context).sort(([a], [b]) => a.localeCompare(b))) }
    : input
  const authorization = JSON.stringify(Object.fromEntries(Object.entries(authorizationInput).sort(([a], [b]) => a.localeCompare(b))))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='4000ms'")
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.tenant_id])
    const identity = await client.query(
      `SELECT k.id FROM downstream_api_keys k
      JOIN organizations o ON o.id=k.organization_id AND o.tenant_id=k.tenant_id
      WHERE k.id=$1 AND k.tenant_id=$2 AND k.organization_id=$3 AND k.enabled=true
        AND k.revoked_at IS NULL AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
        AND o.status='active' AND o.deleted_at IS NULL`,
      [input.key_id, input.tenant_id, input.organization_id],
    )
    if (!identity.rowCount) throw new BudgetError('unauthorized_identity', 403)
    const existing = await client.query(
      `SELECT l.id, l.description, r.status, r.reservation_amount,
        r.charge_currency, r.reservation_expires_at, r.reservation_released
      FROM ledger_transactions l LEFT JOIN request_records r ON r.id=l.reference_id AND r.tenant_id=l.tenant_id
      WHERE l.tenant_id=$1 AND l.idempotency_key=$2`,
      [input.tenant_id, `reservation:${input.request_id}`],
    )
    if (existing.rowCount) {
      const row = existing.rows[0]
      if (!row.status) throw new BudgetError('legacy_authorization_missing', 409)
      if (row.description !== authorization) throw new BudgetError('authorization_conflict', 409)
      if (
        row.status !== 'reserved' ||
        row.reservation_released ||
        new Date(row.reservation_expires_at).getTime() <= Date.now()
      )
        throw new BudgetError('authorization_expired', 409)
      await client.query('COMMIT')
      return {
        reservation_id: row.id,
        amount_micros: String(row.reservation_amount),
        currency: row.charge_currency,
        expires_at: new Date(row.reservation_expires_at).toISOString(),
        replayed: true,
      }
    }
    if (input.attribution_context) {
      try {
        await client.query('SELECT lock_budget_pricing_sources($1,$2,$3,$4,$5,$6,$7,$8,$9)', [input.tenant_id,input.organization_id,input.key_id,input.price_version_id,input.sale_price_snapshot_id,input.exchange_rate_snapshot_id,input.provider,input.model_id,input.currency])
      } catch (error) {
        if ((error as { code?: string }).code === 'P0001') throw new BudgetError('invalid_pricing_scope', 409)
        throw error
      }
    }
    const price = await client.query(
      `SELECT v.id,v.provider_id,v.currency FROM provider_price_versions v
      JOIN providers p ON p.id=v.provider_id WHERE v.id=$1 AND p.code=$2 AND p.enabled=true
        AND v.upstream_model_id=$3 AND v.status='active'
        AND (v.effective_from IS NULL OR v.effective_from<=now())
        AND (v.effective_to IS NULL OR v.effective_to>now())`,
      [input.price_version_id, input.provider, input.model_id],
    )
    if (!price.rowCount) throw new BudgetError('invalid_price_pin', 409)
    const sale = await loadSaleSnapshot(client, input.sale_price_snapshot_id)
    if (
      !sale ||
      sale.providerPriceVersionId !== input.price_version_id ||
      sale.exchangeRateSnapshotId !== input.exchange_rate_snapshot_id ||
      sale.currency !== input.currency ||
      sale.providerCurrency !== price.rows[0].currency
    )
      throw new BudgetError('invalid_sale_pin', 409)
    // Read ownership only, never mutable rule parameters.
    const owner = await client.query(
      `SELECT id FROM sale_price_rules WHERE id=$1 AND provider_id=$2
      AND upstream_model_id=$3 AND (tenant_id=$4 OR tenant_id IS NULL)
      AND (organization_id=$5 OR organization_id IS NULL)`,
      [sale.ruleId, price.rows[0].provider_id, input.model_id, input.tenant_id, input.organization_id],
    )
    if (!owner.rowCount) throw new BudgetError('unauthorized_sale_pin', 403)
    const rate = input.exchange_rate_snapshot_id
      ? await loadExchangeRateSnapshot(client, input.exchange_rate_snapshot_id)
      : null
    if (input.exchange_rate_snapshot_id && !rate) throw new BudgetError('invalid_exchange_pin', 409)
    try {
      validateSaleSnapshotProvenance(sale, rate, input.currency)
    } catch {
      throw new BudgetError('invalid_sale_provenance', 409)
    }
    const amount = computeChargeFromSnapshot(
      sale,
      { input: input.estimated_input_tokens, output: input.estimated_output_tokens, cached: 0, reasoning: 0 },
      rate,
      input.currency,
    ).saleCharge
    if (amount < 0n || amount > 9_223_372_036_854_775_807n) throw new BudgetError('invalid_hold', 409)
    const hold = amount > 0n ? amount : 1n
    const wallet = await client.query(
      `SELECT id FROM wallet_accounts WHERE tenant_id=$1 AND organization_id=$2
      AND currency=$3 AND status='active'`,
      [input.tenant_id, input.organization_id, input.currency],
    )
    if (!wallet.rowCount) throw new BudgetError('budget_exceeded', 429)
    if ((await getWalletBalance(input.tenant_id, wallet.rows[0].id, client)) < hold)
      throw new BudgetError('budget_exceeded', 429)
    const walletAccount = await ensureWalletLedgerAccount(input.tenant_id, wallet.rows[0].id, input.currency, client)
    const reserveAccount = await ensureSystemLedgerAccount(input.tenant_id, 'reservation', input.currency, client)
    const posted = await postTransaction(
      {
        tenantId: input.tenant_id,
        type: 'reservation',
        currency: input.currency,
        idempotencyKey: `reservation:${input.request_id}`,
        referenceType: 'request',
        referenceId: input.request_id,
        description: authorization,
        createdBy: input.key_id,
        postings: [
          { accountId: walletAccount, amount: hold, entryType: 'debit' },
          { accountId: reserveAccount, amount: hold, entryType: 'credit' },
        ],
      },
      client,
    )
    const expires = new Date(Date.now() + input.ttl_seconds * 1000)
    const capture = input.attribution_context
    await client.query(
      `INSERT INTO request_records(id,tenant_id,organization_id,downstream_key_id,request_model,
      resolved_provider_id,resolved_upstream_model_id,channel_kind,status,provider_price_version_id,
      sale_price_snapshot_id,exchange_rate_snapshot_id,charge_currency,reservation_amount,reservation_expires_at,idempotency_key)
      VALUES($1,$2,$3,$4,$14,$6,$5,'platform','reserved',$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.request_id,
        input.tenant_id,
        input.organization_id,
        input.key_id,
        input.model_id,
        price.rows[0].provider_id,
        input.price_version_id,
        input.sale_price_snapshot_id,
        input.exchange_rate_snapshot_id,
        input.currency,
        hold.toString(),
        expires,
        input.idempotency_key ?? `req:${input.request_id}`,
        capture?.requested_model ?? input.model_id,
      ],
    )
    if (capture) {
      try {
        await client.query(
        `INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,api_key_id,
          key_kind,principal_id,execution_mode,attribution_status,requested_model,streaming,catalog_version_id,policy_version_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'managed',$9,$10,$11,$12,$13)`,
        [input.request_id,input.tenant_id,input.organization_id,capture.project_id,capture.project_name,input.key_id,
          capture.key_kind,capture.principal_id,capture.attribution_status,capture.requested_model,capture.streaming,
          capture.catalog_version_id,capture.policy_version_id],
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'P0001') throw new BudgetError('invalid_attribution', 403)
        throw error
      }
    }
    await client.query('COMMIT')
    return {
      reservation_id: posted.id,
      amount_micros: hold.toString(),
      currency: input.currency,
      expires_at: expires.toISOString(),
      replayed: false,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if ((error as { code?: string }).code === '23505') throw new BudgetError('authorization_conflict', 409)
    throw error
  } finally {
    client.release()
  }
}
