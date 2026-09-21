package main

// Independent budget authorization; Worker alone settles usage.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ErrBudgetServiceUnavailable marks a transport or 5xx failure talking to the
// reservation API. Callers apply the managed/BYOK degradation policy.
var ErrBudgetServiceUnavailable = errors.New("budget service unavailable")

// ErrBudgetExceeded means the budget service refused the reservation.
var ErrBudgetExceeded = errors.New("budget exceeded")

// Reservation is a granted hold.
type Reservation struct {
	ReservationID string    `json:"reservation_id"`
	AmountMicros  int64     `json:"amount_micros"`
	Currency      string    `json:"currency"`
	ExpiresAt     time.Time `json:"expires_at"`
}

// ReserveRequest asks the budget service to hold budget for one request.
//
// The gateway sends token counts, not money. The budget service owns the pricing
// engine and the ledger (INVARIANTS #2/#4), so it — and only it — converts
// tokens to a hold amount. A second money implementation in Go would be a
// second source of monetary truth.
type ReserveRequest struct {
	AttributionContext     *RequestAttributionContext `json:"attribution_context,omitempty"`
	IdempotencyKey         string                     `json:"idempotency_key,omitempty"`
	Version                int                        `json:"version"`
	SalePriceSnapshotID    string                     `json:"sale_price_snapshot_id"`
	ExchangeRateSnapshotID *string                    `json:"exchange_rate_snapshot_id"`
	TenantID               string                     `json:"tenant_id"`
	OrganizationID         string                     `json:"organization_id"`
	RequestID              string                     `json:"request_id"`
	KeyID                  string                     `json:"key_id"`
	ModelID                string                     `json:"model_id"`
	Provider               string                     `json:"provider"`
	Currency               string                     `json:"currency"`
	// PriceVersionID pins the price version the estimate was based on, so the
	// budget service cannot silently price against a newer version.
	PriceVersionID        string `json:"price_version_id"`
	EstimatedInputTokens  int    `json:"estimated_input_tokens"`
	EstimatedOutputTokens int    `json:"estimated_output_tokens"`
	// TTLSeconds bounds the hold so a crashed gateway cannot strand budget.
	TTLSeconds int `json:"ttl_seconds"`
}

type Reserver interface {
	Reserve(context.Context, ReserveRequest) (*Reservation, error)
}

// ── HTTP implementation ───────────────────────────────────────────────

// HTTPReserver calls the thin budget-service endpoints over the internal token.
type HTTPReserver struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func NewHTTPReserver(baseURL, token string, client *http.Client) *HTTPReserver {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &HTTPReserver{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, Client: &safeClient}
}

type reserveResponse struct {
	Replayed      *bool  `json:"replayed"`
	ReservationID string `json:"reservation_id"`
	AmountMicros  string `json:"amount_micros"`
	Currency      string `json:"currency"`
	ExpiresAt     string `json:"expires_at"`
	Error         *struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (h *HTTPReserver) Reserve(ctx context.Context, req ReserveRequest) (*Reservation, error) {
	if h.BaseURL == "" || h.Token == "" {
		return nil, ErrBudgetServiceUnavailable
	}
	req.Version = 1
	var out reserveResponse
	status, err := h.post(ctx, "/v1/reservations", req, &out)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusOK:
		expiresAt, expiryErr := time.Parse(time.RFC3339, out.ExpiresAt)
		amount, amountErr := strconv.ParseInt(out.AmountMicros, 10, 64)
		if out.Replayed == nil || expiryErr != nil || !expiresAt.After(time.Now()) || amountErr != nil || amount <= 0 || strconv.FormatInt(amount, 10) != out.AmountMicros || out.ReservationID == "" || out.Currency != req.Currency {
			return nil, fmt.Errorf("%w: invalid authorization response", ErrBudgetServiceUnavailable)
		}
		return &Reservation{
			ReservationID: out.ReservationID,
			AmountMicros:  amount,
			Currency:      out.Currency,
			ExpiresAt:     expiresAt,
		}, nil
	case status == http.StatusTooManyRequests || status == http.StatusPaymentRequired:
		return nil, ErrBudgetExceeded
	case status >= 500:
		return nil, fmt.Errorf("%w: reserve http %d", ErrBudgetServiceUnavailable, status)
	default:
		return nil, fmt.Errorf("reserve rejected: http %d", status)
	}
}

func (h *HTTPReserver) post(ctx context.Context, path string, body any, out any) (int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+h.Token)
	resp, err := h.Client.Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBudgetServiceUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if readErr != nil || len(raw) > 64<<10 {
		return 0, fmt.Errorf("%w: invalid response body", ErrBudgetServiceUnavailable)
	}
	if len(raw) > 0 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return 0, fmt.Errorf("%w: invalid response JSON", ErrBudgetServiceUnavailable)
		}
	}
	return resp.StatusCode, nil
}

// ── BYOK implementation ───────────────────────────────────────────────

// NoopReserver is used for BYOK traffic: there is no Nexus balance to hold.
// The outbox event still records the usage so reconciliation can bill later.
type NoopReserver struct{}

func (NoopReserver) Reserve(context.Context, ReserveRequest) (*Reservation, error) {
	return &Reservation{ReservationID: "", AmountMicros: 0}, nil
}
