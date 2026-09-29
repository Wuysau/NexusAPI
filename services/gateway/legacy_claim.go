package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const legacyBYOKClaimTimeout = 5 * time.Second

// LegacyBYOKClaim records request ownership before v1 BYOK dispatch when the
// caller explicitly asks for idempotency. It is not usage or a budget hold.
// Claims are never expired or released: after a crash, execution is uncertain.
type LegacyBYOKClaim struct {
	RequestID, TenantID, OrganizationID               string
	APIKeyID, RequestedModel, IdempotencyKey, TraceID string
	StartedAt                                         time.Time
}

type LegacyBYOKClaimer interface {
	ClaimLegacyBYOK(context.Context, *LegacyBYOKClaim) error
}

func (c *LegacyBYOKClaim) Validate() error {
	if c == nil || c.RequestID == "" || c.TenantID == "" || c.OrganizationID == "" ||
		c.APIKeyID == "" || c.RequestedModel == "" || strings.TrimSpace(c.IdempotencyKey) == "" ||
		c.IdempotencyKey != strings.TrimSpace(c.IdempotencyKey) || c.StartedAt.IsZero() {
		return errors.New("invalid legacy BYOK claim identity")
	}
	return nil
}

// Canonical attribution columns are named deliberately. An obsolete schema
// must fail before dispatch, not after execution when terminal guards need it.
const insertLegacyBYOKClaimSQL = `INSERT INTO request_records
(id,tenant_id,organization_id,downstream_key_id,request_model,idempotency_key,trace_id,started_at,
 channel_kind,status,project_id,project_name,connection_id,execution_mode,attribution_status)
SELECT $1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,'byok','created',NULL,NULL,NULL,NULL,NULL
WHERE to_regclass('public.request_project_facts') IS NOT NULL`

func (s *PostgresStore) ClaimLegacyBYOK(ctx context.Context, c *LegacyBYOKClaim) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if s.pool == nil {
		return ErrStoreUnavailable
	}
	// One autocommitted insert is the cross-process arbitration point. A
	// response/commit failure is ambiguous, so its caller must not dispatch.
	result, err := s.pool.Exec(ctx, insertLegacyBYOKClaimSQL, c.RequestID, c.TenantID, c.OrganizationID,
		c.APIKeyID, c.RequestedModel, c.IdempotencyKey, c.TraceID, c.StartedAt)
	if err != nil {
		return classifyCaptureError(err, func() (bool, error) {
			var sameScope bool
			err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM request_records WHERE tenant_id=$1 AND organization_id=$2 AND idempotency_key=$3)", c.TenantID, c.OrganizationID, c.IdempotencyKey).Scan(&sameScope)
			return sameScope, err
		})
	}
	if result.RowsAffected() != 1 {
		return ErrStoreUnavailable
	}
	return nil
}

func validateLegacyBYOKTerminal(r *TerminalRecord) error {
	if r.EventV2 != nil || r.AttributionContext != nil || r.ChannelKind != "byok" ||
		r.IdempotencyKey == "" || r.ChargeAmount != 0 || r.ReservationAmount != 0 ||
		r.ReservationExpiresAt != nil || r.ReservationReleased || orDefault(r.ChargeCurrency, "USD") != "USD" ||
		r.ProjectID != "" || r.ProjectName != "" || r.ConnectionID != "" || r.ExecutionMode != "" || r.AttributionStatus != "" {
		return ErrReservationConflict
	}
	return nil
}

// This branch updates only a v1 created BYOK claim. Keep the reserved managed
// authorization SQL and the v2 immutable-fact SQL separate and unchanged.
const completeLegacyBYOKClaimSQL = `UPDATE request_records r SET
 status=$6,resolved_provider_id=NULLIF($7,''),resolved_upstream_model_id=$8,provider_credential_id=NULLIF($9,''),
 input_tokens=$10,output_tokens=$11,cached_tokens=$12,reasoning_tokens=$13,
 provider_price_version_id=NULLIF($14,''),sale_price_snapshot_id=NULLIF($15,''),exchange_rate_snapshot_id=NULLIF($16,''),
 upstream_cost_amount=$17,upstream_cost_currency=$18,error_code=$19,error_message=$20,
 upstream_request_id=NULLIF($21,''),completed_at=$22
WHERE r.id=$1 AND r.tenant_id=$2 AND r.organization_id=$3 AND r.downstream_key_id=$4 AND r.request_model=$5
 AND r.idempotency_key=$23 AND r.started_at=$24 AND r.trace_id IS NOT DISTINCT FROM NULLIF($25,'')
 AND r.status='created' AND r.channel_kind='byok'
 AND r.charge_amount=0 AND r.charge_currency='USD' AND r.reservation_amount=0
 AND r.reservation_released=false AND r.reservation_expires_at IS NULL
 AND r.resolved_provider_id IS NULL AND r.resolved_upstream_model_id IS NULL AND r.provider_credential_id IS NULL
 AND r.provider_price_version_id IS NULL AND r.sale_price_snapshot_id IS NULL AND r.exchange_rate_snapshot_id IS NULL
 AND r.project_id IS NULL AND r.project_name IS NULL AND r.connection_id IS NULL
 AND r.execution_mode IS NULL AND r.attribution_status IS NULL
 AND NOT EXISTS(SELECT 1 FROM request_project_facts f WHERE f.request_id=r.id)`

func persistLegacyBYOKRequest(ctx context.Context, tx pgx.Tx, r *TerminalRecord) error {
	if err := validateLegacyBYOKTerminal(r); err != nil {
		return err
	}
	final, _ := r.FinalAttempt()
	result, err := tx.Exec(ctx, completeLegacyBYOKClaimSQL,
		r.RequestID, r.TenantID, r.OrganizationID, r.DownstreamKeyID, r.RequestModel, r.Status,
		r.ProviderID, r.ResolvedUpstreamModel, r.ProviderCredentialID,
		r.InputTokens, r.OutputTokens, r.CachedTokens, r.ReasoningTokens,
		r.ProviderPriceVersionID, r.SalePriceSnapshotID, r.ExchangeRateSnapshotID,
		final.UpstreamCostAmount, final.UpstreamCostCurrency, r.ErrorCode, r.ErrorDetail, r.UpstreamRequestID,
		r.CompletedAt, r.IdempotencyKey, r.StartedAt, r.TraceID)
	if err != nil {
		return ErrStoreUnavailable
	}
	if result.RowsAffected() != 1 {
		return ErrReservationConflict
	}
	return nil
}

func (m *MemoryStore) ClaimLegacyBYOK(ctx context.Context, c *LegacyBYOKClaim) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.unhealthy {
		return ErrStoreUnavailable
	}
	if _, exists := m.legacyClaims[c.RequestID]; exists {
		return ErrStoreUnavailable
	}
	if _, exists := m.capturedByID[c.RequestID]; exists {
		return ErrStoreUnavailable
	}
	if _, exists := m.terminalIDs[c.RequestID]; exists {
		return ErrStoreUnavailable
	}
	key := c.TenantID + "|" + c.IdempotencyKey
	if _, exists := m.legacyClaimKeys[key]; exists {
		return ErrDuplicateRequest
	}
	if _, exists := m.captured[key]; exists {
		return ErrDuplicateRequest
	}
	if _, exists := m.requests[key]; exists {
		return ErrDuplicateRequest
	}
	copy := *c
	m.legacyClaims[c.RequestID] = &copy
	m.legacyClaimKeys[key] = c.RequestID
	return nil
}

func (c *LegacyBYOKClaim) matches(r *TerminalRecord) bool {
	return c.RequestID == r.RequestID && c.TenantID == r.TenantID && c.OrganizationID == r.OrganizationID &&
		c.APIKeyID == r.DownstreamKeyID && c.RequestedModel == r.RequestModel && c.IdempotencyKey == r.IdempotencyKey &&
		c.StartedAt.Equal(r.StartedAt) && c.TraceID == r.TraceID
}
