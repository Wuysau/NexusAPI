package main

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
)

// Actual compatible HTTP calls retain repeated header metadata under the
// canonical migration, using the existing guarded disposable database fixture.
func TestOpenAIRequestIDPostgres(t *testing.T) {
	db, store := newProviderIDPostgresFixture(t)
	if _, err := db.Exec(context.Background(), `
INSERT INTO providers(id,code,name,official_base_url) VALUES('prov_openai','openai','Fixture','http://127.0.0.1');
INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES('cred_byok_test','prov_openai','tenant-test','org-test','Fixture','synthetic-never-decrypted');
INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status) VALUES('pv_test_openai_gpt-4o','prov_openai','gpt-4o',2.5,10,'manual','active');
INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode) VALUES('rule-fixture','tenant-test','org-test','prov_openai','gpt-4o','markup');
INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price) VALUES('sale-fixture','rule-fixture','pv_test_openai_gpt-4o','markup',2.5,10);
INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES('connection-test','tenant-test','openai','byok','active');
INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES('chan_test_1','tenant-test','prov_openai','cred_byok_test','Fixture');`); err != nil {
		t.Fatal(err)
	}
	for _, v2 := range []bool{false, true} {
		name := "legacy buffered"
		if v2 {
			name = "canonical streamed"
		}
		t.Run(name, func(t *testing.T) {
			const headerID = "req_shared_compatible_http"
			var records []*TerminalRecord
			for range 2 {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer upstream-test-secret" {
						t.Error("compatible fixture missed its configured endpoint or credential")
					}
					_, _ = io.Copy(io.Discard, r.Body)
					w.Header().Set("Content-Type", "text/event-stream")
					w.Header().Set("X-Request-ID", headerID)
					_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-independent-body\",\"choices\":[{\"delta\":{\"content\":\"private-id-output-marker\"},\"finish_reason\":null}]}\n\n"+
						"data: {\"id\":\"chatcmpl-independent-body\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"+
						"data: {\"id\":\"chatcmpl-independent-body\",\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":0}}}\n\ndata: [DONE]\n\n")
				}})
				capture := &providerIDPostgresCapture{PostgresStore: store}
				h.proxy.store = capture
				response := h.doChat(chatBody(chatBodyOptions{Stream: v2, Messages: []map[string]any{{"role": "user", "content": "private-collision-prompt"}}}), nil)
				body := anthropicGatewayRead(t, response)
				r, persistErr := capture.result()
				if r == nil || response.StatusCode != http.StatusOK || persistErr != nil || calls.Load() != 1 || len(r.Attempts) != 1 {
					t.Fatalf("compatible request failed: HTTP=%d calls=%d persist=%v", response.StatusCode, calls.Load(), persistErr)
				}
				assertProviderRequestIDPublicOutput(t, response, body, v2, r.RequestID)
				assertProviderRequestIDProjection(t, r, headerID)
				if r.Status != string(OutcomeCompleted) || r.InputTokens != 5 || r.OutputTokens != 2 || r.ProviderID != "prov_openai" || r.Event.Usage.Estimated || r.ChargeAmount != 0 || r.ReservationAmount != 0 {
					t.Error("header metadata changed known usage, attribution or money")
				}
				if v2 {
					if r.EventV2 == nil {
						t.Fatal("canonical event missing")
					}
					u := r.EventV2.Usage
					if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.TotalTokens == nil || *u.TotalTokens != 7 || u.CachedInputTokens == nil || *u.CachedInputTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || u.Estimated {
						t.Error("header metadata altered canonical observations")
					}
				}
				records = append(records, r)
			}
			if records[0].RequestID == records[1].RequestID || records[0].Attempts[0].AttemptID == records[1].Attempts[0].AttemptID || records[0].Event.EventID == records[1].Event.EventID {
				t.Fatal("compatible requests reused authoritative operation identity")
			}
			assertProviderIDPostgresFacts(t, db, records, v2)
		})
	}
}
