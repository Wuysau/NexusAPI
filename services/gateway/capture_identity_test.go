package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestCaptureDatabaseErrorsIdentifyOnlyKnownIdempotencyConstraints(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want error
	}{
		{"tenant idempotency", &pgconn.PgError{Code: "23505", ConstraintName: "requests_tenant_idempotency_idx", Detail: "private key value"}, ErrDuplicateRequest},
		{"unverified legacy idempotency", fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "23505", ConstraintName: "requests_idempotency_idx", Detail: "private organization"}), ErrStoreUnavailable},
		{"global primary key", &pgconn.PgError{Code: "23505", ConstraintName: "request_records_pkey", Detail: "private request id"}, ErrStoreUnavailable},
		{"unrelated unique", &pgconn.PgError{Code: "23505", ConstraintName: "request_project_facts_pkey", Detail: "private project id"}, ErrStoreUnavailable},
		{"different error code", &pgconn.PgError{Code: "23503", ConstraintName: "requests_tenant_idempotency_idx", Detail: "private foreign key"}, ErrStoreUnavailable},
		{"error text is not evidence", errors.New("requests_tenant_idempotency_idx 23505 private database URL"), ErrStoreUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyCaptureError(tc.err, nil); got != tc.want {
				t.Fatalf("classification must be sanitized sentinel %v, got %v", tc.want, got)
			}
		})
	}
}

func TestCaptureLegacyIdempotencyRequiresVerifiedTenantScope(t *testing.T) {
	legacyError := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "23505", ConstraintName: "requests_idempotency_idx", Detail: "private organization"})
	for _, tc := range []struct {
		name      string
		sameScope bool
		checkErr  error
		want      error
	}{
		{"same tenant organization and key", true, nil, ErrDuplicateRequest},
		{"different tenant", false, nil, ErrStoreUnavailable},
		{"scope query failed", false, errors.New("private database address"), ErrStoreUnavailable},
		{"failed check cannot authorize true", true, errors.New("private transaction details"), ErrStoreUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			got := classifyCaptureError(legacyError, func() (bool, error) {
				calls++
				return tc.sameScope, tc.checkErr
			})
			if calls != 1 || got != tc.want {
				t.Fatalf("legacy confirmation calls=%d classification=%v, want %v", calls, got, tc.want)
			}
		})
	}
	for _, constraint := range []string{"requests_tenant_idempotency_idx", "request_records_pkey"} {
		_ = classifyCaptureError(&pgconn.PgError{Code: "23505", ConstraintName: constraint}, func() (bool, error) {
			t.Fatal("scope query is reserved for the legacy index")
			return true, nil
		})
	}
}

// Generate a real v2 capture/terminal pair, including its immutable attribution,
// so the memory-store tests exercise the same record validation as the proxy.
func captureIdentityFixture(t *testing.T) (*FrozenRequest, *TerminalRecord) {
	t.Helper()
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "capture-identity-fixture"})
	body := readAll(response)
	if response.StatusCode != 200 || len(h.store.CapturedRequests()) != 1 || len(h.store.Requests()) != 1 {
		t.Fatalf("real capture/terminal fixture failed: %d %s", response.StatusCode, body)
	}
	return h.store.CapturedRequests()[0], h.store.Requests()[0]
}

func copyCaptureFixture[T any](t *testing.T, value T) T {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		t.Fatal(err)
	}
	return copy
}

func TestMemoryCaptureEnforcesGlobalRequestID(t *testing.T) {
	frozen, _ := captureIdentityFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*FrozenRequest)
	}{
		{"same identity", func(*FrozenRequest) {}},
		{"other tenant", func(r *FrozenRequest) { r.TenantID = "another-tenant" }},
		{"other idempotency key", func(r *FrozenRequest) { r.IdempotencyKey = "another-idempotency-key" }},
		{"other tenant and key", func(r *FrozenRequest) { r.TenantID = "another-tenant"; r.IdempotencyKey = "another-key" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemoryStore()
			if err := store.CaptureRequest(context.Background(), frozen); err != nil {
				t.Fatal(err)
			}
			collision := copyCaptureFixture(t, frozen)
			tc.mutate(collision)
			if err := store.CaptureRequest(context.Background(), collision); !errors.Is(err, ErrStoreUnavailable) {
				t.Fatalf("global primary-key collision must fail: %v", err)
			}
			if len(store.CapturedRequests()) != 1 {
				t.Fatal("collision inserted a second capture")
			}
		})
	}
}

func TestMemoryCaptureAndTerminalShareIdempotencyIndex(t *testing.T) {
	frozen, terminal := captureIdentityFixture(t)
	for _, terminalFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("terminal-first-%t", terminalFirst), func(t *testing.T) {
			store := NewMemoryStore()
			if terminalFirst {
				if err := store.PersistTerminal(context.Background(), terminal); err != nil {
					t.Fatal(err)
				}
			} else if err := store.CaptureRequest(context.Background(), frozen); err != nil {
				t.Fatal(err)
			}
			other := copyCaptureFixture(t, frozen)
			other.RequestID = "different-server-request-id"
			if err := store.CaptureRequest(context.Background(), other); !errors.Is(err, ErrDuplicateRequest) {
				t.Fatalf("distinct request with same tenant idempotency key must conflict: %v", err)
			}
			other.TenantID = "different-tenant"
			other.OrganizationID = "different-organization"
			if err := store.CaptureRequest(context.Background(), other); err != nil {
				t.Fatalf("idempotency key leaked across tenants: %v", err)
			}
		})
	}
}

func TestMemoryTerminalRejectsGlobalIDReuse(t *testing.T) {
	frozen, terminal := captureIdentityFixture(t)
	store := NewMemoryStore()
	if err := store.PersistTerminal(context.Background(), terminal); err != nil {
		t.Fatal(err)
	}
	capture := copyCaptureFixture(t, frozen)
	capture.TenantID, capture.IdempotencyKey = "other-tenant", "other-key"
	if err := store.CaptureRequest(context.Background(), capture); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("capture reused terminal primary key: %v", err)
	}
	other := copyCaptureFixture(t, terminal)
	other.TenantID, other.IdempotencyKey = "other-tenant", "other-key"
	other.Event.TenantID, other.EventV2.TenantId = other.TenantID, other.TenantID
	if err := store.PersistTerminal(context.Background(), other); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("terminal reused another tenant's primary key: %v", err)
	}
	if len(store.Requests()) != 1 || store.OutboxCount("other-tenant") != 0 {
		t.Fatal("global request id collision created a second terminal/outbox fact")
	}
}

func TestMemoryTerminalMustMatchCapturedScope(t *testing.T) {
	frozen, terminal := captureIdentityFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*FrozenRequest)
	}{
		{"tenant", func(r *FrozenRequest) { r.TenantID = "another-tenant" }},
		{"organization", func(r *FrozenRequest) { r.OrganizationID = "another-organization" }},
		{"idempotency key", func(r *FrozenRequest) { r.IdempotencyKey = "another-idempotency-key" }},
		{"api key", func(r *FrozenRequest) { r.Attribution.APIKeyID = "another-api-key" }},
		{"model", func(r *FrozenRequest) { r.Attribution.RequestedModel = "another-model" }},
		{"project", func(r *FrozenRequest) { r.Attribution.ProjectID = nullableString("another-project") }},
		{"catalog", func(r *FrozenRequest) { r.Attribution.CatalogVersionID = "another-catalog" }},
		{"streaming", func(r *FrozenRequest) { r.Attribution.Streaming = !r.Attribution.Streaming }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemoryStore()
			captured := copyCaptureFixture(t, frozen)
			tc.mutate(captured)
			if err := store.CaptureRequest(context.Background(), captured); err != nil {
				t.Fatal(err)
			}
			if err := store.PersistTerminal(context.Background(), terminal); !errors.Is(err, ErrReservationConflict) {
				t.Fatalf("terminal replaced frozen %s: %v", tc.name, err)
			}
			if len(store.Requests()) != 0 || store.OutboxCount(terminal.TenantID) != 0 {
				t.Fatal("scope conflict recorded a terminal fact")
			}
		})
	}
}

func TestMemoryCapturedIdentityRemainsImmutableAndAllowsNormalTerminal(t *testing.T) {
	frozen, terminal := captureIdentityFixture(t)
	store := NewMemoryStore()
	if err := store.CaptureRequest(context.Background(), frozen); err != nil {
		t.Fatal(err)
	}
	frozen.TenantID = "mutated-input-tenant"
	*frozen.Attribution.ProjectID = "mutated-input-project"
	view := store.CapturedRequests()[0]
	view.OrganizationID = "mutated-observed-organization"
	*view.Attribution.ProjectID = "mutated-observed-project"
	if err := store.PersistTerminal(context.Background(), terminal); err != nil {
		t.Fatalf("matching capture -> terminal transition must succeed: %v", err)
	}
	if len(store.Requests()) != 1 || store.OutboxCount(terminal.TenantID) != 1 {
		t.Fatal("normal capture/terminal did not persist exactly one usage fact")
	}
}

func TestMemoryTerminalCannotReplacePendingCaptureWithAnotherRequestID(t *testing.T) {
	frozen, terminal := captureIdentityFixture(t)
	store := NewMemoryStore()
	if err := store.CaptureRequest(context.Background(), frozen); err != nil {
		t.Fatal(err)
	}
	terminal.RequestID = "replacement-request-id"
	terminal.Event.RequestID, terminal.EventV2.RequestId = terminal.RequestID, terminal.RequestID
	if err := store.PersistTerminal(context.Background(), terminal); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("a different request cannot complete the captured identity: %v", err)
	}
	if len(store.Requests()) != 0 || store.OutboxCount(frozen.TenantID) != 0 {
		t.Fatal("pending capture was replaced by another request")
	}
}
