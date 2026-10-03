package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProviderIDCollisionPostgres(t *testing.T) {
	db, store := newProviderIDPostgresFixture(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name                     string
		v2, same, absent, stream bool
		adapters                 [2]string
	}{
		{"v2 unique", true, false, false, false, [2]string{"gemini", "gemini"}},
		{"v2 same", true, true, false, false, [2]string{"gemini", "gemini"}},
		{"v2 same streaming", true, true, false, true, [2]string{"anthropic", "anthropic"}},
		{"v2 cross provider", true, true, false, false, [2]string{"gemini", "anthropic"}},
		{"v2 absent streaming", true, false, true, true, [2]string{"gemini", "anthropic"}},
		{"legacy unique", false, false, false, false, [2]string{"gemini", "anthropic"}},
		{"legacy same", false, true, false, false, [2]string{"gemini", "gemini"}},
		{"legacy cross provider", false, true, false, false, [2]string{"gemini", "anthropic"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requestIDs []string
			var records []*TerminalRecord
			for i, adapter := range tc.adapters {
				id := "req_fixture_" + strings.ReplaceAll(tc.name, " ", "_")
				if !tc.same {
					id += fmt.Sprint(i)
				}
				if tc.absent {
					id = ""
				}
				h, calls, fallback := newProviderRequestIDHarness(t, adapter, id, tc.v2)
				pinProviderIDPostgresHarness(t, h, adapter)
				capture := &providerIDPostgresCapture{PostgresStore: store}
				h.proxy.store = capture
				response := h.doChat(chatBody(chatBodyOptions{Stream: tc.stream, Messages: []map[string]any{{"role": "user", "content": "private-collision-prompt"}}}), nil)
				body := anthropicGatewayRead(t, response)
				r, persistErr := capture.result()
				if r == nil || calls.Load() != 1 || fallback.Load() != 0 || len(r.Attempts) != 1 {
					t.Fatalf("native request did not execute once: HTTP=%d calls=%d fallback=%d", response.StatusCode, calls.Load(), fallback.Load())
				}
				if response.StatusCode != http.StatusOK || persistErr != nil {
					t.Errorf("optional provider metadata invalidated a distinct request: HTTP=%d persist=%v", response.StatusCode, persistErr)
				}
				assertProviderRequestIDPublicOutput(t, response, body, tc.stream, r.RequestID)
				assertProviderRequestIDProjection(t, r, id)
				assertProviderIDPostgresUsage(t, r, adapter, tc.v2)
				if h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 {
					t.Error("metadata caused a BYOK reservation")
				}
				requestIDs = append(requestIDs, r.RequestID)
				records = append(records, r)
			}
			if len(requestIDs) != 2 || requestIDs[0] == requestIDs[1] {
				t.Fatal("fixture reused a Gateway request identity")
			}
			if records[0].RequestID == records[1].RequestID || records[0].Attempts[0].AttemptID == records[1].Attempts[0].AttemptID || records[0].Event.EventID == records[1].Event.EventID {
				t.Fatal("fixture reused a Gateway request, attempt or event identity")
			}
			assertProviderIDPostgresFacts(t, db, records, tc.v2)

			if tc.name == "v2 unique" {
				// Optional upstream metadata does not replace the caller's explicitly
				// scoped idempotency key or authorize replay of a terminal operation.
				h, calls, fallback := newProviderRequestIDHarness(t, "gemini", "req_fixture_client_idem", true)
				pinProviderIDPostgresHarness(t, h, "gemini")
				h.proxy.store = store
				headers := map[string]string{"Idempotency-Key": "provider-id-explicit-client-key"}
				first := h.doChat(chatBody(chatBodyOptions{}), headers)
				_ = anthropicGatewayRead(t, first)
				second := h.doChat(chatBody(chatBodyOptions{}), headers)
				_ = anthropicGatewayRead(t, second)
				if first.StatusCode != http.StatusOK || second.StatusCode != http.StatusConflict || calls.Load() != 1 || fallback.Load() != 0 {
					t.Error("explicit client key allowed another upstream execution")
				}
				if err := store.PersistTerminal(ctx, records[0]); !errors.Is(err, ErrReservationConflict) {
					t.Errorf("identical terminal replay accepted: %v", err)
				}
				if err := store.CaptureAttempt(ctx, records[0].RequestID, testTenantID, &records[0].Attempts[0]); !errors.Is(err, ErrStoreUnavailable) {
					t.Errorf("duplicate Gateway attempt identity did not fail: %v", err)
				}
				assertProviderIDPostgresFacts(t, db, records, true)
			}
		})
	}
}

func assertProviderIDPostgresUsage(t *testing.T, r *TerminalRecord, adapter string, v2 bool) {
	t.Helper()
	input := 5
	if !v2 && adapter == "anthropic" {
		input = 3 // Preserve the legacy exclusive input projection.
	}
	a := r.Attempts[0]
	if r.Status != string(OutcomeCompleted) || r.ErrorCode != "" || a.Status != string(OutcomeCompleted) || r.InputTokens != input || r.OutputTokens != 2 || a.InputTokens != input || a.OutputTokens != 2 || r.ProviderID != "provider-"+adapter || a.ProviderID != r.ProviderID {
		t.Error("metadata changed measured usage, outcome or native provider attribution")
	}
	if r.ProviderPriceVersionID != "collision-price-"+adapter || r.SalePriceSnapshotID != "collision-sale-"+adapter || r.ChargeAmount != 0 || r.ReservationAmount != 0 || r.Event.Usage.Estimated {
		t.Error("metadata changed the frozen BYOK price or fabricated money/usage")
	}
	if !v2 {
		if r.EventV2 != nil {
			t.Error("legacy request changed its event version")
		}
		return
	}
	e := r.EventV2
	if e == nil {
		t.Fatal("canonical event missing")
	}
	u := e.Usage
	cached := int64(0)
	if adapter == "anthropic" {
		cached = 1
	}
	if u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.CachedInputTokens == nil || *u.CachedInputTokens != cached || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || e.ProviderId == nil || *e.ProviderId != r.ProviderID || e.Attribution.ConnectionId == nil || *e.Attribution.ConnectionId != "collision-connection-"+adapter || e.PriceVersionId == nil || *e.PriceVersionId != r.ProviderPriceVersionID {
		t.Error("metadata changed canonical measured evidence or frozen attribution")
	}
	if adapter == "gemini" {
		if u.TotalTokens == nil || *u.TotalTokens != 7 || u.CacheCreationInputTokens != nil || u.Semantics != "" {
			t.Error("Gemini total or native usage semantics changed")
		}
	} else if u.TotalTokens != nil || u.CacheCreationInputTokens == nil || *u.CacheCreationInputTokens != 1 || u.Semantics != "anthropic-inclusive-v1" {
		t.Error("Anthropic cache evidence changed or total was fabricated")
	}
}

func assertProviderIDPostgresFacts(t *testing.T, db *pgx.Conn, records []*TerminalRecord, v2 bool) {
	t.Helper()
	ctx := context.Background()
	ids := []string{records[0].RequestID, records[1].RequestID}
	var requests, completed, attempts, finished, outbox, facts int
	if err := db.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM request_records WHERE id=ANY($1)),
 (SELECT count(*) FROM request_records WHERE id=ANY($1) AND status='completed'),
 (SELECT count(*) FROM attempts WHERE request_id=ANY($1)),
 (SELECT count(*) FROM attempts WHERE request_id=ANY($1) AND status='completed'),
 (SELECT count(*) FROM outbox_events WHERE aggregate_id=ANY($1)),
 (SELECT count(*) FROM request_project_facts WHERE request_id=ANY($1))`, ids).Scan(&requests, &completed, &attempts, &finished, &outbox, &facts); err != nil {
		t.Fatal(err)
	}
	wantFacts := 0
	if v2 {
		wantFacts = 2
	}
	if requests != 2 || completed != 2 || attempts != 2 || finished != 2 || outbox != 2 || facts != wantFacts {
		t.Errorf("distinct requests lost durable facts: requests=%d completed=%d attempts=%d finished=%d outbox=%d facts=%d", requests, completed, attempts, finished, outbox, facts)
	}
	for _, r := range records {
		var requestID, attemptID, requestProviderID, attemptProviderID, requestMetadata, attemptMetadata string
		var input, output, attemptInput, attemptOutput int
		if err := db.QueryRow(ctx, `SELECT r.id,a.id,r.resolved_provider_id,a.provider_id,COALESCE(r.upstream_request_id,''),COALESCE(a.upstream_request_id,''),r.input_tokens,r.output_tokens,a.input_tokens,a.output_tokens
 FROM request_records r JOIN attempts a ON a.request_id=r.id WHERE r.id=$1 AND r.tenant_id=$2`, r.RequestID, testTenantID).Scan(&requestID, &attemptID, &requestProviderID, &attemptProviderID, &requestMetadata, &attemptMetadata, &input, &output, &attemptInput, &attemptOutput); err != nil {
			t.Errorf("durable request/attempt pair missing: %v", err)
			continue
		}
		if requestID != r.RequestID || attemptID != r.Attempts[0].AttemptID || requestProviderID != r.ProviderID || attemptProviderID != r.ProviderID || requestMetadata != r.UpstreamRequestID || attemptMetadata != r.UpstreamRequestID || input != r.InputTokens || output != 2 || attemptInput != input || attemptOutput != output {
			t.Error("stored native identity, exact metadata or measured counts changed")
		}
		var payload []byte
		var eventType string
		if err := db.QueryRow(ctx, "SELECT event_type,payload FROM outbox_events WHERE aggregate_id=$1 AND tenant_id=$2", r.RequestID, testTenantID).Scan(&eventType, &payload); err != nil {
			t.Error(err)
			continue
		}
		var event UsageEvent
		if v2 {
			var e UsageEventV2
			if err := json.Unmarshal(payload, &e); err != nil || ValidateUsageEventV2(payload) != nil {
				t.Errorf("stored canonical event invalid: %v", err)
				continue
			}
			if eventType != "usage.v2.completed" || e.EventId != r.EventV2.EventId || e.RequestId != r.RequestID || e.AttemptId != attemptID || e.Attribution.ProjectId == nil || *e.Attribution.ProjectId != "project-test" || e.Attribution.ApiKeyId == nil || *e.Attribution.ApiKeyId != testKeyID || (e.ProviderRequestId == nil) != (r.UpstreamRequestID == "") || e.ProviderRequestId != nil && *e.ProviderRequestId != r.UpstreamRequestID {
				t.Error("stored canonical event lost its independent identity or exact optional metadata")
			}
		} else if err := json.Unmarshal(payload, &event); err != nil || event.Validate() != nil || eventType != "usage.completed" || event.EventID != r.Event.EventID || event.RequestID != r.RequestID || event.AttemptID != attemptID || (event.ProviderRequestID == nil) != (r.UpstreamRequestID == "") || event.ProviderRequestID != nil && *event.ProviderRequestID != r.UpstreamRequestID {
			t.Error("stored legacy event lost its independent identity or exact optional metadata")
		}
	}
	var persisted string
	if err := db.QueryRow(ctx, `SELECT json_build_object('requests',(SELECT json_agg(r) FROM request_records r WHERE id=ANY($1)),'attempts',(SELECT json_agg(a) FROM attempts a WHERE request_id=ANY($1)),'outbox',(SELECT json_agg(o.payload) FROM outbox_events o WHERE aggregate_id=ANY($1)))::text`, ids).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-collision-prompt", "private-id-output-marker", "private-id-upstream-header", testAPIKey, "upstream-test-secret"} {
		if strings.Contains(persisted, private) {
			t.Error("private content or credentials entered durable facts")
		}
	}
}

func pinProviderIDPostgresHarness(t *testing.T, h *testHarness, adapter string) {
	t.Helper()
	updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
		b.Channels[0].ID = "collision-channel-" + adapter
		b.Channels[0].CredentialRef = "collision-credential-" + adapter
		b.Channels[0].ConnectionID = "collision-connection-" + adapter
		b.Snapshot.PriceVersions[0].ID = "collision-price-" + adapter
		b.Snapshot.PriceVersions[0].SalePriceSnapshotID = "collision-sale-" + adapter
	})
}

// Match the existing Project V2 fixture: explicit source27, disposable target18,
// canonical migrations, and no reset of an arbitrary connection-string target.
func newProviderIDPostgresFixture(t *testing.T) (*pgx.Conn, *PostgresStore) {
	t.Helper()
	dsn := os.Getenv("GATEWAY_BUDGET_INTEGRATION_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture required")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || cfg.Database != "convergence_gateway27" || cfg.Host != "127.0.0.1" || cfg.Port != 55439 {
		t.Fatal("fixture must be loopback:55439/convergence_gateway27")
	}
	cfg.Database = "convergence_gateway18"
	ctx := context.Background()
	db, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close(ctx) })
	root := filepath.Join("..", "..")
	raw, err := os.ReadFile(filepath.Join(root, "drizzle", "meta", "_journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var journal struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err = json.Unmarshal(raw, &journal); err != nil {
		t.Fatal(err)
	}
	var applied int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM drizzle.__drizzle_migrations").Scan(&applied); err != nil || applied != len(journal.Entries) {
		t.Fatalf("prepare convergence_gateway18 using canonical scripts/prepare-project-gateway-fixture.mjs: migrations=%d error=%v", applied, err)
	}
	if cfg.Database != "convergence_gateway18" {
		t.Fatal("unsafe fixture reset")
	}
	if _, err = db.Exec(ctx, "ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS reject_v2_fixture; TRUNCATE organizations,providers,outbox_events CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org-test','tenant-test','Fixture','provider-id-fixture');
 INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('project-test','tenant-test','org-test','Project Test');
 INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id) VALUES('key-test','tenant-test','org-test','Fixture','fixture-hash','fixture','project-test');
 INSERT INTO providers(id,code,name,official_base_url) VALUES('provider-gemini','gemini','Gemini fixture','http://127.0.0.1'),('provider-anthropic','anthropic','Anthropic fixture','http://127.0.0.1');`); err != nil {
		t.Fatal(err)
	}
	for _, adapter := range []string{"gemini", "anthropic"} {
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{"INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES($1,$2,'tenant-test','org-test','Native fixture','synthetic-never-decrypted')", []any{"collision-credential-" + adapter, "provider-" + adapter}},
			{"INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES($1,'tenant-test',$2,'byok','active')", []any{"collision-connection-" + adapter, adapter}},
			{"INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES($1,'tenant-test',$2,$3,'Native fixture')", []any{"collision-channel-" + adapter, "provider-" + adapter, "collision-credential-" + adapter}},
			{"INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status) VALUES($1,$2,'gpt-4o',2.5,10,'manual','active')", []any{"collision-price-" + adapter, "provider-" + adapter}},
			{"INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode) VALUES($1,'tenant-test','org-test',$2,'gpt-4o','markup')", []any{"collision-rule-" + adapter, "provider-" + adapter}},
			{"INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price) VALUES($1,$2,$3,'markup',2.5,10)", []any{"collision-sale-" + adapter, "collision-rule-" + adapter, "collision-price-" + adapter}},
		} {
			if _, err = db.Exec(ctx, statement.query, statement.args...); err != nil {
				t.Fatal(err)
			}
		}
	}
	roles, err := os.ReadFile(filepath.Join(root, "infra", "db-workload-roles.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, string(roles)); err != nil {
		t.Fatal(err)
	}
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolCfg.ConnConfig.Database = cfg.Database
	poolCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE nexus_gateway")
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store := &PostgresStore{pool: pool, logger: discardLogger()}
	store.healthy.Store(true)
	return db, store
}

type providerIDPostgresCapture struct {
	*PostgresStore
	mu         sync.Mutex
	candidate  *TerminalRecord
	persistErr error
}

func (s *providerIDPostgresCapture) PersistTerminal(ctx context.Context, r *TerminalRecord) error {
	err := s.PostgresStore.PersistTerminal(ctx, r)
	s.mu.Lock()
	s.candidate, s.persistErr = r, err
	s.mu.Unlock()
	return err
}

func (s *providerIDPostgresCapture) result() (*TerminalRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.candidate, s.persistErr
}
