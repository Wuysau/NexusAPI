package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Separate from convergence_gateway27, whose durable v1 events are consumed by
// the Worker acceptance test. Never reset an arbitrary connection-string target.
func TestProjectV2PostgresCaptureTerminal(t *testing.T) {
	dsn := os.Getenv("GATEWAY_BUDGET_INTEGRATION_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture required")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || cfg.Database != "convergence_gateway27" || cfg.Host != "127.0.0.1" || cfg.Port != 55439 {
		t.Fatal("fixture must be loopback:55439/convergence_gateway27")
	}
	ctx := context.Background()
	admin, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err = admin.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='convergence_gateway18')").Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		if _, err = admin.Exec(ctx, "CREATE DATABASE convergence_gateway18"); err != nil {
			t.Fatal(err)
		}
	}
	_ = admin.Close(ctx)
	cfg.Database = "convergence_gateway18"
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
	if cfg.Database != "convergence_gateway18" {
		t.Fatal("unsafe fixture reset")
	}
	root := filepath.Join("..", "..")
	raw, err := os.ReadFile(filepath.Join(root, "drizzle", "meta", "_journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var journal struct {
		Entries []struct {
			Tag string `json:"tag"`
		} `json:"entries"`
	}
	if err = json.Unmarshal(raw, &journal); err != nil {
		t.Fatal(err)
	}
	var applied int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM drizzle.__drizzle_migrations").Scan(&applied); err != nil || applied != len(journal.Entries) {
		t.Fatalf("prepare convergence_gateway18 using canonical scripts/db-migrate.mjs before this test: applied=%d error=%v", applied, err)
	}
	exec("ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS reject_v2_fixture; TRUNCATE organizations,providers,outbox_events CASCADE")
	exec(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org-test','tenant-test','Fixture','project18');
 INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('project-test','tenant-test','org-test','Project Test'),('project-b','tenant-test','org-test','B');
 INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id) VALUES('key-test','tenant-test','org-test','Fixture','fixture-hash','fixture','project-test');
	 INSERT INTO providers(id,code,name,official_base_url) VALUES('prov_openai','openai','Fixture','http://127.0.0.1'),('prov_other','other','Other','http://127.0.0.1');
 INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES('cred_byok_test','prov_openai','tenant-test','org-test','Fixture','synthetic-never-decrypted');
 INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status) VALUES('pv_test_openai_gpt-4o','prov_openai','gpt-4o',2.5,10,'manual','active');
 INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode) VALUES('rule-fixture','tenant-test','org-test','prov_openai','gpt-4o','markup');
 INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price) VALUES('sale-fixture','rule-fixture','pv_test_openai_gpt-4o','markup',2.5,10);
 INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES('connection-test','tenant-test','openai','byok','active');
 INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES('chan_test_1','tenant-test','prov_openai','cred_byok_test','Fixture');`)
	roles, err := os.ReadFile(filepath.Join(root, "infra", "db-workload-roles.sql"))
	if err != nil {
		t.Fatal(err)
	}
	exec(string(roles))
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
	defer pool.Close()
	store := &PostgresStore{pool: pool, logger: discardLogger()}
	store.healthy.Store(true)
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		var count int
		if err := db.QueryRow(ctx, "SELECT count(*) FROM request_project_facts").Scan(&count); err != nil || count == 0 {
			t.Error("capture did not precede provider")
		}
		if err := db.QueryRow(ctx, "SELECT count(*) FROM attempts WHERE status='pending'").Scan(&count); err != nil || count == 0 {
			t.Error("attempt not captured before provider")
		}
		if _, err := db.Exec(ctx, "UPDATE channels SET provider_id='prov_other' WHERE id='chan_test_1'"); err != nil {
			t.Error(err)
		}
		defaultUpstreamHandler()(w, r)
	}})
	capture := &capturingProjectStore{PostgresStore: store}
	h.proxy.store = capture
	response := h.doChat(chatBody(chatBodyOptions{Model: "gpt4o"}), nil)
	body := readAll(response)
	if response.StatusCode != 200 {
		t.Fatalf("v2 postgres status=%d body=%s persist=%v", response.StatusCode, body, capture.lastError)
	}
	rec := capture.record
	if rec == nil {
		t.Fatal("terminal not committed")
	}
	exec("UPDATE channels SET provider_id='prov_openai' WHERE id='chan_test_1'")
	var eventType string
	var payload []byte
	if err = db.QueryRow(ctx, "SELECT event_type,payload FROM outbox_events WHERE aggregate_id=$1", rec.RequestID).Scan(&eventType, &payload); err != nil {
		t.Fatal(err)
	}
	if eventType != "usage.v2.completed" || ValidateUsageEventV2(payload) != nil {
		t.Fatalf("invalid outbox %s %s", eventType, payload)
	}
	var wire UsageEventV2
	if err = json.Unmarshal(payload, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Attribution.ProjectId == nil || *wire.Attribution.ProjectId != "project-test" || wire.RequestedModel != "gpt4o" {
		t.Fatal("identity not preserved")
	}
	if err = store.PersistTerminal(ctx, rec); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("replay accepted: %v", err)
	}
	// Changes to current entities after capture cannot rewrite the historical fact.
	exec("UPDATE downstream_api_keys SET project_id='project-b' WHERE id='key-test'; UPDATE projects SET name='Renamed' WHERE id='project-test'")
	var project, name string
	if err = db.QueryRow(ctx, "SELECT project_id,project_name FROM request_project_facts WHERE request_id=$1", rec.RequestID).Scan(&project, &name); err != nil || project != "project-test" || name != "Project Test" {
		t.Fatalf("history changed %s %s %v", project, name, err)
	}
	invalid := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"negative-provider\",\"choices\":[],\"usage\":{\"prompt_tokens\":-1,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
	}})
	invalidCapture := &capturingProjectStore{PostgresStore: store}
	invalid.proxy.store = invalidCapture
	response = invalid.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	var unknown int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM request_records r JOIN outbox_events o ON o.aggregate_id=r.id WHERE r.status='unknown' AND o.event_type='usage.v2.unknown' AND o.payload->'usage'->'input_tokens'='null'::jsonb").Scan(&unknown); err != nil || unknown != 1 {
		t.Fatalf("negative usage lost durable reconciliation: %d %v persist=%v", unknown, err, invalidCapture.lastError)
	}
	large := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"large-provider\",\"choices\":[],\"usage\":{\"prompt_tokens\":2147483648,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
	}})
	large.proxy.store = store
	response = large.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if err = db.QueryRow(ctx, "SELECT count(*) FROM request_records r JOIN outbox_events o ON o.aggregate_id=r.id WHERE r.status='unknown' AND o.event_type='usage.v2.unknown'").Scan(&unknown); err != nil || unknown != 2 {
		t.Fatalf("large usage overflow lost terminal: %d %v", unknown, err)
	}
	exec(`INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES('retry-credential','prov_openai','tenant-test','org-test','Retry','synthetic');
 INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES('retry-connection','tenant-test','openai','byok','active');
 INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES('retry-channel','tenant-test','prov_openai','retry-credential','Retry');`)
	var retryCalls atomic.Int64
	retry := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		if retryCalls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"retry-db\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
	}, ExtraChannelsFn: func(url string) []SnapshotChannel {
		return []SnapshotChannel{{ID: "retry-channel", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "retry-credential", ConnectionID: "retry-connection", Weight: 1, Priority: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}}
	}})
	retryCapture := &capturingProjectStore{PostgresStore: store}
	retry.proxy.store = retryCapture
	response = retry.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if retryCapture.record == nil {
		t.Fatalf("retry not persisted: %v", retryCapture.lastError)
	}
	rows, err := db.Query(ctx, "SELECT connection_id,resolved_model,execution_mode,price_version_id,catalog_version_id FROM attempts WHERE request_id=$1 ORDER BY attempt_number", retryCapture.record.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	connections := []string{}
	for rows.Next() {
		var connection, model, mode, price, catalog string
		if err = rows.Scan(&connection, &model, &mode, &price, &catalog); err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
		if model != testModel || mode != "byok" || price != testPriceID || catalog != testCatalogID {
			t.Fatal("attempt pins lost")
		}
	}
	rows.Close()
	if len(connections) != 2 || connections[0] != "connection-test" || connections[1] != "retry-connection" {
		t.Fatalf("retry historical connections lost: %v", connections)
	}
	// Fail the outbox write after request/attempt updates: the whole terminal
	// transaction must roll back while the pre-forward identity remains durable.
	exec("ALTER TABLE outbox_events ADD CONSTRAINT reject_v2_fixture CHECK(event_type NOT LIKE 'usage.v2.%') NOT VALID")
	capture.record = nil
	response = h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if response.StatusCode == 200 || capture.record != nil {
		t.Fatal("uncommitted terminal reported success")
	}
	var created, attempts, outbox int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM request_records WHERE status='created'").Scan(&created); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM attempts").Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, "SELECT count(*) FROM outbox_events").Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if created != 1 || attempts != 6 || outbox != 4 {
		t.Fatalf("partial terminal commit created=%d attempts=%d outbox=%d", created, attempts, outbox)
	}
	var pending int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM attempts WHERE status='pending'").Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("failed terminal changed captured attempt: %d %v", pending, err)
	}
}

type capturingProjectStore struct {
	*PostgresStore
	record    *TerminalRecord
	lastError error
}

func (s *capturingProjectStore) PersistTerminal(ctx context.Context, r *TerminalRecord) error {
	err := s.PostgresStore.PersistTerminal(ctx, r)
	s.lastError = err
	if err == nil {
		s.record = r
	}
	return err
}
