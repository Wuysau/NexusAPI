package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type legacyPostgresScope struct {
	tenant, organization, project, key, credential, connection, channel string
}

func legacyClaimScope(suffix string) legacyPostgresScope {
	return legacyPostgresScope{
		tenant: "tenant-legacy-" + suffix, organization: "org-legacy-" + suffix,
		project: "project-legacy-" + suffix, key: "key-legacy-" + suffix,
		credential: "credential-legacy-" + suffix, connection: "connection-legacy-" + suffix,
		channel: "channel-legacy-" + suffix,
	}
}

func legacyClaimHarness(t *testing.T, scope legacyPostgresScope, store Store, upstream http.HandlerFunc) *testHarness {
	t.Helper()
	h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: upstream,
		Keys: []SnapshotKey{{KeyID: scope.key, TenantID: scope.tenant, OrganizationID: scope.organization,
			HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeAll}, Enabled: true,
			ProjectID: scope.project, ProjectName: "Legacy Claim", KeyKind: "shared", AttributionStatus: "attributed"}}})
	var envelope struct {
		Bundle GatewayBundle `json:"bundle"`
	}
	if err := json.Unmarshal(h.source.bundles[testTenantID], &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Bundle.TenantID = &scope.tenant
	envelope.Bundle.Snapshot.TenantID = &scope.tenant
	channel := &envelope.Bundle.Channels[0]
	channel.ID, channel.TenantID, channel.ProjectID = scope.channel, scope.tenant, scope.project
	channel.CredentialRef, channel.ConnectionID = scope.credential, scope.connection
	h.source.bundles[scope.tenant] = signBundleForTest(t, h.keyring, &envelope.Bundle)
	h.proxy.store = store
	return h
}

type legacyClaimHTTPResult struct {
	status int
	id     string
	body   string
	err    error
}

func legacyClaimHTTP(h *testHarness, key string) legacyClaimHTTPResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.server.URL+"/v1/chat/completions", bytes.NewReader(chatBody(chatBodyOptions{})))
	if err != nil {
		return legacyClaimHTTPResult{err: err}
	}
	req.Header.Set("authorization", "Bearer "+testAPIKey)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("idempotency-key", key)
	response, err := h.server.Client().Do(req)
	if err != nil {
		return legacyClaimHTTPResult{err: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	return legacyClaimHTTPResult{status: response.StatusCode, id: response.Header.Get("x-request-id"), body: string(body), err: err}
}

// Called only after the parent acceptance test's partial-commit assertions.
// Its canonical, disposable database already has the Gateway workload grants.
func verifyLegacyBYOKPostgresClaims(t *testing.T, db *pgx.Conn, initialStore *PostgresStore) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.Exec(ctx, "ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS reject_v2_fixture"); err != nil {
		t.Fatal(err)
	}
	aScope, bScope := legacyClaimScope("a"), legacyClaimScope("b")
	for _, scope := range []legacyPostgresScope{aScope, bScope} {
		for _, statement := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO organizations(id,tenant_id,name,slug) VALUES($1,$2,'Legacy Claim',$1)`, []any{scope.organization, scope.tenant}},
			{`INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,$2,$3,'Legacy Claim')`, []any{scope.project, scope.tenant, scope.organization}},
			{`INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id) VALUES($1,$2,$3,'Legacy Claim',$1,'fixture',$4)`, []any{scope.key, scope.tenant, scope.organization, scope.project}},
			{`INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES($1,'prov_openai',$2,$3,'Legacy Claim','synthetic')`, []any{scope.credential, scope.tenant, scope.organization}},
			{`INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES($1,$2,'openai','byok','active')`, []any{scope.connection, scope.tenant}},
			{`INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES($1,$2,'prov_openai',$3,'Legacy Claim')`, []any{scope.channel, scope.tenant, scope.credential}},
		} {
			if _, err := db.Exec(ctx, statement.sql, statement.args...); err != nil {
				t.Fatal(err)
			}
		}
	}
	newStore := func(t *testing.T) *PostgresStore {
		t.Helper()
		pool, err := pgxpool.NewWithConfig(ctx, initialStore.pool.Config())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		store := &PostgresStore{pool: pool, logger: discardLogger()}
		store.healthy.Store(true)
		return store
	}
	storeA, storeB := newStore(t), newStore(t)
	var calls atomic.Int32
	upstream := func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		defaultUpstreamHandler()(w, r)
	}
	var base *TerminalRecord
	t.Run("independent instances have one atomic winner", func(t *testing.T) {
		entered, release := make(chan struct{}, 2), make(chan struct{})
		var releaseOnce sync.Once
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		defer unblock()
		blocked := func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			entered <- struct{}{}
			select {
			case <-release:
				defaultUpstreamHandler()(w, r)
			case <-r.Context().Done():
			}
		}
		captureA := &capturingProjectStore{PostgresStore: storeA}
		captureB := &capturingProjectStore{PostgresStore: storeB}
		a := legacyClaimHarness(t, aScope, captureA, blocked)
		b := legacyClaimHarness(t, aScope, captureB, blocked)
		start, results := make(chan struct{}), make(chan legacyClaimHTTPResult, 2)
		for _, h := range []*testHarness{a, b} {
			go func() { <-start; results <- legacyClaimHTTP(h, "legacy-same-operation") }()
		}
		close(start)
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("no request reached the provider after durable claim")
		}
		var loser legacyClaimHTTPResult
		select {
		case loser = <-results:
		case <-time.After(3 * time.Second):
			t.Fatal("duplicate did not fail while winning request was still in flight")
		}
		if loser.err != nil || loser.status != http.StatusConflict || calls.Load() != 1 {
			t.Fatalf("duplicate dispatched: result=%+v provider_calls=%d", loser, calls.Load())
		}
		var requestID string
		if err := db.QueryRow(ctx, `SELECT id FROM request_records WHERE tenant_id=$1 AND idempotency_key='legacy-same-operation' AND status='created'`, aScope.tenant).Scan(&requestID); err != nil {
			t.Fatal(err)
		}
		assertLegacyClaimHasNoTerminal(t, db, requestID)
		unblock()
		winner := <-results
		if winner.err != nil || winner.status != http.StatusOK || winner.id != requestID || winner.id == loser.id {
			t.Fatalf("winner lost generated durable identity: %+v claim=%s", winner, requestID)
		}
		base = captureA.record
		if base == nil {
			base = captureB.record
		}
		if base == nil || !base.LegacyBYOKClaimed || base.EventV2 != nil {
			t.Fatal("legacy claim did not reach terminal persistence")
		}
		var records, attempts, outbox int
		if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM request_records WHERE tenant_id=$1 AND idempotency_key='legacy-same-operation'),(SELECT count(*) FROM attempts WHERE request_id=$2),(SELECT count(*) FROM outbox_events WHERE aggregate_id=$2 AND event_type='usage.completed')`, aScope.tenant, winner.id).Scan(&records, &attempts, &outbox); err != nil || records != 1 || attempts != 1 || outbox != 1 {
			t.Fatalf("atomic winner facts=%d/%d/%d err=%v", records, attempts, outbox, err)
		}
		fresh := legacyClaimHarness(t, aScope, newStore(t), upstream)
		duplicate := legacyClaimHTTP(fresh, "legacy-same-operation")
		if duplicate.err != nil || duplicate.status != http.StatusConflict || calls.Load() != 1 {
			t.Fatalf("process/cache loss replayed provider: %+v calls=%d", duplicate, calls.Load())
		}
	})
	if base == nil {
		t.Fatal("successful legacy terminal fixture unavailable")
	}
	t.Run("same key in separately owned tenants remains independent", func(t *testing.T) {
		b := legacyClaimHarness(t, bScope, storeB, upstream)
		response := legacyClaimHTTP(b, "legacy-same-operation")
		if response.err != nil || response.status != http.StatusOK || calls.Load() != 2 {
			t.Fatalf("cross-tenant idempotency collision: %+v calls=%d", response, calls.Load())
		}
		var tenant, org string
		if err := db.QueryRow(ctx, `SELECT tenant_id,organization_id FROM request_records WHERE id=$1`, response.id).Scan(&tenant, &org); err != nil || tenant != bScope.tenant || org != bScope.organization {
			t.Fatalf("foreign request ownership: %s/%s err=%v", tenant, org, err)
		}
	})
	newClaim := func(key string) *LegacyBYOKClaim {
		return &LegacyBYOKClaim{RequestID: newRandomID(), TenantID: aScope.tenant, OrganizationID: aScope.organization,
			APIKeyID: aScope.key, RequestedModel: testModel, IdempotencyKey: key, TraceID: newRandomID(), StartedAt: time.Now().UTC().Truncate(time.Microsecond)}
	}
	t.Run("crashed claimant blocks replay without invented usage", func(t *testing.T) {
		claim := newClaim("legacy-crash-before-provider")
		if err := storeA.ClaimLegacyBYOK(ctx, claim); err != nil {
			t.Fatal(err)
		}
		fresh := legacyClaimHarness(t, aScope, newStore(t), upstream)
		before := calls.Load()
		response := legacyClaimHTTP(fresh, claim.IdempotencyKey)
		if response.err != nil || response.status != http.StatusConflict || calls.Load() != before {
			t.Fatalf("created-only claim replayed: %+v", response)
		}
		assertLegacyClaimHasNoTerminal(t, db, claim.RequestID)
	})
	t.Run("terminal transaction rollback retains only the durable claim", func(t *testing.T) {
		if _, err := db.Exec(ctx, `ALTER TABLE outbox_events ADD CONSTRAINT reject_legacy_claim_fixture CHECK(event_type NOT LIKE 'usage.%' OR event_type LIKE 'usage.v2.%') NOT VALID`); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := db.Exec(ctx, "ALTER TABLE outbox_events DROP CONSTRAINT reject_legacy_claim_fixture"); err != nil {
				t.Error(err)
			}
		}()
		fresh := legacyClaimHarness(t, aScope, newStore(t), upstream)
		before := calls.Load()
		response := legacyClaimHTTP(fresh, "legacy-outbox-rollback")
		if response.err != nil || response.status == http.StatusOK || calls.Load() != before+1 {
			t.Fatalf("failed terminal reported success or skipped provider: %+v calls=%d", response, calls.Load())
		}
		assertLegacyClaimHasNoTerminal(t, db, response.id)
		another := legacyClaimHarness(t, aScope, newStore(t), upstream)
		duplicate := legacyClaimHTTP(another, "legacy-outbox-rollback")
		if duplicate.err != nil || duplicate.status != http.StatusConflict || calls.Load() != before+1 {
			t.Fatalf("terminal rollback replayed upstream: %+v", duplicate)
		}
	})
	t.Run("terminal updates cannot take over other authorizations", func(t *testing.T) {
		for _, test := range []struct {
			name   string
			mutate func(*TerminalRecord)
		}{
			{"tenant", func(r *TerminalRecord) { r.TenantID = bScope.tenant; r.Event.TenantID = bScope.tenant }},
			{"organization", func(r *TerminalRecord) { r.OrganizationID = bScope.organization }},
			{"key", func(r *TerminalRecord) { r.DownstreamKeyID = bScope.key }},
			{"model", func(r *TerminalRecord) { r.RequestModel = "different-model" }},
			{"idempotency", func(r *TerminalRecord) { r.IdempotencyKey += "-forged" }},
			{"started_at", func(r *TerminalRecord) { r.StartedAt = r.StartedAt.Add(time.Second) }},
			{"trace", func(r *TerminalRecord) { r.TraceID = newRandomID() }},
		} {
			t.Run(test.name, func(t *testing.T) {
				claim := newClaim("legacy-forged-" + test.name)
				if err := storeA.ClaimLegacyBYOK(ctx, claim); err != nil {
					t.Fatal(err)
				}
				record := legacyClaimTerminal(base, claim)
				test.mutate(record)
				if err := storeB.PersistTerminal(ctx, record); !errors.Is(err, ErrReservationConflict) {
					t.Fatalf("forged %s was accepted: %v", test.name, err)
				}
				assertLegacyClaimHasNoTerminal(t, db, claim.RequestID)
			})
		}
		for _, mode := range []string{"managed", "v2"} {
			t.Run(mode, func(t *testing.T) {
				claim := newClaim("legacy-foreign-" + mode)
				if mode == "managed" {
					if _, err := db.Exec(ctx, `INSERT INTO request_records(id,tenant_id,organization_id,downstream_key_id,request_model,channel_kind,status,idempotency_key,trace_id,started_at,reservation_amount,resolved_provider_id,resolved_upstream_model_id,provider_price_version_id,sale_price_snapshot_id) VALUES($1,$2,$3,$4,$5,'platform','reserved',$6,$7,$8,100,'prov_openai',$5,$9,'sale-fixture')`, claim.RequestID, claim.TenantID, claim.OrganizationID, claim.APIKeyID, claim.RequestedModel, claim.IdempotencyKey, claim.TraceID, claim.StartedAt, testPriceID); err != nil {
						t.Fatal(err)
					}
				} else if err := storeA.CaptureRequest(ctx, &FrozenRequest{RequestID: claim.RequestID, TenantID: claim.TenantID, OrganizationID: claim.OrganizationID,
					IdempotencyKey: claim.IdempotencyKey, TraceID: claim.TraceID, StartedAt: claim.StartedAt,
					Attribution: RequestAttributionContext{ProjectID: &aScope.project, ProjectName: nullableString("Legacy Claim"), APIKeyID: aScope.key,
						KeyKind: "shared", AttributionStatus: "attributed", RequestedModel: testModel, CatalogVersionID: testCatalogID}}); err != nil {
					t.Fatal(err)
				}
				var before string
				if err := db.QueryRow(ctx, `SELECT to_jsonb(r)::text FROM request_records r WHERE id=$1`, claim.RequestID).Scan(&before); err != nil {
					t.Fatal(err)
				}
				record := legacyClaimTerminal(base, claim)
				if err := storeB.PersistTerminal(ctx, record); !errors.Is(err, ErrReservationConflict) {
					t.Fatalf("legacy update took over %s authorization: %v", mode, err)
				}
				if mode == "managed" {
					record.LegacyBYOKClaimed = false
					record.ChannelKind = "platform"
					record.ReservationAmount = 100
					record.SalePriceSnapshotID = "forged-sale-pin"
					if err := storeB.PersistTerminal(ctx, record); !errors.Is(err, ErrReservationConflict) {
						t.Fatalf("managed reserved price guard relaxed: %v", err)
					}
				}
				var after string
				var attempts, outbox int
				if err := db.QueryRow(ctx, `SELECT to_jsonb(r)::text,(SELECT count(*) FROM attempts WHERE request_id=r.id),(SELECT count(*) FROM outbox_events WHERE aggregate_id=r.id) FROM request_records r WHERE id=$1`, claim.RequestID).Scan(&after, &attempts, &outbox); err != nil || before != after || attempts != 0 || outbox != 0 {
					t.Fatalf("foreign authorization changed: mode=%s attempts=%d outbox=%d err=%v", mode, attempts, outbox, err)
				}
			})
		}
	})
	t.Logf("legacy BYOK PostgreSQL acceptance: independent pools, atomic winner, no replay, tenant separation, rollback and guarded updates; provider calls=%d", calls.Load())
}

func assertLegacyClaimHasNoTerminal(t *testing.T, db *pgx.Conn, requestID string) {
	t.Helper()
	var status string
	var completed bool
	var tokens, charge, reservation, attempts, facts, outbox int64
	err := db.QueryRow(context.Background(), `SELECT status,completed_at IS NOT NULL,input_tokens+output_tokens,charge_amount,reservation_amount,(SELECT count(*) FROM attempts WHERE request_id=r.id),(SELECT count(*) FROM request_project_facts WHERE request_id=r.id),(SELECT count(*) FROM outbox_events WHERE aggregate_id=r.id) FROM request_records r WHERE id=$1`, requestID).Scan(&status, &completed, &tokens, &charge, &reservation, &attempts, &facts, &outbox)
	if err != nil || status != "created" || completed || tokens != 0 || charge != 0 || reservation != 0 || attempts != 0 || facts != 0 || outbox != 0 {
		t.Fatalf("claim invented a terminal fact: status=%s completed=%v tokens=%d charge=%d reservation=%d attempts=%d facts=%d outbox=%d err=%v", status, completed, tokens, charge, reservation, attempts, facts, outbox, err)
	}
}

func legacyClaimTerminal(base *TerminalRecord, claim *LegacyBYOKClaim) *TerminalRecord {
	record := *base
	record.RequestID, record.TenantID, record.OrganizationID = claim.RequestID, claim.TenantID, claim.OrganizationID
	record.DownstreamKeyID, record.RequestModel = claim.APIKeyID, claim.RequestedModel
	record.IdempotencyKey, record.TraceID, record.StartedAt = claim.IdempotencyKey, claim.TraceID, claim.StartedAt
	record.CompletedAt = claim.StartedAt.Add(time.Second)
	record.Attempts = append([]AttemptRecord(nil), base.Attempts...)
	for i := range record.Attempts {
		record.Attempts[i].AttemptID = newRandomID()
		record.Attempts[i].StartedAt, record.Attempts[i].CompletedAt = claim.StartedAt, record.CompletedAt
	}
	record.Event.RequestID, record.Event.TenantID = claim.RequestID, claim.TenantID
	record.Event.EventID = newEventID(fmt.Sprint(time.Now().UnixNano()))
	record.Event.AttemptID = record.Attempts[len(record.Attempts)-1].AttemptID
	record.LegacyBYOKClaimed = true
	return &record
}
