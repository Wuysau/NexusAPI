package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Runs inside the canonical disposable PostgreSQL fixture, with two valid
// tenant/organization/credential/channel scopes rather than impossible shared
// organization ownership. This exercises the real global primary key.
func verifyPostgresRequestIdentity(t *testing.T, db *pgx.Conn, store *PostgresStore) {
	t.Helper()
	ctx := context.Background()
	_, err := db.Exec(ctx, `INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org-correlation-b','tenant-correlation-b','B','correlation-b');
INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('project-correlation-b','tenant-correlation-b','org-correlation-b','B');
INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id) VALUES('key-correlation-b','tenant-correlation-b','org-correlation-b','Fixture B','fixture-correlation-b','fixture','project-correlation-b');
INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES('cred-correlation-b','prov_openai','tenant-correlation-b','org-correlation-b','B','synthetic');
INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES('connection-correlation-b','tenant-correlation-b','openai','byok','active');
INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES('channel-correlation-b','tenant-correlation-b','prov_openai','cred-correlation-b','B');`)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	opts := harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { calls.Add(1); defaultUpstreamHandler()(w, r) }}
	a := newHarness(t, opts)
	opts.Keys = []SnapshotKey{{KeyID: "key-correlation-b", TenantID: "tenant-correlation-b", OrganizationID: "org-correlation-b", HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeAll}, Enabled: true, ProjectID: "project-correlation-b", ProjectName: "B", KeyKind: "shared", AttributionStatus: "attributed"}}
	b := newHarness(t, opts)
	var envelope struct {
		Bundle GatewayBundle `json:"bundle"`
	}
	if err = json.Unmarshal(b.source.bundles[testTenantID], &envelope); err != nil {
		t.Fatal(err)
	}
	tenant := "tenant-correlation-b"
	envelope.Bundle.TenantID = &tenant
	envelope.Bundle.Snapshot.TenantID = &tenant
	channel := &envelope.Bundle.Channels[0]
	channel.ID = "channel-correlation-b"
	channel.TenantID = tenant
	channel.ProjectID = "project-correlation-b"
	channel.CredentialRef = "cred-correlation-b"
	channel.ConnectionID = "connection-correlation-b"
	b.source.bundles[tenant] = signBundleForTest(t, b.keyring, &envelope.Bundle)
	a.proxy.store = store
	b.proxy.store = store
	seen := map[string]bool{}
	for _, h := range []*testHarness{a, a, b} {
		response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"x-request-id": "shared-caller-correlation"})
		body := readAll(response)
		id := response.Header.Get("x-request-id")
		if response.StatusCode != 200 || id == "shared-caller-correlation" || seen[id] {
			t.Fatalf("request collision: %d %s", response.StatusCode, body)
		}
		seen[id] = true
		wantTenant, wantOrg := testTenantID, testOrgID
		if h == b {
			wantTenant = tenant
			wantOrg = "org-correlation-b"
		}
		var gotTenant, gotOrg, eventID string
		if err = db.QueryRow(ctx, `SELECT r.tenant_id,r.organization_id,o.payload->>'request_id' FROM request_records r JOIN outbox_events o ON o.aggregate_id=r.id WHERE r.id=$1`, id).Scan(&gotTenant, &gotOrg, &eventID); err != nil {
			t.Fatal(err)
		}
		if gotTenant != wantTenant || gotOrg != wantOrg || eventID != id {
			t.Fatal("durable attribution scope changed")
		}
	}
	for _, h := range []*testHarness{a, b} {
		response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "same-operation-in-different-tenants"})
		body := readAll(response)
		if response.StatusCode != 200 {
			t.Fatalf("tenant idempotency scope collision: %d %s", response.StatusCode, body)
		}
	}
	a.proxy.idempotency = newIdempotencyCache(15*time.Minute, 100_000)
	duplicate := a.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "same-operation-in-different-tenants"})
	body := readAll(duplicate)
	if duplicate.StatusCode != 409 || calls.Load() != 5 {
		t.Fatalf("durable duplicate replayed after cache loss: status=%d calls=%d body=%s", duplicate.StatusCode, calls.Load(), body)
	}
}
