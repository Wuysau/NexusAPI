package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUpstreamAttemptDeadlineBeforeHeaders(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, streaming := range []bool{false, true} {
			t.Run(endpoint+"/"+fmtBool(streaming), func(t *testing.T) {
				var calls atomic.Int32
				cancelled := make(chan struct{}, 2)
				limits := defaultLimits()
				limits.UpstreamTimeout = 40 * time.Millisecond
				limits.IdleTimeout = 80 * time.Millisecond
				limits.TotalDuration = time.Second
				h := newHarness(t, harnessOptions{
					EnableUsageV2: true, Limits: limits, MaxAttempts: 2,
					UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						_, _ = io.Copy(io.Discard, r.Body)
						select {
						case <-r.Context().Done():
							cancelled <- struct{}{}
							return
						case <-time.After(180 * time.Millisecond):
						}
						defaultUpstreamHandler()(w, r)
					},
					ExtraChannelsFn: func(url string) []SnapshotChannel {
						return []SnapshotChannel{{ID: "timeout-fallback", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", CredentialMode: "managed", CredentialRef: "cred_test", ConnectionID: "timeout-fallback-connection", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}}
					},
				})
				server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
				t.Cleanup(server.Close)
				body := fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}],"stream":%t}`, streaming)
				if endpoint == "/v1/responses" {
					body = fmt.Sprintf(`{"model":"gpt-4o","input":"hello","stream":%t}`, streaming)
				}
				call := func() (*http.Response, string) {
					t.Helper()
					req, err := http.NewRequest(http.MethodPost, server.URL+endpoint, strings.NewReader(body))
					if err != nil {
						t.Fatal(err)
					}
					req.Header.Set("Authorization", "Bearer "+testAPIKey)
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Idempotency-Key", "attempt-timeout-no-replay")
					response, err := server.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					return response, readAll(response)
				}
				started := time.Now()
				response, responseBody := call()
				var envelope errorEnvelope
				if err := json.Unmarshal([]byte(responseBody), &envelope); err != nil {
					t.Fatalf("before-header timeout must return a JSON error: status=%d, decode=%v", response.StatusCode, err)
				}
				if response.StatusCode != http.StatusGatewayTimeout || envelope.Error.Code != CodeUpstreamTimeout || envelope.Error.Type != TypeTimeout {
					t.Fatalf("attempt timeout ignored or misclassified: status=%d code=%s elapsed=%s", response.StatusCode, envelope.Error.Code, time.Since(started))
				}
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("attempt timeout did not cancel the connected upstream")
				}
				if calls.Load() != 1 || h.managed.reserveCount() != 1 || h.store.OutboxCount(testTenantID) != 1 {
					t.Fatal("connected timeout replayed execution or changed reservation/outbox cardinality")
				}
				records := h.store.Requests()
				if len(records) != 1 || records[0].Status != string(OutcomeUnknown) || records[0].ErrorCode != CodeUpstreamTimeout {
					t.Fatal("connected timeout did not persist one unknown terminal with the timeout cause")
				}
				record := records[0]
				if len(record.Attempts) != 1 || record.Attempts[0].Status != string(OutcomeUnknown) || record.Attempts[0].ChannelID != "chan_test_1" {
					t.Fatal("timeout lost the actual attempt attribution or invoked a fallback")
				}
				event := record.EventV2
				if event == nil || event.Status != "unknown" || event.Streaming != streaming || event.Attribution.ProjectId == nil || *event.Attribution.ProjectId != "project-test" {
					t.Fatal("timeout lost the frozen v2 attribution")
				}
				if event.Usage.InputTokens != nil || event.Usage.OutputTokens != nil || event.Usage.TotalTokens != nil || event.Usage.CachedInputTokens != nil || event.Usage.ReasoningTokens != nil || event.Usage.CacheCreationInputTokens != nil || record.InputTokens != 0 || record.OutputTokens != 0 {
					t.Fatal("timeout without provider usage fabricated observed token counts")
				}
				repeated, repeatedBody := call()
				if repeated.StatusCode != http.StatusConflict || !strings.Contains(repeatedBody, CodeIdempotencyConflict) || calls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
					t.Fatal("same idempotency key repeated an ambiguous provider execution")
				}
			})
		}
	}
}
