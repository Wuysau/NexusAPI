package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"time"
)

// RequestAttributionContext contains only request identity. Retry-specific
// connection, credential and price pins belong to the attempt/event.
type RequestAttributionContext struct {
	ProjectID         *string `json:"project_id"`
	ProjectName       *string `json:"project_name"`
	APIKeyID          string  `json:"api_key_id"`
	KeyKind           string  `json:"key_kind"`
	PrincipalID       *string `json:"principal_id"`
	AttributionStatus string  `json:"attribution_status"`
	RequestedModel    string  `json:"requested_model"`
	Streaming         bool    `json:"streaming"`
	CatalogVersionID  string  `json:"catalog_version_id"`
	PolicyVersionID   *string `json:"policy_version_id"`
}

func cloneString(v *string) *string {
	if v == nil {
		return nil
	}
	x := *v
	return &x
}
func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func validV2Routing(candidate Candidate, model *SnapshotModel) bool {
	var price any
	if candidate.Price != nil {
		price = candidate.Price.ID
	}
	if validateUsageV2Node(usageV2Schema.Properties["price_version_id"], price, "price_version_id") != nil {
		return false
	}
	if price == nil && candidate.Channel.CredentialMode != "byok" {
		return false
	}

	for key, value := range map[string]string{"model_id": model.ID, "resolved_model": model.ID, "provider_id": candidate.Channel.ProviderID} {
		if validateUsageV2Node(usageV2Schema.Properties[key], value, key) != nil {
			return false
		}
	}
	for key, value := range map[string]string{"channel_id": candidate.Channel.ID, "credential_id": candidate.Channel.CredentialRef, "connection_id": candidate.Channel.ConnectionID} {
		if validateUsageV2Node(usageV2Schema.Properties["attribution"].Properties[key], value, key) != nil {
			return false
		}
	}
	return true
}

func requestAttribution(identity *Identity, bundle *GatewayBundle, req *chatRequest) *RequestAttributionContext {
	c := &RequestAttributionContext{ProjectID: nullableString(identity.ProjectID), ProjectName: nullableString(identity.ProjectName), APIKeyID: identity.KeyID, KeyKind: identity.KeyKind, PrincipalID: cloneString(identity.PrincipalID), AttributionStatus: identity.AttributionStatus, RequestedModel: req.Model, Streaming: req.Stream != nil && *req.Stream}
	if bundle.Snapshot.CatalogVersion != nil {
		c.CatalogVersionID = bundle.Snapshot.CatalogVersion.ID
	}
	if model, ok := bundle.ResolveModel(req.Model); ok {
		for _, policy := range bundle.Snapshot.RoutingPolicies {
			for _, route := range policy.ModelRoutes {
				if route.ModelID == model.ID && route.Priority != nil {
					c.PolicyVersionID = nullableString(policy.ID)
					return c
				}
			}
		}
	}
	return c
}

func (c *RequestAttributionContext) Validate() error {
	if c == nil || c.APIKeyID == "" || c.RequestedModel == "" || c.CatalogVersionID == "" {
		return errors.New("incomplete request attribution")
	}
	if c.AttributionStatus != "attributed" && c.AttributionStatus != "unattributed" {
		return errors.New("unknown project attribution")
	}
	if (c.AttributionStatus == "attributed") != (c.ProjectID != nil && *c.ProjectID != "") {
		return errors.New("invalid project attribution")
	}
	if c.ProjectID == nil && c.ProjectName != nil {
		return errors.New("project name without identity")
	}
	if c.KeyKind != "shared" && c.KeyKind != "personal" && c.KeyKind != "service" {
		return errors.New("unknown key kind")
	}
	if c.KeyKind == "shared" && c.PrincipalID != nil {
		return errors.New("shared key principal must be null")
	}
	// Reuse the same canonical vocabulary before dispatch as at terminal time.
	projection := map[string]any{"project_id": c.ProjectID, "project_name": c.ProjectName, "api_key_id": c.APIKeyID, "key_kind": c.KeyKind, "principal_id": c.PrincipalID, "attribution_status": c.AttributionStatus, "connection_id": nil, "credential_id": nil, "channel_id": nil, "execution_mode": "byok"}
	raw, _ := json.Marshal(projection)
	var value any
	_ = json.Unmarshal(raw, &value)
	if err := validateUsageV2Node(usageV2Schema.Properties["attribution"], value, "attribution_context"); err != nil {
		return err
	}
	for key, value := range map[string]any{"requested_model": c.RequestedModel, "catalog_version_id": c.CatalogVersionID, "policy_version_id": c.PolicyVersionID} {
		raw, _ := json.Marshal(value)
		var normalized any
		_ = json.Unmarshal(raw, &normalized)
		if err := validateUsageV2Node(usageV2Schema.Properties[key], normalized, "attribution_context."+key); err != nil {
			return err
		}
	}
	return nil
}

type FrozenRequest struct {
	RequestID, TenantID, OrganizationID, IdempotencyKey, TraceID string
	StartedAt                                                    time.Time
	Attribution                                                  RequestAttributionContext
}
type RequestCapturer interface {
	CaptureRequest(context.Context, *FrozenRequest) error
}

type AttemptCapturer interface {
	CaptureAttempt(context.Context, string, string, *AttemptRecord) error
}

func (s *PostgresStore) CaptureAttempt(ctx context.Context, requestID, tenantID string, a *AttemptRecord) error {
	if s.pool == nil {
		return ErrStoreUnavailable
	}
	result, err := s.pool.Exec(ctx, insertAttemptV2SQL, a.AttemptID, requestID, tenantID, a.ProviderID, a.ProviderCredentialID, a.ChannelID, a.AttemptNumber, "pending", nil, 0, 0, 0, 0, nil, "", "", "", a.StartedAt, nil, a.ConnectionID, a.ResolvedModel, a.ExecutionMode, a.PriceVersionID, a.CatalogVersionID, a.PolicyVersionID)
	if err != nil {
		return fmt.Errorf("%w: capture attempt: %v", ErrStoreUnavailable, err)
	}
	if result.RowsAffected() != 1 {
		return ErrReservationConflict
	}
	return nil
}
func (m *MemoryStore) CaptureAttempt(ctx context.Context, requestID, tenantID string, a *AttemptRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.unhealthy {
		return ErrStoreUnavailable
	}
	if _, exists := m.capturedAttempts[a.AttemptID]; exists {
		return ErrReservationConflict
	}
	m.capturedAttempts[a.AttemptID] = *a
	return nil
}
func persistV2Attempt(ctx context.Context, tx pgx.Tx, r *TerminalRecord, a AttemptRecord) error {
	result, err := tx.Exec(ctx, `UPDATE attempts SET status=$8,upstream_request_id=NULLIF($9,''),input_tokens=$10,output_tokens=$11,cached_tokens=$12,reasoning_tokens=$13,upstream_cost_amount=$14,upstream_cost_currency=$15,error_code=$16,error_message=$17,completed_at=$19
WHERE id=$1 AND request_id=$2 AND tenant_id=$3 AND provider_id=$4 AND provider_credential_id=$5 AND channel_id=$6 AND attempt_number=$7 AND started_at=$18 AND connection_id IS NOT DISTINCT FROM NULLIF($20,'') AND resolved_model=$21 AND execution_mode=$22 AND price_version_id IS NOT DISTINCT FROM NULLIF($23,'') AND catalog_version_id=$24 AND policy_version_id IS NOT DISTINCT FROM $25::text AND status='pending'`, a.AttemptID, r.RequestID, r.TenantID, a.ProviderID, a.ProviderCredentialID, a.ChannelID, a.AttemptNumber, a.Status, a.UpstreamRequestID, a.InputTokens, a.OutputTokens, a.CachedTokens, a.ReasoningTokens, a.UpstreamCostAmount, a.UpstreamCostCurrency, a.ErrorCode, "", a.StartedAt, a.CompletedAt, a.ConnectionID, a.ResolvedModel, a.ExecutionMode, a.PriceVersionID, a.CatalogVersionID, a.PolicyVersionID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrReservationConflict
	}
	return nil
}

func (r *FrozenRequest) Validate() error {
	if r.RequestID == "" || r.TenantID == "" || r.OrganizationID == "" {
		return errors.New("missing request scope")
	}
	return r.Attribution.Validate()
}

func (s *PostgresStore) CaptureRequest(ctx context.Context, r *FrozenRequest) error {
	if err := r.Validate(); err != nil {
		return err
	}
	if s.pool == nil {
		return ErrStoreUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: capture", ErrStoreUnavailable)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	idem := r.IdempotencyKey
	if idem == "" {
		idem = "req:" + r.RequestID
	}
	c := r.Attribution
	_, err = tx.Exec(ctx, `INSERT INTO request_records(id,tenant_id,organization_id,downstream_key_id,request_model,channel_kind,status,idempotency_key,trace_id,started_at,project_id,project_name,execution_mode,attribution_status)
 VALUES($1,$2,$3,$4,$5,'byok','created',$6,$7,$8,$9,$10,'byok',$11)`, r.RequestID, r.TenantID, r.OrganizationID, c.APIKeyID, c.RequestedModel, idem, r.TraceID, r.StartedAt, c.ProjectID, c.ProjectName, c.AttributionStatus)
	if err != nil {
		return fmt.Errorf("%w: capture request: %v", ErrStoreUnavailable, err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,api_key_id,key_kind,principal_id,execution_mode,attribution_status,requested_model,streaming,catalog_version_id,policy_version_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,'byok',$9,$10,$11,$12,$13)`, r.RequestID, r.TenantID, r.OrganizationID, c.ProjectID, c.ProjectName, c.APIKeyID, c.KeyKind, c.PrincipalID, c.AttributionStatus, c.RequestedModel, c.Streaming, c.CatalogVersionID, c.PolicyVersionID)
	if err != nil {
		return fmt.Errorf("%w: capture fact: %v", ErrStoreUnavailable, err)
	}
	return tx.Commit(ctx)
}

func (m *MemoryStore) CaptureRequest(ctx context.Context, r *FrozenRequest) error {
	if err := r.Validate(); err != nil {
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
	key := r.TenantID + "|" + r.IdempotencyKey
	if r.IdempotencyKey == "" {
		key = r.TenantID + "|req:" + r.RequestID
	}
	if _, ok := m.captured[key]; ok {
		return ErrDuplicateRequest
	}
	raw, _ := json.Marshal(r)
	var copy FrozenRequest
	_ = json.Unmarshal(raw, &copy)
	m.captured[key] = &copy
	return nil
}
func (m *MemoryStore) CapturedRequests() []*FrozenRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*FrozenRequest, 0, len(m.captured))
	for _, r := range m.captured {
		out = append(out, r)
	}
	return out
}

func buildUsageEventV2(r *TerminalRecord, result *attemptResult, model *SnapshotModel, req *chatRequest) *UsageEventV2 {
	c := r.AttributionContext
	event := &UsageEventV2{SchemaVersion: 2, EventId: r.Event.EventID, OccurredAt: r.Event.OccurredAt, TenantId: r.TenantID, OrganizationId: r.OrganizationID, RequestId: r.RequestID, AttemptId: r.Event.AttemptID, ModelId: model.ID, Status: r.Status, PriceVersionId: nullableString(r.ProviderPriceVersionID), CatalogVersionId: c.CatalogVersionID, PolicyVersionId: cloneString(c.PolicyVersionID), RequestedModel: c.RequestedModel, ResolvedModel: nullableString(r.ResolvedUpstreamModel), ProviderId: nullableString(r.ProviderID), Streaming: c.Streaming, ProviderRequestId: r.Event.ProviderRequestID,
		Attribution: UsageEventV2Attribution{ProjectId: cloneString(c.ProjectID), ProjectName: cloneString(c.ProjectName), ApiKeyId: nullableString(c.APIKeyID), PrincipalId: cloneString(c.PrincipalID), KeyKind: c.KeyKind, AttributionStatus: c.AttributionStatus, ConnectionId: nullableString(result.channel.ConnectionID), CredentialId: nullableString(result.channel.CredentialRef), ChannelId: nullableString(result.channel.ID), ExecutionMode: result.channel.CredentialMode}}
	event.Usage.Estimated = result.usageEstimated || result.usage.Estimated || result.outcome == OutcomeUnknown
	if observed := result.usage.Observed; observed != nil {
		event.Usage.InputTokens = observed.InputTokens
		event.Usage.OutputTokens = observed.OutputTokens
		event.Usage.CachedInputTokens = observed.CachedInputTokens
		event.Usage.ReasoningTokens = observed.ReasoningTokens
		event.Usage.TotalTokens = observed.TotalTokens
		event.Usage.Semantics = observed.Semantics
		event.Usage.CacheCreationInputTokens = observed.CacheCreationInputTokens
	}
	raw, _ := json.Marshal(event.Usage)
	var usageValue any
	_ = json.Unmarshal(raw, &usageValue)
	overflow := false
	// Missing provider components can make a normalized observation unknown
	// while the compatibility SQL projection still contains an invalid count.
	for _, count := range []int{r.InputTokens, r.OutputTokens, r.CachedTokens, r.ReasoningTokens} {
		if count < 0 || int64(count) > 2147483647 {
			overflow = true
		}
	}
	for _, count := range []*int64{event.Usage.InputTokens, event.Usage.OutputTokens, event.Usage.CachedInputTokens, event.Usage.ReasoningTokens} {
		if count != nil && *count > 2147483647 {
			overflow = true
		}
	}
	if err := validateUsageV2Node(usageV2Schema.Properties["usage"], usageValue, "usage"); err != nil || overflow {
		// Provider output already happened. Keep an unknown, replayable fact for
		// reconciliation instead of dropping the terminal transaction.
		event.Usage = UsageEventV2Usage{Estimated: true}
		event.Status = string(OutcomeUnknown)
		r.Status = string(OutcomeUnknown)
		r.Event.Status = r.Status
		r.Event.Usage = UsageEventUsage{Estimated: true}
		r.ErrorCode = "invalid_provider_usage"
		r.InputTokens = 0
		r.OutputTokens = 0
		r.CachedTokens = 0
		r.ReasoningTokens = 0
		final := &r.Attempts[len(r.Attempts)-1]
		final.Status = r.Status
		final.ErrorCode = r.ErrorCode
		final.InputTokens = 0
		final.OutputTokens = 0
		final.CachedTokens = 0
		final.ReasoningTokens = 0
	}
	// Project the validated inclusive observations into legacy SQL columns.
	// Unknown remains null in the canonical event; only the compatibility
	// columns use zero. Check the original provider counters above first.
	project := func(count *int64) int {
		if count == nil {
			return 0
		}
		return int(*count)
	}
	r.InputTokens = project(event.Usage.InputTokens)
	r.OutputTokens = project(event.Usage.OutputTokens)
	r.CachedTokens = project(event.Usage.CachedInputTokens)
	r.ReasoningTokens = project(event.Usage.ReasoningTokens)
	final := &r.Attempts[len(r.Attempts)-1]
	final.InputTokens, final.OutputTokens = r.InputTokens, r.OutputTokens
	final.CachedTokens, final.ReasoningTokens = r.CachedTokens, r.ReasoningTokens
	r.Event.Usage = UsageEventUsage{
		InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
		CachedInputTokens: &r.CachedTokens, ReasoningTokens: &r.ReasoningTokens,
		Estimated: event.Usage.Estimated,
	}
	return event
}

func (r *TerminalRecord) validateV2() error {
	if err := r.AttributionContext.Validate(); err != nil {
		return err
	}
	e := r.EventV2
	c := r.AttributionContext
	final, _ := r.FinalAttempt()
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if err = ValidateUsageEventV2(raw); err != nil {
		return err
	}
	equal := func(a, b *string) bool {
		if a == nil || b == nil {
			return a == nil && b == nil
		}
		return *a == *b
	}
	if e.RequestId != r.RequestID || e.TenantId != r.TenantID || e.OrganizationId != r.OrganizationID || e.AttemptId != final.AttemptID || e.Status != r.Status || e.RequestedModel != r.RequestModel || !equal(e.PriceVersionId, nullableString(r.ProviderPriceVersionID)) || e.CatalogVersionId != c.CatalogVersionID || e.Streaming != c.Streaming || !equal(e.PolicyVersionId, c.PolicyVersionID) || !equal(e.ProviderId, nullableString(r.ProviderID)) || !equal(e.ResolvedModel, nullableString(r.ResolvedUpstreamModel)) || !equal(e.Attribution.ApiKeyId, nullableString(r.DownstreamKeyID)) || !equal(e.Attribution.ProjectId, c.ProjectID) || !equal(e.Attribution.ProjectName, c.ProjectName) || !equal(e.Attribution.PrincipalId, c.PrincipalID) || e.Attribution.KeyKind != c.KeyKind || e.Attribution.AttributionStatus != c.AttributionStatus || !equal(e.Attribution.ChannelId, nullableString(final.ChannelID)) || !equal(e.Attribution.CredentialId, nullableString(final.ProviderCredentialID)) {
		return errors.New("outbox: frozen v2 context mismatch")
	}
	mode := "managed"
	if r.ChannelKind == "byok" {
		mode = "byok"
	}
	if e.Attribution.ExecutionMode != mode {
		return errors.New("outbox: v2 execution mode mismatch")
	}
	if !equal(e.Attribution.ConnectionId, nullableString(final.ConnectionID)) || !equal(e.Attribution.ConnectionId, nullableString(r.ConnectionID)) {
		return errors.New("outbox: frozen connection mismatch")
	}
	return nil
}

// The pre-existing identity row is required: terminal persistence cannot create
// a replacement fact after a crash or re-read the mutable key directory.
func persistV2Request(ctx context.Context, tx pgx.Tx, r *TerminalRecord, idem string) error {
	c := r.AttributionContext
	var id string
	err := tx.QueryRow(ctx, `UPDATE request_records r SET status=$5,resolved_provider_id=$6,resolved_upstream_model_id=$7,provider_credential_id=$8,
 input_tokens=$9,output_tokens=$10,cached_tokens=$11,reasoning_tokens=$12,provider_price_version_id=NULLIF($13,''),sale_price_snapshot_id=NULLIF($14,''),exchange_rate_snapshot_id=NULLIF($15,''),
 upstream_request_id=NULLIF($16,''),error_code=$17,error_message=$18,completed_at=$19,trace_id=$20
 WHERE r.id=$1 AND r.tenant_id=$2 AND r.organization_id=$3 AND r.downstream_key_id=$4 AND r.request_model=$21 AND r.idempotency_key=$22
 AND ((r.status='created' AND r.channel_kind='byok' AND $23='byok') OR
 (r.status='reserved' AND r.channel_kind='platform' AND $23='platform' AND r.resolved_provider_id=$6 AND r.resolved_upstream_model_id=$7 AND r.provider_price_version_id=$13 AND r.sale_price_snapshot_id IS NOT DISTINCT FROM NULLIF($14,'') AND r.exchange_rate_snapshot_id IS NOT DISTINCT FROM NULLIF($15,'') AND r.reservation_amount=$24 AND r.charge_currency=$25))
 AND EXISTS(SELECT 1 FROM request_project_facts f WHERE f.request_id=r.id AND f.tenant_id=r.tenant_id AND f.organization_id=r.organization_id
 AND f.project_id IS NOT DISTINCT FROM $26::text AND f.project_name IS NOT DISTINCT FROM $27::text AND f.api_key_id=$4 AND f.key_kind=$28 AND f.principal_id IS NOT DISTINCT FROM $29::text
 AND f.attribution_status=$30 AND f.requested_model=$21 AND f.streaming=$31 AND f.catalog_version_id=$32 AND f.policy_version_id IS NOT DISTINCT FROM $33::text)
 RETURNING r.id`, r.RequestID, r.TenantID, r.OrganizationID, r.DownstreamKeyID, r.Status, r.ProviderID, r.ResolvedUpstreamModel, r.ProviderCredentialID, r.InputTokens, r.OutputTokens, r.CachedTokens, r.ReasoningTokens, r.ProviderPriceVersionID, r.SalePriceSnapshotID, r.ExchangeRateSnapshotID, r.UpstreamRequestID, r.ErrorCode, r.ErrorDetail, r.CompletedAt, r.TraceID, r.RequestModel, idem, r.ChannelKind, r.ReservationAmount, orDefault(r.ChargeCurrency, "USD"), c.ProjectID, c.ProjectName, c.KeyKind, c.PrincipalID, c.AttributionStatus, c.Streaming, c.CatalogVersionID, c.PolicyVersionID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrReservationConflict
	}
	return err
}
