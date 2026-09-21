package main

// Terminal persistence (ADR-0005).
//
// The request terminal state, its attempt row and the outbox usage event are
// written in ONE transaction. That is the whole point of the outbox: a crash
// either loses nothing or leaves a complete, replayable billing fact. A partial
// write (request without event, or event without request) is not representable.
//
// The gateway uses PostgreSQL ONLY for these three tables. Configuration never
// comes from here — it comes from the signed snapshot — so the data plane can
// keep serving while the control plane is down, and the control plane can keep
// serving while this database is degraded (managed traffic fails closed in that
// case, BYOK continues under the tenant policy; see the proxy).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrDuplicateRequest is returned when the (tenant, idempotency key) pair was
// already persisted. It is a success from the caller's point of view: the first
// delivery owns the billing fact.
var ErrDuplicateRequest = errors.New("outbox: duplicate request")

var ErrReservationConflict = errors.New("outbox: reserved identity or state conflict")

// ErrStoreUnavailable marks a database failure, which the proxy maps to the
// managed/BYOK degradation policy rather than to a generic 500.
var ErrStoreUnavailable = errors.New("outbox: store unavailable")

// AttemptRecord is one upstream attempt.
type AttemptRecord struct {
	AttemptID            string
	AttemptNumber        int
	ProviderID           string
	ProviderCredentialID string
	ChannelID            string
	ConnectionID         string
	ResolvedModel        string
	ExecutionMode        string
	PriceVersionID       string
	CatalogVersionID     string
	PolicyVersionID      *string
	Status               string // completed | failed | unknown
	UpstreamRequestID    string
	InputTokens          int
	OutputTokens         int
	CachedTokens         int
	ReasoningTokens      int
	UpstreamCostAmount   *int64
	UpstreamCostCurrency string
	ErrorCode            string
	StartedAt            time.Time
	CompletedAt          time.Time
}

// TerminalRecord is everything the gateway must durably record for one request.
type TerminalRecord struct {
	RequestID       string
	TenantID        string
	OrganizationID  string
	DownstreamKeyID string
	RequestModel    string
	// ProviderID is the control-plane providers.id for the channel.
	ProviderID            string
	ResolvedUpstreamModel string
	ProviderCredentialID  string
	// ChannelKind is "platform" for managed channels, "byok" otherwise.
	ChannelKind string
	// Status is "completed" | "failed" | "unknown".
	Status string

	InputTokens     int
	OutputTokens    int
	CachedTokens    int
	ReasoningTokens int

	ProviderPriceVersionID string
	// INVARIANT #4 pin: the sale-price and exchange-rate snapshots the gateway
	// persists on request_records so the control plane can recompute the charge
	// from the frozen rates at settle time.
	SalePriceSnapshotID    string
	ExchangeRateSnapshotID string
	// ChargeAmount is 0 at gateway-persist time. The control plane owns the
	// money columns and fills charge_amount when it settles the reservation
	// against the ledger; the gateway only records the usage fact and the hold
	// it was given. Writing a number here would be a second source of monetary
	// truth (INVARIANTS #2/#4).
	ChargeAmount         int64
	ChargeCurrency       string
	ReservationAmount    int64
	ReservationReleased  bool
	ReservationExpiresAt *time.Time

	IdempotencyKey    string
	ErrorCode         string
	ErrorDetail       string
	UpstreamRequestID string
	TraceID           string
	StartedAt         time.Time
	CompletedAt       time.Time

	// Frozen attribution captured from the signed request snapshot.
	ProjectID         string
	ProjectName       string
	ConnectionID      string
	ExecutionMode     string
	AttributionStatus string

	// Attempts holds every upstream attempt made for this request, in order.
	// The contract requires each attempt to be an independent record; the
	// usage event references the final one.
	Attempts           []AttemptRecord
	Event              UsageEvent
	EventV2            *UsageEventV2
	AttributionContext *RequestAttributionContext
}

// FinalAttempt returns the attempt the usage event bills against.
func (r *TerminalRecord) FinalAttempt() (AttemptRecord, bool) {
	if len(r.Attempts) == 0 {
		return AttemptRecord{}, false
	}
	return r.Attempts[len(r.Attempts)-1], true
}

// Validate rejects a record that would persist an incomplete billing fact.
func (r *TerminalRecord) Validate() error {
	if r.RequestID == "" || r.TenantID == "" || r.OrganizationID == "" {
		return errors.New("outbox: request_id, tenant_id and organization_id are required")
	}
	if r.RequestModel == "" {
		return errors.New("outbox: request_model is required")
	}
	switch r.Status {
	case string(OutcomeCompleted), string(OutcomeFailed), string(OutcomeUnknown):
	default:
		return fmt.Errorf("outbox: invalid terminal status %q", r.Status)
	}
	if r.ChannelKind != "platform" && r.ChannelKind != "byok" {
		return fmt.Errorf("outbox: invalid channel kind %q", r.ChannelKind)
	}
	if len(r.Attempts) == 0 {
		return errors.New("outbox: at least one attempt is required")
	}
	for i, attempt := range r.Attempts {
		if attempt.AttemptID == "" || attempt.AttemptNumber < 1 {
			return fmt.Errorf("outbox: attempt %d needs an id and number", i)
		}
	}
	if final, ok := r.FinalAttempt(); !ok || final.AttemptID != r.Event.AttemptID {
		return errors.New("outbox: usage event must reference the final attempt")
	}
	if r.Event.RequestID != r.RequestID {
		return errors.New("outbox: usage event request_id must match the terminal record")
	}
	if r.EventV2 != nil {
		return r.validateV2()
	}
	return r.Event.Validate()
}

// Store persists terminal records.
type Store interface {
	// PersistTerminal writes request + attempt + outbox event atomically.
	PersistTerminal(ctx context.Context, rec *TerminalRecord) error
	Ping(ctx context.Context) error
	// Healthy reports whether the last probe (or write) succeeded. The proxy
	// consults it before dispatching MANAGED traffic so an uncommittable outbox
	// fails closed at dispatch time rather than after the money is spent
	// (GATEWAY_SPEC "降级": PostgreSQL/outbox 不可提交时托管请求 fail closed).
	// It is a cached flag, not a round trip: the hot path must not add I/O.
	Healthy() bool
	Close()
}

// ── PostgreSQL ────────────────────────────────────────────────────────

// PostgresStore is the production Store.
type PostgresStore struct {
	pool    *pgxpool.Pool
	logger  *slog.Logger
	healthy atomic.Bool
}

func NewPostgresStore(ctx context.Context, databaseURL string, logger *slog.Logger) (*PostgresStore, error) {
	if databaseURL == "" {
		return nil, errors.New("outbox: DATABASE_URL is required")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	// Bounded pool: the gateway's database use is a short terminal write per
	// request, so a large pool would only mask backpressure.
	cfg.MaxConns = 16
	cfg.MinConns = 1
	cfg.MaxConnLifetime = 30 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	store := &PostgresStore{pool: pool, logger: logger}
	store.healthy.Store(true)
	return store, nil
}

// RunHealthProbe refreshes the Healthy flag until ctx is cancelled. One
// goroutine, one query per interval; it exits with the process.
func (s *PostgresStore) RunHealthProbe(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, interval)
			err := s.Ping(probeCtx)
			cancel()
			if err != nil && s.healthy.Load() {
				s.logger.Error("outbox unreachable: managed traffic will fail closed", "err", err.Error())
			}
			s.healthy.Store(err == nil)
		}
	}
}

// Healthy reports the cached probe result.
func (s *PostgresStore) Healthy() bool { return s.healthy.Load() }

func (s *PostgresStore) Ping(ctx context.Context) error {
	if s.pool == nil {
		return ErrStoreUnavailable
	}
	return s.pool.Ping(ctx)
}

func (s *PostgresStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

const insertRequestSQL = `
INSERT INTO request_records (
  id, organization_id, tenant_id, downstream_key_id, request_model,
  resolved_provider_id, resolved_upstream_model_id, provider_credential_id,
  channel_kind, status,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens,
  provider_price_version_id, sale_price_snapshot_id, exchange_rate_snapshot_id,
  upstream_cost_amount, upstream_cost_currency,
  charge_amount, charge_currency, reservation_amount, reservation_released, reservation_expires_at,
  idempotency_key, error_code, error_message, upstream_request_id, trace_id,
  started_at, completed_at
) VALUES (
  $1,$2,$3,NULLIF($4,''),$5,
  NULLIF($6,''),$7,NULLIF($8,''),
  $9,$10,
  $11,$12,$13,$14,
  NULLIF($15,''),NULLIF($16,''),NULLIF($17,''),
  $18,$19,
  $20,$21,$22,$23,$24,
  $25,$26,$27,NULLIF($28,''),NULLIF($29,''),
  $30,$31
)
ON CONFLICT (id) DO UPDATE SET
 status=EXCLUDED.status, provider_credential_id=EXCLUDED.provider_credential_id,
 input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
 cached_tokens=EXCLUDED.cached_tokens, reasoning_tokens=EXCLUDED.reasoning_tokens,
 upstream_cost_amount=EXCLUDED.upstream_cost_amount, upstream_cost_currency=EXCLUDED.upstream_cost_currency,
 error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message,
 upstream_request_id=EXCLUDED.upstream_request_id, trace_id=EXCLUDED.trace_id,
 completed_at=EXCLUDED.completed_at
WHERE request_records.status='reserved'
 AND request_records.idempotency_key=EXCLUDED.idempotency_key
 AND request_records.tenant_id=EXCLUDED.tenant_id
 AND request_records.organization_id=EXCLUDED.organization_id
 AND request_records.downstream_key_id IS NOT DISTINCT FROM EXCLUDED.downstream_key_id
 AND request_records.resolved_provider_id IS NOT DISTINCT FROM EXCLUDED.resolved_provider_id
 AND request_records.resolved_upstream_model_id=EXCLUDED.resolved_upstream_model_id
 AND request_records.provider_price_version_id IS NOT DISTINCT FROM EXCLUDED.provider_price_version_id
 AND request_records.sale_price_snapshot_id IS NOT DISTINCT FROM EXCLUDED.sale_price_snapshot_id
 AND request_records.exchange_rate_snapshot_id IS NOT DISTINCT FROM EXCLUDED.exchange_rate_snapshot_id
 AND request_records.channel_kind=EXCLUDED.channel_kind
 AND request_records.charge_currency=EXCLUDED.charge_currency
 AND request_records.reservation_amount=EXCLUDED.reservation_amount
RETURNING id`

const insertAttemptSQL = `
INSERT INTO attempts (
  id, request_id, tenant_id, provider_id, provider_credential_id, channel_id,
  attempt_number, status, upstream_request_id,
  input_tokens, output_tokens, cached_tokens, reasoning_tokens,
  upstream_cost_amount, upstream_cost_currency, error_code, error_message,
  started_at, completed_at
) VALUES (
  $1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),
  $7,$8,NULLIF($9,''),
  $10,$11,$12,$13,
  $14,$15,$16,$17,
  $18,$19
)
ON CONFLICT (tenant_id, upstream_request_id) DO NOTHING`

const insertOutboxSQL = `
INSERT INTO outbox_events (
  id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, status
) VALUES (pg_catalog.gen_random_uuid(),$1,'usage',$2,$3,$4::jsonb,$5,'pending')
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`

const insertAttemptV2SQL = `
INSERT INTO attempts(id,request_id,tenant_id,provider_id,provider_credential_id,channel_id,attempt_number,status,upstream_request_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens,upstream_cost_amount,upstream_cost_currency,error_code,error_message,started_at,completed_at,connection_id,resolved_model,execution_mode,price_version_id,catalog_version_id,policy_version_id)
VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7,$8,NULLIF($9,''),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULLIF($20,''),$21,$22,NULLIF($23,''),$24,$25)
ON CONFLICT (tenant_id,upstream_request_id) DO NOTHING`

// PersistTerminal writes all three rows in a single transaction.
func (s *PostgresStore) PersistTerminal(ctx context.Context, rec *TerminalRecord) error {
	if err := rec.Validate(); err != nil {
		return err
	}
	if s.pool == nil {
		return ErrStoreUnavailable
	}
	payload, err := json.Marshal(rec.Event)
	if rec.EventV2 != nil {
		payload, err = json.Marshal(rec.EventV2)
	}
	if err != nil {
		return fmt.Errorf("outbox: encode usage event: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStoreUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	idempotencyKey := rec.IdempotencyKey
	if idempotencyKey == "" {
		// No client key: the request id is itself unique, so use it. This keeps
		// the unique index meaningful for every row.
		idempotencyKey = "req:" + rec.RequestID
	}
	final, _ := rec.FinalAttempt()
	var upstreamCostAmount *int64
	if final.UpstreamCostAmount != nil {
		upstreamCostAmount = final.UpstreamCostAmount
	}
	var requestID string
	if rec.EventV2 != nil {
		err = persistV2Request(ctx, tx, rec, idempotencyKey)
	} else {
		err = tx.QueryRow(ctx, insertRequestSQL,
			rec.RequestID, rec.OrganizationID, rec.TenantID, rec.DownstreamKeyID, rec.RequestModel,
			rec.ProviderID, rec.ResolvedUpstreamModel, rec.ProviderCredentialID,
			rec.ChannelKind, rec.Status,
			rec.InputTokens, rec.OutputTokens, rec.CachedTokens, rec.ReasoningTokens,
			rec.ProviderPriceVersionID, rec.SalePriceSnapshotID, rec.ExchangeRateSnapshotID,
			upstreamCostAmount, final.UpstreamCostCurrency,
			rec.ChargeAmount, orDefault(rec.ChargeCurrency, "USD"),
			rec.ReservationAmount, rec.ReservationReleased, rec.ReservationExpiresAt,
			idempotencyKey, rec.ErrorCode, rec.ErrorDetail, rec.UpstreamRequestID, rec.TraceID,
			rec.StartedAt, rec.CompletedAt,
		).Scan(&requestID)
	}
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrReservationConflict) {
		// A reserved row may only transition with its original authorization.
		return ErrReservationConflict
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "requests_tenant_idempotency_idx" {
			return ErrDuplicateRequest
		}
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "requests_idempotency_idx" {
			// N-1 retains the organization/key index. Confirm tenant ownership before
			// treating that legacy uniqueness violation as an already-recorded fact.
			_ = tx.Rollback(ctx)
			var sameTenant bool
			checkErr := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM request_records WHERE tenant_id=$1 AND organization_id=$2 AND idempotency_key=$3)", rec.TenantID, rec.OrganizationID, idempotencyKey).Scan(&sameTenant)
			if checkErr == nil && sameTenant {
				return ErrDuplicateRequest
			}
		}

		return fmt.Errorf("%w: request insert: %v", ErrStoreUnavailable, err)
	}

	for _, attempt := range rec.Attempts {
		if rec.EventV2 != nil {
			if err := persistV2Attempt(ctx, tx, rec, attempt); err != nil {
				return fmt.Errorf("%w: attempt update: %v", ErrStoreUnavailable, err)
			}
			continue
		}
		query := insertAttemptSQL
		args := []any{
			attempt.AttemptID, rec.RequestID, rec.TenantID, attempt.ProviderID,
			attempt.ProviderCredentialID, attempt.ChannelID,
			attempt.AttemptNumber, attempt.Status, attempt.UpstreamRequestID,
			attempt.InputTokens, attempt.OutputTokens, attempt.CachedTokens, attempt.ReasoningTokens,
			attempt.UpstreamCostAmount, attempt.UpstreamCostCurrency, attempt.ErrorCode, "",
			attempt.StartedAt, attempt.CompletedAt,
		}
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			return fmt.Errorf("%w: attempt insert: %v", ErrStoreUnavailable, err)
		}
	}

	eventKey := "usage:" + rec.RequestID + ":" + fmt.Sprint(final.AttemptNumber)
	eventType := "usage." + rec.Status
	if rec.EventV2 != nil {
		eventType = "usage.v2." + rec.Status
	}
	if _, err := tx.Exec(ctx, insertOutboxSQL,
		rec.TenantID, rec.RequestID, eventType, payload, eventKey,
	); err != nil {
		return fmt.Errorf("%w: outbox insert: %v", ErrStoreUnavailable, err)
	}

	if err := tx.Commit(ctx); err != nil {
		s.healthy.Store(false)
		return fmt.Errorf("%w: commit: %v", ErrStoreUnavailable, err)
	}
	s.healthy.Store(true)
	return nil
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// ── In-memory (tests) ─────────────────────────────────────────────────

// MemoryStore is a Store for tests. It mirrors the uniqueness rules of the
// PostgreSQL schema so idempotency behaviour is exercised, not assumed.
type MemoryStore struct {
	capturedAttempts map[string]AttemptRecord
	captured         map[string]*FrozenRequest
	mu               sync.Mutex
	requests         map[string]*TerminalRecord
	outbox           map[string]int
	failNext         bool
	closed           bool
	unhealthy        bool
	// Latency lets tests exercise slow-database behaviour.
	Latency time.Duration
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{requests: make(map[string]*TerminalRecord), outbox: make(map[string]int), captured: make(map[string]*FrozenRequest), capturedAttempts: make(map[string]AttemptRecord)}
}

// SetHealthy simulates an outbox that cannot commit.
func (m *MemoryStore) SetHealthy(healthy bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unhealthy = !healthy
}

// Healthy reports whether writes are expected to succeed.
func (m *MemoryStore) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return !m.unhealthy && !m.closed
}

// FailNext makes the next PersistTerminal fail, simulating an uncommittable
// PostgreSQL/outbox.
func (m *MemoryStore) FailNext() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failNext = true
}

func (m *MemoryStore) PersistTerminal(ctx context.Context, rec *TerminalRecord) error {
	if err := rec.Validate(); err != nil {
		return err
	}
	if m.Latency > 0 {
		select {
		case <-time.After(m.Latency):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failNext {
		m.failNext = false
		return fmt.Errorf("%w: simulated failure", ErrStoreUnavailable)
	}
	if m.closed {
		return ErrStoreUnavailable
	}
	key := rec.TenantID + "|" + rec.IdempotencyKey
	if rec.IdempotencyKey == "" {
		key = rec.TenantID + "|req:" + rec.RequestID
	}
	if _, exists := m.requests[key]; exists {
		return ErrDuplicateRequest
	}
	copied := *rec
	m.requests[key] = &copied
	m.outbox[rec.TenantID+"|usage:"+rec.RequestID]++
	return nil
}

func (m *MemoryStore) Ping(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrStoreUnavailable
	}
	return nil
}

func (m *MemoryStore) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
}

// Requests returns the persisted records (tests only).
func (m *MemoryStore) Requests() []*TerminalRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*TerminalRecord, 0, len(m.requests))
	for _, rec := range m.requests {
		out = append(out, rec)
	}
	return out
}

// OutboxCount returns how many outbox rows exist for a tenant (tests only).
func (m *MemoryStore) OutboxCount(tenantID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	total := 0
	for key, count := range m.outbox {
		if len(key) > len(tenantID) && key[:len(tenantID)] == tenantID {
			total += count
		}
	}
	return total
}
