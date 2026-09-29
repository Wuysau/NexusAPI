package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// This fixture is destructive only within the explicitly named disposable DB.
// Real customer credentials/KMS are deliberately outside this boundary exercise.
func TestBudgetPostgresControlPlaneOutage(t *testing.T) {
	dsn := os.Getenv("GATEWAY_BUDGET_INTEGRATION_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GATEWAY_BUDGET_INTEGRATION_DATABASE_URL for isolated actual-service test")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || cfg.Database != "convergence_gateway27" || cfg.Host != "127.0.0.1" || cfg.Port != 55439 {
		t.Fatal("fixture must be loopback:55439/convergence_gateway27")
	}
	ctx := context.Background()
	db, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx) }()
	exec := func(sql string) {
		t.Helper()
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
	for _, name := range []string{"0000_left_nekra.sql", "0001_greedy_shape.sql", "0002_auth_secret_plane.sql", "0003_worker_outbox_retry.sql"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "drizzle", name))
		if err != nil {
			t.Fatal(err)
		}
		exec(string(raw))
	}
	exec(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org-test','tenant-test','Fixture','gateway27');
 INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix) VALUES('key-test','tenant-test','org-test','Fixture','fixture-hash','fixture');
 INSERT INTO providers(id,code,name,official_base_url) VALUES('prov_openai','openai','Fixture','http://127.0.0.1');
 INSERT INTO provider_credentials(id,provider_id,name,encrypted_secret,is_platform_managed) VALUES('cred_test','prov_openai','Fixture','synthetic-never-decrypted',true),('cred_byok_test','prov_openai','Fixture BYOK','synthetic-never-decrypted',false);
 INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status) VALUES('pv_test_openai_gpt-4o','prov_openai','gpt-4o',2.5,10,'manual','active');
 INSERT INTO price_components(price_version_id,kind,amount) VALUES('pv_test_openai_gpt-4o','input',2.5),('pv_test_openai_gpt-4o','output',10);
 INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode) VALUES('rule-fixture','tenant-test','org-test','prov_openai','gpt-4o','markup');
 INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price) VALUES('sale-fixture','rule-fixture','pv_test_openai_gpt-4o','markup',2.5,10);
 INSERT INTO wallet_accounts(id,tenant_id,organization_id) VALUES('wallet-fixture','tenant-test','org-test');
 INSERT INTO ledger_accounts(id,tenant_id,wallet_id,type,code) VALUES('wallet-ledger-fixture','tenant-test','wallet-fixture','wallet','wallet:wallet-fixture');
 INSERT INTO ledger_accounts(id,tenant_id,type,code) VALUES('clearing-fixture','tenant-test','clearing','clearing:USD');
 INSERT INTO ledger_transactions(id,tenant_id,type,idempotency_key) VALUES('funding-fixture','tenant-test','recharge','funding-fixture');
 INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type) VALUES('funding-fixture','tenant-test','wallet-ledger-fixture',1000000,'credit'),('funding-fixture','tenant-test','clearing-fixture',-1000000,'debit');`)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store, err := NewPostgresStore(ctx, dsn, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	budgetFixtureURL := os.Getenv("GATEWAY_BUDGET_FIXTURE_URL")
	if budgetFixtureURL == "" {
		budgetFixtureURL = "http://127.0.0.1:3311"
	}
	if budgetFixtureURL != "http://127.0.0.1:3311" && budgetFixtureURL != "http://host.docker.internal:3311" {
		t.Fatal("unsupported disposable Budget fixture URL")
	}
	budget := NewHTTPReserver(budgetFixtureURL, "convergence-budget-gateway-fixture-token", nil)
	limiter, err := NewLimiter("redis://127.0.0.1:56381/0", logger)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = limiter.Close() }()
	if err := limiter.Ping(ctx); err != nil {
		t.Fatalf("isolated Redis required: %v", err)
	}
	callerPrefix := newRandomID()
	var records []*TerminalRecord
	for _, mode := range []string{"managed", "byok"} {
		for _, streaming := range []bool{false, true} {
			var upstreamCalls atomic.Int64
			h := newHarness(t, harnessOptions{CredentialMode: mode, Limiter: limiter, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { upstreamCalls.Add(1); defaultUpstreamHandler()(w, r) }})
			cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := h.source.Fetch(r.Context(), r.URL.Query().Get("tenant_id"))
				if err != nil {
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
					return
				}
				_, _ = w.Write(body)
			}))
			source := &HTTPSnapshotSource{BaseURL: cp.URL, Token: "synthetic-cp-token", Client: &http.Client{Timeout: time.Second}}
			cache := NewSnapshotCache(source, h.keyring, SnapshotConfig{MaxAge: time.Minute, RefreshInterval: time.Minute, FetchTimeout: time.Second}, logger)
			for _, tenant := range []string{"", testTenantID} {
				if _, err := cache.Get(ctx, tenant); err != nil {
					t.Fatal(err)
				}
			}
			cp.Close()
			if _, err := source.Fetch(ctx, testTenantID); err == nil {
				t.Fatal("Control Plane must actually be offline")
			}
			h.proxy.snapshots = cache
			h.proxy.authn = NewAuthenticator(cache)
			h.proxy.store = store
			h.proxy.managed = budget
			if mode == "managed" && !streaming {
				// The closed CP fixture is also a provably unavailable budget HTTP target.
				// A denied reservation must never dispatch to the provider.
				h.proxy.managed = NewHTTPReserver(cp.URL, "synthetic-budget-token", nil)
				denied := h.doChat(chatBody(chatBodyOptions{MaxTokens: 20}), nil)
				_, _ = io.Copy(io.Discard, denied.Body)
				_ = denied.Body.Close()
				if denied.StatusCode != http.StatusServiceUnavailable || upstreamCalls.Load() != 0 {
					t.Fatalf("budget outage status=%d upstream=%d", denied.StatusCode, upstreamCalls.Load())
				}
				h.proxy.managed = budget
			}
			// Capture exactly what the real store persisted for replay/tamper verification.
			capture := &capturingBudgetStore{Store: store}
			h.proxy.store = capture
			clientKey := fmt.Sprintf("%s-caller-%s-%v", callerPrefix, mode, streaming)
			headers := map[string]string{"Idempotency-Key": clientKey}
			if mode == "byok" {
				// Keep this deliberate N-1 schema fixture. Explicit v1 BYOK
				// idempotency now requires canonical claim guards; an obsolete
				// database must reject before dispatch. The no-key legacy path
				// still works, while the canonical fixture covers durable claims.
				before := upstreamCalls.Load()
				unsupported := h.doChat(chatBody(chatBodyOptions{Stream: streaming, MaxTokens: 20}), headers)
				_ = readAll(unsupported)
				if unsupported.StatusCode != http.StatusServiceUnavailable || upstreamCalls.Load() != before {
					t.Fatal("obsolete schema accepted an explicit BYOK operation without durable claim guards")
				}
				headers = nil
			}
			response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, MaxTokens: 20}), headers)
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("%s streaming=%v status=%d body=%s", mode, streaming, response.StatusCode, body)
			}
			if capture.record == nil {
				t.Fatal("no durable terminal")
			}
			records = append(records, capture.record)
			var durableKey string
			wantKey := clientKey
			if mode == "byok" {
				wantKey = "req:" + capture.record.RequestID
			}
			if err := db.QueryRow(ctx, "SELECT idempotency_key FROM request_records WHERE id=$1", capture.record.RequestID).Scan(&durableKey); err != nil || durableKey != wantKey {
				t.Fatalf("caller key lost: %s err=%v", durableKey, err)
			}
			// Simulate another Gateway instance: local/Redis claim expiry must not
			// permit a new managed hold for the same durable client key.
			if mode == "managed" {
				h.proxy.idempotency = newIdempotencyCache(time.Minute, 100)
				if err := limiter.ReleaseIdempotency(ctx, idempotencyRedisKey(testTenantID, durableKey)); err != nil {
					t.Fatal(err)
				}
				before := upstreamCalls.Load()
				again := h.doChat(chatBody(chatBodyOptions{MaxTokens: 20}), map[string]string{"Idempotency-Key": durableKey})
				_, _ = io.Copy(io.Discard, again.Body)
				_ = again.Body.Close()
				if again.StatusCode == http.StatusOK || upstreamCalls.Load() != before {
					t.Fatal("duplicate managed key dispatched")
				}
			}

		}
	}
	var count int
	if err := db.QueryRow(ctx, "SELECT count(*) FROM outbox_events").Scan(&count); err != nil || count != 4 {
		t.Fatalf("outbox=%d err=%v", count, err)
	}
	var holds int
	var amount int64
	if err := db.QueryRow(ctx, "SELECT count(*),COALESCE(sum(reservation_amount),0) FROM request_records WHERE channel_kind='platform'").Scan(&holds, &amount); err != nil || holds != 2 || amount <= 0 {
		t.Fatalf("holds=%d amount=%d err=%v", holds, amount, err)
	}
	t.Logf("CP offline with real Redis: 4 terminal/outbox rows, managed holds=%d total_micros=%d; zero final usage before Worker", holds, amount)
	// Repeating terminal persistence cannot overwrite facts or add a second event.
	for _, rec := range records {
		if err := store.PersistTerminal(ctx, rec); !errors.Is(err, ErrReservationConflict) {
			t.Fatalf("replay=%v", err)
		}
	}
	if err := db.QueryRow(ctx, "SELECT count(*) FROM ledger_transactions WHERE type='usage'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("synchronous usage=%d err=%v", count, err)
	}
	// Authorize a fresh request and attempt to complete it with forged price pins.
	requestID := "reservation-tamper-fixture"
	grant, err := budget.Reserve(ctx, ReserveRequest{TenantID: testTenantID, OrganizationID: testOrgID, RequestID: requestID, KeyID: testKeyID, ModelID: testModel, Provider: "openai", Currency: "USD", PriceVersionID: testPriceID, SalePriceSnapshotID: "sale-fixture", EstimatedInputTokens: 11, EstimatedOutputTokens: 4, TTLSeconds: 900})
	if err != nil {
		t.Fatal(err)
	}
	rec := *records[0]
	rec.RequestID = requestID
	rec.IdempotencyKey = ""
	rec.Event.RequestID = requestID
	rec.ReservationAmount = grant.AmountMicros
	rec.SalePriceSnapshotID = "forged-sale-pin"
	if err := store.PersistTerminal(ctx, &rec); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("forged pin accepted: %v", err)
	}
	var status, pin string
	if err := db.QueryRow(ctx, "SELECT status,sale_price_snapshot_id FROM request_records WHERE id=$1", requestID).Scan(&status, &pin); err != nil || status != "reserved" || pin != "sale-fixture" {
		t.Fatalf("tampered durable state: %s %s %v", status, pin, err)
	}
	// N-1/BYOK insert collision maps only the exact tenant/key constraint.
	duplicate := *records[2]
	duplicate.RequestID = "byok-duplicate-fixture"
	duplicate.Event.RequestID = duplicate.RequestID
	duplicate.IdempotencyKey = "req:" + records[2].RequestID
	if err := store.PersistTerminal(ctx, &duplicate); !errors.Is(err, ErrDuplicateRequest) {
		t.Fatalf("BYOK caller-key duplicate: %v", err)
	}
	// A reserved authorization cannot be completed with a different caller key.
	rec.SalePriceSnapshotID = "sale-fixture"
	rec.IdempotencyKey = "forged-caller-key"
	if err := store.PersistTerminal(ctx, &rec); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("forged caller key: %v", err)
	}
	// Model the Worker's explicit expiry release using the exact balanced
	// ledger key/sign convention; late completion must retain this release.
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, fmt.Sprintf(`INSERT INTO ledger_transactions(id,tenant_id,type,idempotency_key,reference_type,reference_id)
 VALUES('late-release-fixture','tenant-test','reservation_release','reservation_release:reservation-tamper-fixture','request','reservation-tamper-fixture');
 INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type)
 SELECT 'late-release-fixture','tenant-test',id,-%d,'debit' FROM ledger_accounts WHERE tenant_id='tenant-test' AND type='reservation';
 INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type)
 VALUES('late-release-fixture','tenant-test','wallet-ledger-fixture',%d,'credit');
 UPDATE request_records SET reservation_released=true,reservation_expires_at=now()-interval '1 minute' WHERE id='reservation-tamper-fixture';`, grant.AmountMicros, grant.AmountMicros)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	rec.IdempotencyKey = ""
	rec.Attempts = append([]AttemptRecord(nil), rec.Attempts...)
	rec.Attempts[0].AttemptID = newRandomID()
	rec.Event.AttemptID = rec.Attempts[0].AttemptID
	rec.Event.EventID = newEventID(newRandomID())
	if err := store.PersistTerminal(ctx, &rec); err != nil {
		t.Fatalf("late terminal after release: %v", err)
	}
	var released bool
	if err := db.QueryRow(ctx, "SELECT reservation_released FROM request_records WHERE id=$1", requestID).Scan(&released); err != nil || !released {
		t.Fatalf("late terminal reset release: %v %v", released, err)
	}
	t.Logf("late terminal persisted after explicit %d-micro expiry release; Worker must charge exactly once and preserve the single release", grant.AmountMicros)
	t.Log("fixture left intact for independent Worker crash/restart/replay checks")
}

type capturingBudgetStore struct {
	Store
	record *TerminalRecord
}

func (s *capturingBudgetStore) ClaimLegacyBYOK(ctx context.Context, claim *LegacyBYOKClaim) error {
	claimer, ok := s.Store.(LegacyBYOKClaimer)
	if !ok {
		return ErrStoreUnavailable
	}
	return claimer.ClaimLegacyBYOK(ctx, claim)
}

func (s *capturingBudgetStore) PersistTerminal(ctx context.Context, r *TerminalRecord) error {
	err := s.Store.PersistTerminal(ctx, r)
	if err == nil {
		s.record = r
	}
	return err
}
