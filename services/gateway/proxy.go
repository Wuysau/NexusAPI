package main

// The gateway hot path.
//
// Order (GATEWAY_SPEC "热路径顺序"):
//   parse + limit request size → key auth → tenant/scope → budget reservation →
//   resolve alias/capabilities → hard filter → health/cost/latency sort →
//   pin versions → forward/stream → persist terminal + outbox →
//   release or settle reservation
//
// Two properties this file is responsible for and that the tests pin down:
//
//  1. Cancellation. The upstream call derives from the client's request
//     context, so a disconnect cancels it immediately. Usage produced up to
//     that point is still recorded, using a context detached from the client
//     (context.WithoutCancel) so the terminal write survives the disconnect.
//
//  2. No unsafe switch. An assigned upstream connection makes execution
//     ambiguous, including error responses. Only a failure before connection
//     assignment may try another channel within the same request.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"nexus/gateway/provider"
)

// Proxy is the gateway core. Every dependency is an interface so the hot path
// can be tested without a control plane, a database or a provider.
type Proxy struct {
	connectors    *ConnectorHub
	enableUsageV2 bool
	env           *Env
	limits        Limits
	snapshots     *SnapshotCache
	authn         *Authenticator
	registry      *provider.Registry
	breaker       *Breaker
	router        *Router
	limiter       *Limiter
	store         Store
	credentials   CredentialResolver
	managed       Reserver
	byok          Reserver
	logger        *slog.Logger
	httpClient    *http.Client
	idempotency   *idempotencyCache
	maxAttempts   int
	now           func() time.Time
	newID         func() string
}

// ProxyDeps is the constructor input; a struct keeps the wiring readable and
// makes missing dependencies a compile error rather than a nil panic in prod.
type ProxyDeps struct {
	Connectors *ConnectorHub
	// Explicit canonical v2 opt-in; main enables this for the local credential profile.
	EnableUsageV2 bool
	Env           *Env
	Limits        Limits
	Snapshots     *SnapshotCache
	Authn         *Authenticator
	Registry      *provider.Registry
	Breaker       *Breaker
	Router        *Router
	Limiter       *Limiter
	Store         Store
	Credentials   CredentialResolver
	Managed       Reserver
	Byok          Reserver
	Logger        *slog.Logger
	HTTPClient    *http.Client
	MaxAttempts   int
}

func NewProxy(deps ProxyDeps) *Proxy {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	client := deps.HTTPClient
	if client == nil {
		client = &http.Client{
			// Execution contexts own total and per-attempt deadlines; the relay
			// owns idle/write budgets. Do not add a separate client-level timer.
			Transport: &http.Transport{
				MaxIdleConns:        256,
				MaxIdleConnsPerHost: 64,
				IdleConnTimeout:     90 * time.Second,
				ForceAttemptHTTP2:   true,
			},
		}
	}
	maxAttempts := deps.MaxAttempts
	if maxAttempts < 1 {
		maxAttempts = 2
	}
	return &Proxy{
		connectors:    deps.Connectors,
		enableUsageV2: deps.EnableUsageV2,
		env:           deps.Env,
		limits:        deps.Limits,
		snapshots:     deps.Snapshots,
		authn:         deps.Authn,
		registry:      deps.Registry,
		breaker:       deps.Breaker,
		router:        deps.Router,
		limiter:       deps.Limiter,
		store:         deps.Store,
		credentials:   deps.Credentials,
		managed:       deps.Managed,
		byok:          deps.Byok,
		logger:        logger,
		httpClient:    client,
		idempotency:   newIdempotencyCache(15*time.Minute, 100_000),
		maxAttempts:   maxAttempts,
		now:           time.Now,
		newID:         newRandomID,
	}
}

// ── Request shapes ────────────────────────────────────────────────────

// chatRequest is the accepted OpenAI-compatible subset. Unknown top-level
// parameters are rejected rather than forwarded: forwarding an unknown field
// would silently change provider behaviour, and the legacy gateway already
// enforced an allowlist.
type chatRequest struct {
	Model               string             `json:"model"`
	Messages            []provider.Message `json:"messages"`
	MaxTokens           *int               `json:"max_tokens"`
	MaxCompletionTokens *int               `json:"max_completion_tokens"`
	Temperature         *float64           `json:"temperature"`
	TopP                *float64           `json:"top_p"`
	Stop                json.RawMessage    `json:"stop"`
	Stream              *bool              `json:"stream"`
	StreamOptions       *chatStreamOptions `json:"stream_options"`
	Tools               json.RawMessage    `json:"tools"`
	ToolChoice          json.RawMessage    `json:"tool_choice"`
	ResponseFormat      json.RawMessage    `json:"response_format"`
	User                string             `json:"user"`
	// Parsed once at ingress, before rate admission or budget reservation.
	stopSequences []string
}

type chatStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

var allowedChatParams = map[string]bool{
	"model": true, "messages": true, "max_tokens": true, "max_completion_tokens": true,
	"temperature": true, "top_p": true, "stop": true, "stream": true, "stream_options": true,
	"tools": true, "tool_choice": true, "response_format": true, "user": true,
}

const maxStoredErrorDetail = 512

// ── Entry points ──────────────────────────────────────────────────────

// ServeModels implements GET /v1/models from the signed snapshot. It performs
// no upstream call: the catalogue is control-plane data, not a provider fetch.
func (p *Proxy) ServeModels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), catalogTimeout)
	defer cancel()
	requestID := ensureRequestID(r)
	identity, err := p.authn.Authenticate(ctx, bearerToken(r), ScopeModelsRead)
	if err != nil {
		writeAPIError(w, requestID, asAPIError(err))
		return
	}
	state, err := p.snapshots.Get(ctx, identity.TenantID)
	if err != nil && state == nil {
		writeAPIError(w, requestID, errSnapshot(reasonOf(err)))
		return
	}
	bundle := state.Verified.Bundle
	type modelEntry struct {
		ID       string   `json:"id"`
		Object   string   `json:"object"`
		OwnedBy  string   `json:"owned_by"`
		Created  int64    `json:"created"`
		Provider string   `json:"provider"`
		Aliases  []string `json:"aliases,omitempty"`
	}
	data := make([]modelEntry, 0, len(bundle.Models))
	available := p.catalogAvailability(ctx, bundle, identity)
	for _, model := range bundle.Models {
		if (model.Status != "" && model.Status != "active") || !available[model.ID] {
			continue
		}
		data = append(data, modelEntry{
			ID: model.ID, Object: "model", OwnedBy: model.Provider,
			Created: 0, Provider: model.Provider, Aliases: model.Aliases,
		})
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", requestID)
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
}

// ServeChatCompletions implements POST /v1/chat/completions.
func (p *Proxy) ServeChatCompletions(w http.ResponseWriter, r *http.Request) {
	startedAt := p.now()
	requestID := ensureRequestID(r)

	ctx, span := Tracer().Start(r.Context(), "gateway.chat_completions",
		trace.WithAttributes(attrRequestID.String(requestID)))
	defer span.End()

	// 1. Size limit + parse.
	body, apiErr := readBounded(r, p.limits.MaxBodyBytes)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}
	req, apiErr := parseChatRequest(body, p.limits.MaxTokensEstimate)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}
	streaming := req.Stream != nil && *req.Stream

	// 2. Key auth (scope: chat:write).
	identity, err := p.authn.Authenticate(ctx, bearerToken(r), ScopeChatWrite)
	if err != nil {
		writeAPIError(w, requestID, asAPIError(err))
		return
	}
	span.SetAttributes(attrTenantID.String(identity.TenantID), attrProjectID.String(identity.ProjectID), attrModel.String(req.Model))
	traceID := requestID
	if sc := span.SpanContext(); sc.IsValid() {
		traceID = sc.TraceID().String()
	}

	// 3. Idempotency: a duplicate key is a conflict, never a second upstream
	// call. The database unique index is the durable backstop; this in-memory
	// guard is what stops the second spend.
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	dispatched := false
	legacyBYOKClaimed := false
	if idempotencyKey != "" {
		if !p.claimIdempotency(ctx, identity.TenantID, idempotencyKey) {
			writeAPIError(w, requestID, errIdempotencyConflict())
			return
		}
		// The claim is held after dispatch so a client retry cannot spend
		// twice. It is released only when nothing was sent upstream, so a
		// genuinely rejected request can be retried.
		defer func() {
			if !dispatched && !legacyBYOKClaimed {
				p.releaseIdempotency(identity.TenantID, idempotencyKey)
			}
		}()
	}

	// 4. Snapshot: channels, models, prices, limits for this tenant.
	state, snapErr := p.snapshots.Get(ctx, identity.TenantID)
	staleManagedForbidden := false
	if snapErr != nil {
		if state == nil {
			writeAPIError(w, requestID, errSnapshot(reasonOf(snapErr)))
			return
		}
		// Expired snapshot: managed traffic fails closed. BYOK continues only
		// when the tenant policy in that same signed bundle says so.
		if !state.Verified.Bundle.Limits.ByokContinueWhenStale {
			writeAPIError(w, requestID, errSnapshot(ReasonSnapshotExpired))
			return
		}
		staleManagedForbidden = true
	}
	bundle := state.Verified.Bundle
	span.SetAttributes(attrDegraded.Bool(snapErr != nil))
	if p.enableUsageV2 && !state.Fresh(p.now()) {
		writeAPIError(w, requestID, errSnapshot(ReasonSnapshotExpired))
		return
	}
	var attribution *RequestAttributionContext
	if p.enableUsageV2 {
		attribution = requestAttribution(identity, bundle, req)
		for key, value := range map[string]string{"tenant_id": identity.TenantID, "organization_id": identity.OrganizationID, "request_id": requestID} {
			if validateUsageV2Node(usageV2Schema.Properties[key], value, key) != nil {
				writeAPIError(w, requestID, errInvalidAPIKey())
				return
			}
		}
		if err := attribution.Validate(); err != nil {
			writeAPIError(w, requestID, errInvalidAPIKey())
			return
		}
	}

	// 5. Resolve alias + capabilities.
	model, ok := bundle.ResolveModel(req.Model)
	if !ok {
		writeAPIError(w, requestID, errModelNotFound())
		return
	}
	if model.Status != "" && model.Status != "active" {
		writeAPIError(w, requestID, errModelNotFound())
		return
	}
	if model.License == "" {
		writeAPIError(w, requestID, errModelNotAllowed())
		return
	}
	// A billable request must be able to name the exact catalog and price
	// versions it ran against (INVARIANT #4). Without them the usage event
	// cannot satisfy packages/contracts/schemas/usage-event.schema.json, so the request is
	// refused rather than recorded unbillable.
	if bundle.Snapshot.CatalogVersion == nil || bundle.Snapshot.CatalogVersion.ID == "" {
		writeAPIError(w, requestID, errSnapshot(ReasonSnapshotUnavailable))
		return
	}
	if streaming && !containsString(model.Capabilities, "streaming") {
		writeAPIError(w, requestID, errCapabilityUnsupported("This model does not support streaming."))
		return
	}

	// 6. Limits: concurrency, then per-minute requests, then token estimate.
	concurrencyLimit := ConcurrencyFor(p.limits.MaxConcurrent, bundle)
	lease, acquireErr := p.limiter.AcquireContext(ctx, ConcurrencyRequest{TenantID: identity.TenantID, TenantLimit: concurrencyLimit, WaitTimeout: p.limits.ConcurrencyWait, AllowLocal: p.allowLocalAdmission()})
	if acquireErr != nil {
		if errors.Is(acquireErr, ErrConcurrencyLimit) {
			writeAPIError(w, requestID, errConcurrency())
		} else {
			writeAPIError(w, requestID, errNoHealthyUpstream())
		}
		return
	}
	defer lease.Release()
	ctx = lease.Context()

	limits := bundle.LimitsFor(p.limits)
	requestDecision, rateErr := p.limiter.Allow(ctx, RateLimitBucket(identity.TenantID, identity.KeyID, model.ID, "req"),
		limits.RequestsPerMinute, time.Minute, 1, p.allowLocalAdmission())
	if rateErr != nil {
		writeAPIError(w, requestID, errNoHealthyUpstream())
		return
	}
	if !requestDecision.Allowed {
		writeRateLimitError(w, requestID, requestDecision.RetryAfter)
		return
	}

	inputEstimate := estimateInputTokens(body)
	outputEstimate := p.outputEstimate(req)
	tokenDecision, rateErr := p.limiter.Allow(ctx, RateLimitBucket(identity.TenantID, identity.KeyID, model.ID, "tok"),
		limits.TokensPerMinute, time.Minute, inputEstimate+outputEstimate, p.allowLocalAdmission())
	if rateErr != nil {
		writeAPIError(w, requestID, errNoHealthyUpstream())
		return
	}
	if !tokenDecision.Allowed {
		writeRateLimitError(w, requestID, tokenDecision.RetryAfter)
		return
	}

	// 7. Routing: hard filter then soft score.
	credentials, apiErr := p.route(ctx, bundle, model, req, identity, inputEstimate, outputEstimate, staleManagedForbidden)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}

	// 8. Budget reservation for managed traffic.
	//
	// The outbox health check comes first for managed traffic: if the terminal
	// usage fact cannot be made durable, Nexus must not spend its own upstream
	// credit on a request it cannot bill. BYOK continues, because the tenant is
	// spending its own provider credit and the local outbox is the record
	// reconciliation uses once storage recovers.
	if credentials.channel.CredentialMode != "byok" && !p.store.Healthy() {
		writeAPIError(w, requestID, errStorageUnavailable())
		return
	}
	if p.enableUsageV2 && credentials.channel.CredentialMode == "byok" {
		capturer, ok := p.store.(RequestCapturer)
		if !ok {
			writeAPIError(w, requestID, errStorageUnavailable())
			return
		}
		if err := capturer.CaptureRequest(ctx, &FrozenRequest{RequestID: requestID, TenantID: identity.TenantID, OrganizationID: identity.OrganizationID, IdempotencyKey: idempotencyKey, TraceID: traceID, StartedAt: startedAt, Attribution: *attribution}); err != nil {
			if errors.Is(err, ErrDuplicateRequest) {
				writeAPIError(w, requestID, errIdempotencyConflict())
			} else {
				writeAPIError(w, requestID, errStorageUnavailable())
			}
			return
		}
	}
	if !p.enableUsageV2 && credentials.channel.CredentialMode == "byok" && idempotencyKey != "" {
		claimer, ok := p.store.(LegacyBYOKClaimer)
		if !ok {
			writeAPIError(w, requestID, errStorageUnavailable())
			return
		}
		claimCtx, cancelClaim := context.WithTimeout(ctx, legacyBYOKClaimTimeout)
		err := claimer.ClaimLegacyBYOK(claimCtx, &LegacyBYOKClaim{
			RequestID: requestID, TenantID: identity.TenantID, OrganizationID: identity.OrganizationID,
			APIKeyID: identity.KeyID, RequestedModel: req.Model, IdempotencyKey: idempotencyKey,
			TraceID: traceID, StartedAt: startedAt,
		})
		cancelClaim()
		if err != nil {
			if errors.Is(err, ErrDuplicateRequest) {
				writeAPIError(w, requestID, errIdempotencyConflict())
			} else {
				writeAPIError(w, requestID, errStorageUnavailable())
			}
			return
		}
		legacyBYOKClaimed = true
	}
	reservation, apiErr := p.reserve(ctx, credentials.channel, credentials.candidates[0].Price, model, req, identity, requestID, idempotencyKey, inputEstimate, outputEstimate, attribution)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}

	// 9. Forward and stream.
	upstreamCtx, cancelUpstream := context.WithCancel(ctx)
	defer cancelUpstream()
	// A client that never reads must not pin an upstream connection forever.
	if p.limits.TotalDuration > 0 {
		var cancelTotal context.CancelFunc
		upstreamCtx, cancelTotal = context.WithTimeout(upstreamCtx, p.limits.TotalDuration)
		defer cancelTotal()
	}

	dispatched = true
	result := p.attempt(upstreamCtx, w, credentials, req, model, identity, requestID, streaming, bundle, startedAt)
	if result.captureFailed && len(result.attempts) == 0 {
		writeAPIError(w, requestID, errStorageUnavailable())
		return
	}
	span.SetAttributes(attrChannelID.String(credentials.channel.ID), attrProvider.String(credentials.channel.Provider))

	// 10. Persist terminal state + outbox event for Worker settlement.
	// The persistence context is detached from the client: a disconnect after
	// the upstream produced tokens must still record the usage.
	persistCtx, cancelPersist := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelPersist()
	rec := p.buildTerminalRecord(result, credentials, bundle, model, req, identity, requestID, startedAt, reservation, idempotencyKey)
	rec.LegacyBYOKClaimed = legacyBYOKClaimed
	rec.TraceID = traceID
	persistErr := p.store.PersistTerminal(persistCtx, rec)
	p.logger.Info("request terminal", "request_id", requestID, "tenant_id", identity.TenantID, "project_id", identity.ProjectID, "trace_id", traceID, "outcome", rec.Status, "persisted", persistErr == nil)
	if persistErr != nil {
		p.logger.Error("terminal persist failed", "request_id", requestID, "outcome", string(result.outcome), "err", persistErr.Error())
		span.RecordError(persistErr)
		span.SetStatus(codes.Error, "persist_failed")
		if !result.wroteHeader {
			writeAPIError(w, requestID, errInternal())
		} else {
			p.writeStreamError(w, requestID, errStorageUnavailable())
		}
		return
	}
	if streaming && result.wroteHeader {
		if result.err != nil || result.outcome != OutcomeCompleted {
			p.writeStreamError(w, requestID, apiErrorForResult(result))
		} else {
			if err := p.writeFinalSSE(w, []byte("data: [DONE]\n\n")); err != nil {
				p.logger.Debug("terminal stream write failed", "request_id", requestID)
			}
		}
	}

	// Non-streaming bodies are written only now, after the usage fact is
	// durable. A streaming response has necessarily already started.
	if !streaming && result.body != nil && !result.wroteHeader {
		if err := p.withDownstreamWriteDeadline(w, terminalWrite, func() error {
			w.Header().Set("content-type", "application/json")
			w.Header().Set("x-request-id", requestID)
			w.WriteHeader(http.StatusOK)
			if _, err := w.Write(result.body); err != nil {
				return err
			}
			return flushBufferedResponse(w)
		}); err != nil {
			p.logger.Warn("client write failed after persist", "request_id", requestID)
		}
		result.wroteHeader = true
	}

	span.SetAttributes(attrOutcome.String(string(result.outcome)))

	// Nothing reached the client, so the failure can still be reported in the
	// contract's error shape. Once a body has started (any status/headers sent)
	// the stream itself carries the outcome and we must not append JSON.
	if !result.wroteHeader {
		writeAPIError(w, requestID, apiErrorForResult(result))
	}
}

// apiErrorForResult maps a pre-response failure to the public error.
func apiErrorForResult(result *attemptResult) *APIError {
	if errors.Is(result.err, errUpstreamIdle) {
		return errUpstreamTimeout()
	}
	switch result.errorCode {
	case CodeUpstreamTimeout:
		return errUpstreamTimeout()
	case CodeConcurrencyExceeded:
		return errConcurrency()
	case CodeRateLimitExceeded:
		return errRateLimited()
	case CodeBudgetExceeded:
		return errBudgetExceeded()
	case CodeInvalidParameter:
		return errInvalidParam("model", "The upstream rejected this request.")
	case CodeCapabilityUnsupported:
		return errCapabilityUnsupported("This request is not permitted for the selected model.")
	case CodeUpstreamProtocol:
		return errUpstreamProtocol()
	case CodeInternal:
		return errInternal()
	default:
		return errNoHealthyUpstream()
	}
}

// ── Routing + reservation helpers ─────────────────────────────────────

type routedCredentials struct {
	channel    *SnapshotChannel
	adapter    provider.Adapter
	credential provider.Credential
	candidates []Candidate
}

func (p *Proxy) route(
	ctx context.Context,
	bundle *GatewayBundle,
	model *SnapshotModel,
	req *chatRequest,
	identity *Identity,
	inputEstimate, outputEstimate int,
	staleManagedForbidden bool,
) (*routedCredentials, *APIError) {
	routeReq := RouteRequest{
		ProjectID:             identity.ProjectID,
		TenantID:              identity.TenantID,
		RequestedModel:        req.Model,
		ResolvedModel:         model.ID,
		RequiredCapabilities:  RequiredCapabilitiesForChat(),
		EstimatedInputTokens:  inputEstimate,
		EstimatedOutputTokens: outputEstimate,
	}
	if staleManagedForbidden {
		// Only BYOK channels may be considered while the snapshot is expired.
		routeReq.CredentialMode = "byok"
	}
	candidates, err := p.router.Select(bundle, routeReq)
	if err != nil || len(candidates) == 0 {
		return nil, errNoHealthyUpstream()
	}
	// Managed and v1 traffic require approved price pins. Only explicit local
	// canonical BYOK may record an unknown price.
	billable := candidates[:0]
	for _, candidate := range candidates {
		if candidate.Channel.Transport == "local_sidecar" && !p.connectors.Available(ctx, candidate.Channel, identity, model.ID, ScopeChatWrite) {
			continue
		}
		if p.enableUsageV2 && (candidate.Channel.ProviderID == "" || candidate.Channel.CredentialRef == "" || (candidate.Channel.CredentialMode == "byok" && candidate.Channel.ConnectionID == "") || (candidate.Channel.CredentialMode != "managed" && candidate.Channel.CredentialMode != "byok")) {
			continue
		}
		if (candidate.Price != nil && candidate.Price.ID != "") || (candidate.Price == nil && p.enableUsageV2 && candidate.Channel.CredentialMode == "byok" && (candidate.Channel.Transport == "local_sidecar" || (p.env != nil && p.env.LocalCredentialDir != "" && p.env.Environment != "production"))) {
			if p.enableUsageV2 && !validV2Routing(candidate, model) {
				continue
			}
			billable = append(billable, candidate)
		}
	}
	candidates = billable
	if len(candidates) == 0 {
		return nil, errSnapshot(ReasonSnapshotUnavailable)
	}
	// Request fidelity is another eligibility check on the existing Router
	// result. Validate before choosing a payment mode/price or resolving secrets;
	// later attempts must also come from this same compatible candidate set.
	canonical := canonicalChatRequest(req, model)
	compatible := candidates[:0]
	var validationError *APIError
	for _, candidate := range candidates {
		if err := candidate.Adapter.ValidateRequest(canonical); err != nil {
			if validationError == nil {
				var unsupported *provider.UnsupportedParameterError
				if errors.As(err, &unsupported) {
					validationError = errUnsupportedParam(unsupported.Param)
				} else {
					validationError = errInvalidParam("model", "The selected provider protocol cannot represent this request.")
				}
			}
			continue
		}
		compatible = append(compatible, candidate)
	}
	candidates = compatible
	if len(candidates) == 0 {
		return nil, validationError
	}
	first := candidates[0]
	// A request cannot switch between paid managed execution and owned access.
	sameMode := candidates[:0]
	for _, candidate := range candidates {
		if candidate.Channel.CredentialMode == first.Channel.CredentialMode {
			sameMode = append(sameMode, candidate)
		}
	}
	candidates = sameMode
	// A managed hold authorizes one immutable price tuple. Retries may change
	// credentials, but cannot spend under another provider or price pin.
	if first.Channel.CredentialMode != "byok" {
		pinned := candidates[:0]
		for _, candidate := range candidates {
			if candidate.Channel.CredentialMode == first.Channel.CredentialMode && candidate.Channel.ProviderID == first.Channel.ProviderID && candidate.Price.ID == first.Price.ID && candidate.Price.SalePriceSnapshotID == first.Price.SalePriceSnapshotID && candidate.Price.ExchangeRateSnapshotID == first.Price.ExchangeRateSnapshotID {
				pinned = append(pinned, candidate)
			}
		}
		candidates = pinned
	}

	credential, credErr := p.resolveChannelCredential(ctx, first.Channel, CredentialRef{
		TenantID:          identity.TenantID,
		CredentialID:      first.Channel.CredentialRef,
		CredentialVersion: first.Channel.CredentialVersion,
		ProviderID:        first.Channel.ProviderID,
		Mode:              first.Channel.CredentialMode,
		BaseURL:           first.Channel.BaseURL,
		Protocol:          first.Channel.Protocol,
		Model:             model.ID,
	})
	if credErr != nil {
		// The channel is unusable, not the whole request: let the caller know
		// which failure it was. We do not silently fall through to a channel
		// whose credential we have not resolved.
		p.breaker.RecordFailure(BreakerKey(first.Channel.ID, model.ID))
		return nil, errNoHealthyUpstream()
	}
	return &routedCredentials{channel: first.Channel, adapter: first.Adapter, credential: credential, candidates: candidates}, nil
}

func (p *Proxy) reserve(
	ctx context.Context,
	channel *SnapshotChannel,
	price *SnapshotPriceVersion,
	model *SnapshotModel,
	req *chatRequest,
	identity *Identity,
	requestID string,
	idempotencyKey string,
	inputEstimate, outputEstimate int,
	attribution *RequestAttributionContext,
) (*Reservation, *APIError) {
	if channel.CredentialMode == "byok" {
		// The tenant spends its own provider credit. The outbox event is the
		// record reconciliation uses; no Nexus hold is taken.
		return nil, nil
	}
	if price == nil || price.ID == "" || price.SalePriceSnapshotID == "" {
		return nil, errSnapshot(ReasonSnapshotUnavailable)
	}
	var fx *string
	if price.ExchangeRateSnapshotID != "" {
		value := price.ExchangeRateSnapshotID
		fx = &value
	}
	reservation, err := p.managed.Reserve(ctx, ReserveRequest{
		AttributionContext:     attribution,
		IdempotencyKey:         idempotencyKey,
		TenantID:               identity.TenantID,
		OrganizationID:         identity.OrganizationID,
		RequestID:              requestID,
		KeyID:                  identity.KeyID,
		ModelID:                model.ID,
		Provider:               channel.Provider,
		Currency:               "USD",
		PriceVersionID:         price.ID,
		SalePriceSnapshotID:    price.SalePriceSnapshotID,
		ExchangeRateSnapshotID: fx,
		EstimatedInputTokens:   inputEstimate,
		EstimatedOutputTokens:  outputEstimate,
		TTLSeconds:             900,
	})
	if err != nil {
		if errors.Is(err, ErrBudgetExceeded) {
			return nil, errBudgetExceeded()
		}
		if errors.Is(err, ErrBudgetServiceUnavailable) {
			// Managed traffic fails closed: proceeding without a hold risks
			// unbounded overspend of Nexus funds.
			return nil, errSnapshot(ReasonSnapshotUnavailable)
		}
		return nil, errBudgetExceeded()
	}
	return reservation, nil
}

// ── Attempt execution ─────────────────────────────────────────────────

type attemptResult struct {
	captureFailed  bool
	outcome        Outcome
	errorCode      string
	errorDetail    string
	usage          provider.CanonicalUsage
	usageEstimated bool
	attempts       []AttemptRecord
	channel        *SnapshotChannel
	startedAt      time.Time
	completedAt    time.Time
	// err is the raw failure, used only to pick the public error code.
	err error
	// body is the assembled non-streaming response, held until the terminal
	// record is durable so storage failure can still be reported.
	body []byte
	// wroteHeader records whether any byte of the upstream response reached
	// the client, which decides whether an error can still be rendered as JSON.
	wroteHeader bool
}

// applyUsage records provider-reported usage, or a conservative estimate when
// the provider reported none. An estimate is always flagged so the control
// plane never treats it as an authoritative count.
func (r *attemptResult) applyUsage(usage *provider.CanonicalUsage, req *chatRequest) {
	if usage != nil && !usage.LegacyMissing {
		r.usage = *usage
		return
	}
	r.usageEstimated = true
	r.usage = provider.CanonicalUsage{
		InputTokens:  estimateInputTokens(mustJSON(req.Messages)),
		OutputTokens: estimateOutputTokens(req),
		Estimated:    true,
	}
	if usage != nil {
		r.usage.Observed = usage.Observed
	}
}

// attempt walks the candidate list, honouring the no-unsafe-switch rule.
func (p *Proxy) attempt(
	ctx context.Context,
	w http.ResponseWriter,
	rc *routedCredentials,
	req *chatRequest,
	model *SnapshotModel,
	identity *Identity,
	requestID string,
	streaming bool,
	bundle *GatewayBundle,
	startedAt time.Time,
) *attemptResult {
	result := &attemptResult{outcome: OutcomeFailed, channel: rc.channel, startedAt: startedAt}
	attemptNumber := 0
	var releaseAttempt func()
	defer func() {
		if releaseAttempt != nil {
			releaseAttempt()
		}
	}()

	for index, candidate := range rc.candidates {
		if releaseAttempt != nil {
			releaseAttempt()
			releaseAttempt = nil
		}
		if attemptNumber >= p.maxAttempts {
			break
		}
		attemptNumber++
		candidateStart := p.now()
		breakerKey := BreakerKey(candidate.Channel.ID, model.ID)
		var captured *AttemptRecord
		if p.enableUsageV2 {
			a := p.failedAttempt(candidate, attemptNumber, candidateStart, "")
			a.Status = "pending"
			a.ResolvedModel = model.ID
			a.CatalogVersionID = bundle.Snapshot.CatalogVersion.ID
			a.PolicyVersionID = cloneString(requestAttribution(identity, bundle, req).PolicyVersionID)
			capturer, ok := p.store.(AttemptCapturer)
			if !ok {
				result.captureFailed = true
				result.errorCode = CodeInternal
				return result
			}
			if err := capturer.CaptureAttempt(ctx, requestID, identity.TenantID, &a); err != nil {
				result.captureFailed = true
				result.errorCode = CodeInternal
				result.err = err
				return result
			}
			captured = &a
		}
		result.channel = candidate.Channel
		finish := func(a AttemptRecord) AttemptRecord {
			if captured != nil {
				a.AttemptID = captured.AttemptID
				a.ResolvedModel = captured.ResolvedModel
				a.CatalogVersionID = captured.CatalogVersionID
				a.PolicyVersionID = cloneString(captured.PolicyVersionID)
			}
			return a
		}

		channelLimit := p.limits.ChannelMaxConcurrent
		if channelLimit <= 0 {
			channelLimit = 64
		}
		channelLease, admissionErr := p.limiter.AcquireContext(ctx, ConcurrencyRequest{TenantID: identity.TenantID, ChannelID: candidate.Channel.ID, ChannelLimit: channelLimit, WaitTimeout: p.limits.ConcurrencyWait, AllowLocal: p.allowLocalAdmission()})
		if admissionErr != nil {
			result.errorCode = CodeNoHealthyUpstream
			if errors.Is(admissionErr, ErrConcurrencyLimit) {
				result.errorCode = CodeConcurrencyExceeded
			}
			result.err = admissionErr
			result.attempts = append(result.attempts, finish(p.failedAttempt(candidate, attemptNumber, candidateStart, result.errorCode)))
			if errors.Is(admissionErr, ErrConcurrencyLimit) {
				continue
			}
			return result
		}

		releaseAttempt = channelLease.Release
		credential := rc.credential
		if candidate.Channel.ID != rc.channel.ID || index > 0 || p.limits.ConcurrencyWait > 0 {
			resolved, err := p.resolveChannelCredential(ctx, candidate.Channel, CredentialRef{
				TenantID:          identity.TenantID,
				CredentialID:      candidate.Channel.CredentialRef,
				CredentialVersion: candidate.Channel.CredentialVersion,
				ProviderID:        candidate.Channel.ProviderID,
				Mode:              candidate.Channel.CredentialMode,
				BaseURL:           candidate.Channel.BaseURL,
				Protocol:          candidate.Channel.Protocol,
				Model:             model.ID,
			})
			if err != nil {
				if ctx.Err() == nil {
					p.breaker.RecordFailure(breakerKey)
				}
				result.attempts = append(result.attempts, finish(p.failedAttempt(candidate, attemptNumber, candidateStart, "credential_unavailable")))
				continue
			}
			credential = resolved
		}

		canonical := canonicalChatRequest(req, model)
		call, err := candidate.Adapter.BuildRequest(canonical, credential, provider.Endpoint{
			BaseURL:      candidate.Channel.BaseURL,
			ProviderCode: candidate.Channel.Provider,
			Protocol:     candidate.Channel.Protocol,
			AuthScheme:   candidate.Channel.AuthScheme,
			Region:       candidate.Channel.Region,
			Timeout:      p.limits.UpstreamTimeout,
		})
		if err != nil {
			// A request the adapter cannot build is a client-side problem with
			// this model; it is not switchable and not retryable.
			result.outcome = OutcomeFailed
			result.errorCode = CodeInvalidParameter
			result.attempts = append(result.attempts, finish(p.failedAttempt(candidate, attemptNumber, candidateStart, CodeInvalidParameter)))
			return result
		}

		client, policyErr := p.providerHTTPClient(CredentialRef{TenantID: identity.TenantID, CredentialID: candidate.Channel.CredentialRef, CredentialVersion: candidate.Channel.CredentialVersion, ProviderID: candidate.Channel.ProviderID, Mode: candidate.Channel.CredentialMode, BaseURL: candidate.Channel.BaseURL, Protocol: candidate.Channel.Protocol, Model: model.ID}, credential)
		if candidate.Channel.Transport == "local_sidecar" {
			client = &http.Client{Transport: connectorTransport{hub: p.connectors, channel: candidate.Channel, identity: identity, model: model.ID}}
			policyErr = nil
		}
		if policyErr != nil {
			result.outcome = OutcomeFailed
			result.errorCode = CodeInvalidParameter
			result.attempts = append(result.attempts, finish(p.failedAttempt(candidate, attemptNumber, candidateStart, "credential_unavailable")))
			return result
		}
		if !p.breaker.Allow(breakerKey) {
			channelLease.Release()
			result.attempts = append(result.attempts, finish(p.failedAttempt(candidate, attemptNumber, candidateStart, "circuit_open")))
			continue
		}
		releaseLoad := p.router.BeginRequest(candidate.Channel.ID, model.ID)
		// One attempt includes waiting for headers and consuming the response.
		// The parent still bounds all attempts and carries client/lease cancellation.
		attemptCtx := channelLease.Context()
		var cancelAttempt context.CancelFunc
		if p.limits.UpstreamTimeout > 0 {
			attemptCtx, cancelAttempt = context.WithTimeout(attemptCtx, p.limits.UpstreamTimeout)
		} else {
			attemptCtx, cancelAttempt = context.WithCancel(attemptCtx)
		}
		releaseAttempt = sync.OnceFunc(func() {
			cancelAttempt()
			releaseLoad()
			p.breaker.ReleaseProbe(breakerKey)
			channelLease.Release()
		})
		// Once a socket is assigned, neither a transport error nor an HTTP
		// rejection proves that the provider did not execute the request.
		// Retry only failures before connection assignment.
		var connectionAssigned atomic.Bool
		if candidate.Channel.Transport == "local_sidecar" {
			connectionAssigned.Store(true)
		}
		attemptCtx = httptrace.WithClientTrace(attemptCtx, &httptrace.ClientTrace{GotConn: func(httptrace.GotConnInfo) { connectionAssigned.Store(true) }})
		dispatchStart := p.now()
		stream, err := candidate.Adapter.Stream(attemptCtx, client, call)
		if err != nil {
			releaseAttempt()
			classification := candidate.Adapter.ClassifyError(statusOf(err), bodyOf(err), err)
			if ctx.Err() == nil && !errors.Is(err, context.Canceled) {
				var upstream *provider.UpstreamHTTPError
				var retryAfter time.Duration
				if errors.As(err, &upstream) {
					retryAfter = upstream.RetryAfter
				}
				switch {
				case classification.Kind == provider.ErrInvalidRequest || classification.Kind == provider.ErrContentPolicy:
					// A caller's invalid input or rejected content says nothing
					// about the shared upstream's availability.
				case classification.Kind == provider.ErrQuota && statusOf(err) != 0:
					// A provider-confirmed exhaustion makes this channel/model
					// ineligible for the next request. Never replay this turn.
					p.breaker.Open(breakerKey)
				case classification.Kind == provider.ErrRateLimit || (statusOf(err) == http.StatusServiceUnavailable && retryAfter > 0):
					p.breaker.Cooldown(breakerKey, retryAfter)
				default:
					p.breaker.RecordFailure(breakerKey)
				}
			}
			result.channel = candidate.Channel
			result.errorCode = publicCodeFor(classification.Kind)
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(attemptCtx.Err(), context.DeadlineExceeded) {
				result.errorCode = CodeUpstreamTimeout
			}
			result.err = err

			status := statusOf(err)
			safeRetry := ctx.Err() == nil && !connectionAssigned.Load()
			if connectionAssigned.Load() && status == 0 {
				result.outcome = OutcomeUnknown
				result.applyUsage(nil, req)
			}
			failed := p.failedAttempt(candidate, attemptNumber, candidateStart, string(classification.Kind))
			if result.outcome == OutcomeUnknown {
				failed.Status = string(OutcomeUnknown)
			}
			result.attempts = append(result.attempts, finish(failed))
			if safeRetry && classification.Retryable && index+1 < len(rc.candidates) && attemptNumber < p.maxAttempts {
				continue
			}
			if classification.Kind == provider.ErrAuth {
				p.credentials.Invalidate(CredentialRef{
					TenantID: identity.TenantID, CredentialID: candidate.Channel.CredentialRef,
					CredentialVersion: candidate.Channel.CredentialVersion,
					ProviderID:        candidate.Channel.ProviderID, Mode: candidate.Channel.CredentialMode,
				})
			}
			if result.outcome != OutcomeUnknown && (classification.Kind == provider.ErrRateLimit || classification.Kind == provider.ErrProviderDown) {
				result.outcome = OutcomeFailed
			}
			return result
		}

		// From here on the upstream has accepted the request. There is no
		// switching: a second provider would duplicate work we cannot undo.
		result.channel = candidate.Channel
		// Relay cleanup must not cancel the parent execution context: that signal
		// distinguishes caller/total-budget cancellation from upstream failure.
		usage, buffered, writeErr := p.relayWithOptions(attemptCtx, w, stream, req.Model, requestID, streaming, cancelAttempt, relayOptions{deferDone: true, streamOptions: req.StreamOptions, firstToken: func() { p.breaker.RecordTTFT(breakerKey, p.now().Sub(dispatchStart)) }})
		// Wire adapters must validate their terminal representation before the
		// shared path persists a successful execution fact.
		if writeErr == nil {
			if validator, ok := w.(interface{ ValidateCompletion([]byte) error }); ok {
				writeErr = validator.ValidateCompletion(buffered)
			}
		}
		releaseAttempt()
		result.body = buffered
		_ = stream.Close()
		elapsed := p.now().Sub(candidateStart)

		if writeErr != nil {
			// Either the client went away or writing to it failed. The usage we
			// already observed is still recorded; the outcome is "unknown"
			// unless the stream itself completed.
			result.wroteHeader = streaming
			result.outcome = OutcomeUnknown
			result.errorCode = CodeUpstreamProtocol
			if errors.Is(writeErr, context.DeadlineExceeded) {
				result.errorCode = CodeUpstreamTimeout
			}
			result.err = writeErr
			result.body = nil
			var downstream *downstreamWriteError
			if ctx.Err() == nil && !errors.As(writeErr, &downstream) && !errors.Is(writeErr, context.Canceled) {
				p.breaker.RecordFailure(breakerKey)
			}
			result.applyUsage(usage, req)
			result.attempts = append(result.attempts, finish(p.completedAttempt(candidate, attemptNumber, candidateStart, &result.usage, string(OutcomeUnknown))))
			return result
		}

		p.breaker.RecordSuccess(breakerKey, elapsed)
		result.wroteHeader = streaming
		result.applyUsage(usage, req)
		result.outcome = OutcomeCompleted
		result.err = nil
		result.errorCode = ""
		result.errorDetail = ""
		result.attempts = append(result.attempts, finish(p.completedAttempt(candidate, attemptNumber, candidateStart, &result.usage, string(OutcomeCompleted))))
		result.completedAt = p.now()
		return result
	}

	if result.completedAt.IsZero() {
		result.completedAt = p.now()
	}
	return result
}

func (p *Proxy) failedAttempt(candidate Candidate, number int, started time.Time, code string) AttemptRecord {
	return AttemptRecord{
		AttemptID:            p.newID(),
		AttemptNumber:        number,
		ProviderID:           candidate.Channel.ProviderID,
		ProviderCredentialID: candidate.Channel.CredentialRef,
		ChannelID:            candidate.Channel.ID,
		ConnectionID:         candidate.Channel.ConnectionID,
		ExecutionMode:        candidate.Channel.CredentialMode,
		PriceVersionID:       candidatePriceID(candidate),
		Status:               "failed",
		ErrorCode:            code,
		StartedAt:            started,
		CompletedAt:          p.now(),
	}
}

func (p *Proxy) completedAttempt(candidate Candidate, number int, started time.Time, usage *provider.CanonicalUsage, status string) AttemptRecord {
	record := AttemptRecord{
		AttemptID:            p.newID(),
		AttemptNumber:        number,
		ProviderID:           candidate.Channel.ProviderID,
		ProviderCredentialID: candidate.Channel.CredentialRef,
		ChannelID:            candidate.Channel.ID,
		ConnectionID:         candidate.Channel.ConnectionID,
		ExecutionMode:        candidate.Channel.CredentialMode,
		PriceVersionID:       candidatePriceID(candidate),
		Status:               status,
		StartedAt:            started,
		CompletedAt:          p.now(),
	}
	if usage != nil {
		record.InputTokens = usage.InputTokens
		record.OutputTokens = usage.OutputTokens
		record.CachedTokens = usage.CachedInputTokens
		record.ReasoningTokens = usage.ReasoningTokens
		record.UpstreamRequestID = usage.ProviderRequestID
	}
	return record
}

// relay pumps the upstream stream to the client.
//
// Slow clients: every write carries a deadline. A client that cannot keep up is
// disconnected instead of being buffered without bound, and the upstream is
// closed with it. Disconnect: the request context cancels the upstream call.
func (p *Proxy) relay(
	ctx context.Context,
	w http.ResponseWriter,
	stream provider.Stream,
	modelName, requestID string,
	streaming bool,
	cancelUpstream context.CancelFunc,
) (*provider.CanonicalUsage, []byte, error) {
	return p.relayWithOptions(ctx, w, stream, modelName, requestID, streaming, cancelUpstream, relayOptions{})
}

type relayOptions struct {
	deferDone     bool
	firstToken    func()
	streamOptions *chatStreamOptions
}

func (p *Proxy) relayWithOptions(ctx context.Context, w http.ResponseWriter, stream provider.Stream, modelName, requestID string, streaming bool, cancelUpstream context.CancelFunc, opts relayOptions) (*provider.CanonicalUsage, []byte, error) {
	// Omitted options preserve the gateway's existing usage frames (including the
	// internal Responses adapter). Explicit options control only downstream shape.
	explicitUsage := opts.streamOptions != nil && opts.streamOptions.IncludeUsage
	writer := http.NewResponseController(w)
	reader := newChunkReader(ctx, stream, p.limits.IdleTimeout)
	defer reader.close()
	batch := newStreamBatch(p, w)
	defer batch.close()
	reader.flushAt = batch.timer.C
	reader.flush = batch.flush

	if streaming {
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-cache")
		w.Header().Set("connection", "keep-alive")
		w.Header().Set("x-request-id", requestID)
		w.WriteHeader(http.StatusOK)
	}

	var (
		usage     *provider.CanonicalUsage
		aggregate responseAggregate
		finish    string
		id        = "chatcmpl-" + requestID
		created   = p.now().Unix()
	)
	aggregate.limit = p.limits.MaxResponseBytes
	if streaming {
		if err := p.writeSSE(writer, w, sseChunk(id, requestID, modelName, created, map[string]any{"role": "assistant"}, nil, nil, explicitUsage)); err != nil {
			return nil, nil, err
		}
	}

	for {
		if ctx.Err() != nil {
			return usage, nil, ctx.Err()
		}
		chunk, err := reader.next()
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
		if err != nil {
			if cancelUpstream != nil {
				cancelUpstream()
			}
			if errors.Is(err, io.EOF) {
				err = provider.ErrStreamTruncated
			}
			return usage, nil, err
		}
		if opts.firstToken != nil && (chunk.Text != "" || chunk.Reasoning != "" || (chunk.Refusal != nil && *chunk.Refusal != "") || len(chunk.ToolCallDelta) > 0) {
			opts.firstToken()
			opts.firstToken = nil
		}
		if chunk.FinishReason != "" {
			finish = chunk.FinishReason
		}
		deltas, err := parseToolDeltas(chunk.ToolCallDelta)
		if err != nil {
			return usage, nil, err
		}
		if !streaming {
			if err := aggregate.add(chunk, deltas); err != nil {
				return usage, nil, err
			}
		}
		if streaming {
			delta := map[string]any{}
			if chunk.Text != "" {
				delta["content"] = chunk.Text
			}
			if chunk.Reasoning != "" {
				delta["reasoning_content"] = chunk.Reasoning
			}
			if chunk.Refusal != nil {
				delta["refusal"] = *chunk.Refusal
			}
			if chunk.ToolCallDelta != nil {
				delta["tool_calls"] = chunk.ToolCallDelta
			}
			var finishReason any
			if chunk.FinishReason != "" {
				finishReason = chunk.FinishReason
			}
			if len(delta) > 0 || finishReason != nil {
				if err := batch.emit(sseChunk(id, requestID, modelName, created, delta, finishReason, nil, explicitUsage), finishReason != nil); err != nil {
					return usage, nil, err
				}
			}
		}
		if chunk.Done {
			break
		}
	}

	if streaming {
		if err := batch.flush(); err != nil {
			return usage, nil, err
		}
		if explicitUsage || (opts.streamOptions == nil && usage != nil) {
			wireUsage := usage
			if wireUsage == nil {
				wireUsage = &provider.CanonicalUsage{Observed: &provider.ObservedUsage{}}
			}
			usageJSON := chatUsage(wireUsage)
			if err := p.writeSSE(writer, w, sseChunk(id, requestID, modelName, created, map[string]any{}, nil, usageJSON)); err != nil {
				return usage, nil, err
			}
		}
		if !opts.deferDone {
			if err := p.writeSSE(writer, w, []byte("data: [DONE]\n\n")); err != nil {
				return usage, nil, err
			}
		}
		return usage, nil, nil
	}

	// Non-streaming: assemble one completion object from the same chunks.
	if finish == "" {
		finish = "stop"
	}
	completion := map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   modelName,
		"choices": []map[string]any{{
			"index":         0,
			"message":       aggregate.message(),
			"finish_reason": finish,
		}},
	}
	if usage != nil {
		completion["usage"] = chatUsage(usage)
	}
	// The body is returned instead of written: the caller persists the terminal
	// record first, so an uncommittable outbox can still fail closed rather than
	// having already told the client the request succeeded.
	encoded, err := json.Marshal(completion)
	if err == nil && len(encoded) > aggregate.limit {
		err = errors.New("upstream response exceeds aggregation limit")
	}
	if err != nil {
		return usage, nil, err
	}
	return usage, encoded, nil
}

// errUpstreamIdle marks a stalled upstream, which maps to 504.
var errUpstreamIdle = errors.New("upstream idle timeout")

// writeSSE writes one event with a bounded write deadline.
func (p *Proxy) writeSSE(controller *http.ResponseController, w http.ResponseWriter, payload []byte) error {
	return p.writeSSEWithPhase(controller, w, payload, intermediateWrite)
}

func (p *Proxy) writeFinalSSE(w http.ResponseWriter, payload []byte) error {
	return p.writeSSEWithPhase(http.NewResponseController(w), w, payload, terminalWrite)
}

func (p *Proxy) writeSSEWithPhase(controller *http.ResponseController, w http.ResponseWriter, payload []byte, phase downstreamWritePhase) error {
	return p.withDownstreamWriteDeadline(w, phase, func() error {
		if _, err := w.Write(payload); err != nil {
			return err
		}
		return controller.Flush()
	})
}

func sseChunk(id, requestID, model string, created int64, delta map[string]any, finishReason any, usage map[string]any, includeUsageNull ...bool) []byte {
	payload := map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"delta":         delta,
			"finish_reason": finishReason,
		}},
	}
	if usage != nil {
		payload["choices"] = []map[string]any{}
		payload["usage"] = usage
	} else if len(includeUsageNull) > 0 && includeUsageNull[0] {
		payload["usage"] = nil
	}
	encoded, _ := json.Marshal(payload)
	return append(append([]byte("data: "), encoded...), '\n', '\n')
}

// ── Terminal record ───────────────────────────────────────────────────

func (p *Proxy) buildTerminalRecord(
	result *attemptResult,
	rc *routedCredentials,
	bundle *GatewayBundle,
	model *SnapshotModel,
	req *chatRequest,
	identity *Identity,
	requestID string,
	startedAt time.Time,
	reservation *Reservation,
	idempotencyKey string,
) *TerminalRecord {
	final := AttemptRecord{AttemptID: p.newID(), AttemptNumber: 1}
	if len(result.attempts) > 0 {
		final = result.attempts[len(result.attempts)-1]
	}
	channelKind := "platform"
	if result.channel.CredentialMode == "byok" {
		channelKind = "byok"
	}
	priceVersionID := ""
	saleSnapshotID := ""
	exchangeRateSnapshotID := ""
	if price := bundle.LookupPrice(result.channel.Provider, model.ID, result.channel.Region); price != nil {
		priceVersionID = price.ID
		saleSnapshotID = price.SalePriceSnapshotID
		exchangeRateSnapshotID = price.ExchangeRateSnapshotID
	}
	catalogVersionID := ""
	if bundle.Snapshot.CatalogVersion != nil {
		catalogVersionID = bundle.Snapshot.CatalogVersion.ID
	}

	completedAt := result.completedAt
	if completedAt.IsZero() {
		completedAt = p.now()
	}
	cached := result.usage.CachedInputTokens
	reasoning := result.usage.ReasoningTokens
	event := UsageEvent{
		SchemaVersion:    usageEventSchemaVersion,
		EventID:          newEventID(p.newID()),
		OccurredAt:       completedAt.UTC().Format(time.RFC3339),
		TenantID:         identity.TenantID,
		RequestID:        requestID,
		AttemptID:        final.AttemptID,
		ModelID:          model.ID,
		Status:           string(result.outcome),
		PriceVersionID:   priceVersionID,
		CatalogVersionID: catalogVersionID,
		Usage: UsageEventUsage{
			InputTokens:  result.usage.InputTokens,
			OutputTokens: result.usage.OutputTokens,
			Estimated:    result.usageEstimated || result.usage.Estimated || result.outcome == OutcomeUnknown,
		},
		Dimensions: map[string]any{
			"channel_id": result.channel.ID,
			"provider":   result.channel.Provider,
			"streaming":  req.Stream != nil && *req.Stream,
		},
	}
	if result.usage.ProviderRequestID != "" {
		id := result.usage.ProviderRequestID
		event.ProviderRequestID = &id
	}
	if cached > 0 {
		event.Usage.CachedInputTokens = &cached
	}
	if reasoning > 0 {
		event.Usage.ReasoningTokens = &reasoning
	}
	record := &TerminalRecord{
		RequestID:              requestID,
		TenantID:               identity.TenantID,
		OrganizationID:         identity.OrganizationID,
		DownstreamKeyID:        identity.KeyID,
		RequestModel:           req.Model,
		ProviderID:             result.channel.ProviderID,
		ResolvedUpstreamModel:  model.ID,
		ProviderCredentialID:   result.channel.CredentialRef,
		ChannelKind:            channelKind,
		Status:                 string(result.outcome),
		InputTokens:            result.usage.InputTokens,
		OutputTokens:           result.usage.OutputTokens,
		CachedTokens:           cached,
		ReasoningTokens:        reasoning,
		ProviderPriceVersionID: priceVersionID,
		SalePriceSnapshotID:    saleSnapshotID,
		ExchangeRateSnapshotID: exchangeRateSnapshotID,
		ChargeCurrency:         "USD",
		IdempotencyKey:         idempotencyKey,
		ErrorCode:              result.errorCode,
		ErrorDetail:            truncate(result.errorDetail, maxStoredErrorDetail),
		UpstreamRequestID:      result.usage.ProviderRequestID,
		TraceID:                requestID,
		StartedAt:              startedAt,
		CompletedAt:            completedAt,
		Attempts:               result.attempts,
		Event:                  event,
	}
	if p.enableUsageV2 {
		for i := range record.Attempts {
			record.Attempts[i].ResolvedModel = model.ID
			record.Attempts[i].CatalogVersionID = catalogVersionID
		}
		record.AttributionContext = requestAttribution(identity, bundle, req)
		for i := range record.Attempts {
			record.Attempts[i].PolicyVersionID = cloneString(record.AttributionContext.PolicyVersionID)
		}
		record.EventV2 = buildUsageEventV2(record, result, model, req)
		record.ProjectID = identity.ProjectID
		record.ProjectName = identity.ProjectName
		record.AttributionStatus = identity.AttributionStatus
		record.ExecutionMode = result.channel.CredentialMode
		record.ConnectionID = result.channel.ConnectionID
	}
	if reservation != nil {
		record.ReservationAmount = reservation.AmountMicros
		record.ChargeCurrency = orDefault(reservation.Currency, "USD")
		if !reservation.ExpiresAt.IsZero() {
			expires := reservation.ExpiresAt
			record.ReservationExpiresAt = &expires
		}
	}
	if len(record.Attempts) == 0 {
		record.Attempts = []AttemptRecord{final}
	}
	return record
}

// ── Parsing helpers ───────────────────────────────────────────────────

func readBounded(r *http.Request, maxBytes int64) ([]byte, *APIError) {
	limited := http.MaxBytesReader(nil, r.Body, maxBytes)
	body, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, errRequestTooLarge()
		}
		return nil, errInvalidJSON()
	}
	return body, nil
}

func parseChatRequest(body []byte, maxTokensEstimate int) (*chatRequest, *APIError) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, errInvalidJSON()
	}
	for key := range raw {
		if !allowedChatParams[key] {
			param := key
			return nil, &APIError{
				Status: http.StatusBadRequest, Code: CodeUnsupportedParam, Type: TypeInvalidRequest,
				Message: "Unsupported parameter.", Param: &param,
			}
		}
	}
	if options, exists := raw["stream_options"]; exists && strings.TrimSpace(string(options)) != "null" {
		var fields map[string]json.RawMessage
		if json.Unmarshal(options, &fields) != nil || fields == nil {
			return nil, errInvalidParam("stream_options", "stream_options must be an object or null.")
		}
		for key, value := range fields {
			if key != "include_usage" {
				return nil, errUnsupportedParam("stream_options." + key)
			}
			var flag *bool
			if json.Unmarshal(value, &flag) != nil || flag == nil {
				return nil, errInvalidParam("stream_options.include_usage", "include_usage must be a boolean.")
			}
		}
	}
	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, errInvalidJSON()
	}
	if req.StreamOptions != nil && (req.Stream == nil || !*req.Stream) {
		return nil, errInvalidParam("stream_options", "stream_options requires stream: true.")
	}
	if req.Model == "" {
		return nil, errInvalidParam("model", "model is required.")
	}
	if len(req.Messages) == 0 {
		return nil, errInvalidParam("messages", "messages must be a non-empty array.")
	}
	for i, message := range req.Messages {
		switch message.Role {
		case "system", "user", "assistant", "tool", "developer":
		default:
			return nil, errInvalidParam(fmt.Sprintf("messages[%d].role", i), "Unsupported message role.")
		}
		if len(message.Content) == 0 && len(message.ToolCalls) == 0 && !(message.Role == "assistant" && message.Refusal != nil) {
			return nil, errInvalidParam(fmt.Sprintf("messages[%d].content", i), "Message content is required.")
		}
	}
	if req.MaxTokens != nil && (*req.MaxTokens < 1 || *req.MaxTokens > maxTokensEstimate) {
		return nil, errInvalidParam("max_tokens", "max_tokens is out of range.")
	}
	if req.MaxCompletionTokens != nil && (*req.MaxCompletionTokens < 1 || *req.MaxCompletionTokens > maxTokensEstimate) {
		return nil, errInvalidParam("max_completion_tokens", "max_completion_tokens is out of range.")
	}
	if req.Temperature != nil && (*req.Temperature < 0 || *req.Temperature > 2) {
		return nil, errInvalidParam("temperature", "temperature must be between 0 and 2.")
	}
	if req.TopP != nil && (*req.TopP < 0 || *req.TopP > 1) {
		return nil, errInvalidParam("top_p", "top_p must be between 0 and 1.")
	}
	var stopErr *APIError
	req.stopSequences, stopErr = parseStop(req.Stop)
	if stopErr != nil {
		return nil, stopErr
	}
	return &req, nil
}

func effectiveMaxTokens(req *chatRequest, model *SnapshotModel) *int {
	if req.MaxCompletionTokens != nil {
		return req.MaxCompletionTokens
	}
	if req.MaxTokens != nil {
		return req.MaxTokens
	}
	return nil
}

// parseStop preserves explicit strings and treats null as no stop sequences.
// Null array members cannot be decoded as empty strings; malformed input must
// fail before it changes the request's stopping behavior or incurs a charge.
func parseStop(raw json.RawMessage) ([]string, *APIError) {
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "null" {
		return nil, nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}, nil
	}
	var many []*string
	if err := json.Unmarshal(raw, &many); err != nil || len(many) > 4 {
		return nil, errInvalidParam("stop", "stop must be a string, an array of up to 4 strings, or null.")
	}
	var sequences []string
	for _, item := range many {
		if item == nil {
			return nil, errInvalidParam("stop", "stop array elements must be strings.")
		}
		sequences = append(sequences, *item)
	}
	return sequences, nil
}

// estimateInputTokens is the pre-flight estimate used for limits and holds. It
// is deliberately conservative; the usage event carries the real counts.
func estimateInputTokens(body []byte) int {
	estimate := len(body) / 3
	if estimate < 1 {
		estimate = 1
	}
	return estimate
}

func (p *Proxy) outputEstimate(req *chatRequest) int {
	if req.MaxCompletionTokens != nil {
		return *req.MaxCompletionTokens
	}
	if req.MaxTokens != nil {
		return *req.MaxTokens
	}
	return 1024
}

func estimateOutputTokens(req *chatRequest) int {
	if req.MaxCompletionTokens != nil {
		return *req.MaxCompletionTokens
	}
	if req.MaxTokens != nil {
		return *req.MaxTokens
	}
	return 0
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

// ── Error mapping ─────────────────────────────────────────────────────

func statusOf(err error) int {
	var upstream *provider.UpstreamHTTPError
	if errors.As(err, &upstream) {
		return upstream.Status
	}
	return 0
}

func bodyOf(err error) []byte {
	var upstream *provider.UpstreamHTTPError
	if errors.As(err, &upstream) {
		return upstream.Body
	}
	return nil
}

// publicCodeFor maps a canonical error kind to the public error code.
func publicCodeFor(kind provider.CanonicalError) string {
	switch kind {
	case provider.ErrAuth:
		return CodeNoHealthyUpstream
	case provider.ErrRateLimit:
		return CodeRateLimitExceeded
	case provider.ErrQuota:
		return CodeBudgetExceeded
	case provider.ErrInvalidRequest:
		return CodeInvalidParameter
	case provider.ErrContentPolicy:
		return CodeCapabilityUnsupported
	case provider.ErrTransient, provider.ErrProviderDown:
		return CodeUpstreamProtocol
	default:
		return CodeNoHealthyUpstream
	}
}

// ── Request id ────────────────────────────────────────────────────────

// ensureRequestID returns the private server identity. Direct single-endpoint
// invocation outside the router still gets a generated identity. Wire adapters
// use withRequestIdentity before delegating so all layers keep the same ID.
func ensureRequestID(r *http.Request) string {
	if id, _ := r.Context().Value(requestIdentityKey{}).(string); id != "" {
		return id
	}
	return newRandomID()
}

func isSafeID(id string) bool {
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

func newRandomID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("req_%d", time.Now().UnixNano())
	}
	return "req_" + hex.EncodeToString(buf[:])
}

// newEventID builds an event id that satisfies the contract's 16-character
// minimum without embedding tenant or request identifiers.
func newEventID(seed string) string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("evt_%d_%s", time.Now().UnixNano(), seed)
	}
	return "evt_" + hex.EncodeToString(buf[:])
}

// ── Idempotency guard ─────────────────────────────────────────────────

// claimIdempotency reserves a client idempotency key. With Redis configured the
// claim is fleet-wide, so two gateway instances cannot both spend for the same
// key; without it the guard is per-instance and the database unique index is the
// backstop.
func (p *Proxy) claimIdempotency(ctx context.Context, tenantID, key string) bool {
	if p.limiter.HasRedis() {
		claimed, err := p.limiter.ClaimIdempotency(ctx, idempotencyRedisKey(tenantID, key), 15*time.Minute)
		if err == nil {
			return claimed
		}
		// Redis is down: the local guard still prevents the common case.
	}
	return p.idempotency.claim(tenantID, key, "", p.now())
}

func (p *Proxy) releaseIdempotency(tenantID, key string) {
	p.idempotency.release(tenantID, key)
	if p.limiter.HasRedis() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = p.limiter.ReleaseIdempotency(releaseCtx, idempotencyRedisKey(tenantID, key))
	}
}

func idempotencyRedisKey(tenantID, key string) string {
	return "nexus:idem:" + tenantID + "|" + key
}

// idempotencyCache turns a duplicate client key into a conflict instead of a
// second upstream call. It is deliberately in-memory and bounded: the durable
// guarantee is the unique index on (tenant_id, idempotency_key), and this guard
// exists to stop the second spend before it happens.
type idempotencyCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	ttl     time.Duration
	maxSize int
}

func newIdempotencyCache(ttl time.Duration, maxSize int) *idempotencyCache {
	return &idempotencyCache{entries: make(map[string]time.Time), ttl: ttl, maxSize: maxSize}
}

// claim returns true when the key was free. The entry is released when the
// request finishes so the client can retry a genuinely failed request.
func (c *idempotencyCache) claim(tenantID, key, requestID string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sweepLocked(now)
	cacheKey := tenantID + "|" + key
	if expiresAt, exists := c.entries[cacheKey]; exists && now.Before(expiresAt) {
		return false
	}
	c.entries[cacheKey] = now.Add(c.ttl)
	return true
}

func (c *idempotencyCache) release(tenantID, key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, tenantID+"|"+key)
}

func (c *idempotencyCache) sweepLocked(now time.Time) {
	if len(c.entries) < c.maxSize {
		// Opportunistic expiry so the map cannot grow without bound.
		if len(c.entries)%1024 != 0 {
			return
		}
	}
	for key, expiresAt := range c.entries {
		if now.After(expiresAt) {
			delete(c.entries, key)
		}
	}
	if len(c.entries) >= c.maxSize {
		// Still full: drop entries rather than refuse service. Losing an
		// in-memory claim only means the unique index has to catch the
		// duplicate, which it does.
		for key := range c.entries {
			delete(c.entries, key)
			if len(c.entries) < c.maxSize/2 {
				break
			}
		}
	}
}

// Production provider clients can only be minted by the independently authorized
// Vault resolver. Budget/control-plane clients never carry provider credentials.
func (p *Proxy) providerHTTPClient(ref CredentialRef, credential provider.Credential) (*http.Client, error) {
	if resolver, ok := p.credentials.(*VaultCredentialResolver); ok {
		return resolver.BoundClient(ref, credential)
	}
	if p.env != nil && p.env.Environment == "production" {
		return nil, errSecretPolicy
	}
	if resolver, ok := p.credentials.(*LocalCredentialResolver); ok {
		return resolver.BoundClient(ref, credential)
	}
	return p.httpClient, nil
}

// Empty is an internal optional pin; canonical v2 and SQL persist it as null.
func candidatePriceID(candidate Candidate) string {
	if candidate.Price == nil {
		return ""
	}
	return candidate.Price.ID
}
