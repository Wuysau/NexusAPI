package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nexus/gateway/connectorclient"
)

// Use the public Client configuration for a real local timeout, independently
// of the longer Gateway deadlines. The polling and result upload are real HTTP.
func localTimeoutConnectorHub(t *testing.T, upstreamURL string, channel SnapshotChannel) *ConnectorHub {
	t.Helper()
	const leaseToken = "nxlease_synthetic-local-timeout"
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/connector/lease":
			_ = json.NewEncoder(w).Encode(map[string]any{"leaseToken": leaseToken, "expiresAt": time.Now().Add(time.Minute)})
		case "/api/internal/gateway/connector":
			_ = json.NewEncoder(w).Encode(connectorGrant{LeaseID: "local-timeout-lease", ConnectorID: "local-timeout-connector", ConnectionID: channel.ConnectionID, TenantID: channel.TenantID, ExpiresAt: time.Now().Add(time.Minute), Models: channel.Models})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(cp.Close)
	hub := NewConnectorHub(cp.URL, "synthetic-timeout-internal-token")
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	client, err := connectorclient.New(connectorclient.Config{ControlURL: cp.URL, GatewayURL: server.URL, UpstreamURL: upstreamURL + "/v1", Models: channel.Models, AllowHTTPDevelopment: true, UpstreamTimeoutSeconds: 1})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.Run(ctx, connectorclient.Identity{ConnectorID: "local-timeout-connector", ConnectionID: channel.ConnectionID, TenantID: channel.TenantID, Credential: "nxidentity_synthetic-local-timeout", ControlURL: cp.URL})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("connector shutdown: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("connector did not stop its workers")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for hub.session(&channel) == nil {
		if time.Now().After(deadline) {
			t.Fatal("connector did not establish a polling session")
		}
		time.Sleep(time.Millisecond)
	}
	return hub
}

func TestConnectorLocalTimeoutKeepsCauseAcrossProtocols(t *testing.T) {
	const promptMarker = "private-local-timeout-prompt"
	const headerMarker = "private-local-timeout-header"
	const partial = "local timeout partial output"
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, afterHeaders := range []bool{false, true} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/after_headers_%v/stream_%v", endpoint, afterHeaders, streaming), func(t *testing.T) {
					channel := SnapshotChannel{ID: "local-timeout-channel", ConnectionID: "local-timeout-connection", TenantID: testTenantID, ProjectID: "project-test", ProviderID: "ollama-provider", Provider: "ollama", Protocol: "openai", Transport: "local_sidecar", BaseURL: "https://connector.invalid/v1", CredentialMode: "byok", CredentialRef: "local-timeout-credential", Enabled: true, Models: []string{testModel}, Capabilities: []string{"text", "streaming"}}
					var calls, fallbackCalls atomic.Int32
					fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						fallbackCalls.Add(1)
						defaultUpstreamHandler()(w, r)
					}))
					fallbackChannel := SnapshotChannel{ID: "local-timeout-fallback", ConnectionID: "local-timeout-fallback-connection", ProviderID: "prov_openai", Provider: "openai", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Enabled: true}
					t.Cleanup(fallback.Close)
					canceled := make(chan struct{}, 1)
					limits := defaultLimits()
					limits.IdleTimeout, limits.UpstreamTimeout, limits.TotalDuration = 3*time.Second, 4*time.Second, 6*time.Second
					h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", NoPrice: true, Limits: limits, Channels: []SnapshotChannel{channel, fallbackChannel}, MaxAttempts: 2,
						UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
							if r.URL.Path == "/v1/models" {
								_, _ = io.WriteString(w, `{"data":[{"id":"gpt-4o"}]}`)
								return
							}
							calls.Add(1)
							_, _ = io.Copy(io.Discard, r.Body)
							if afterHeaders {
								w.Header().Set("Content-Type", "text/event-stream")
								w.Header().Set("X-Local-Private", headerMarker)
								// Only input usage is observed. Missing output and total
								// counts must remain unknown after timeout.
								_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}],\"usage\":{\"prompt_tokens\":11}}\n\n", partial)
								w.(http.Flusher).Flush()
							}
							<-r.Context().Done()
							canceled <- struct{}{}
						}})
					logs := &connectorRetryLogs{}
					h.proxy.logger = slog.New(slog.NewTextHandler(logs, nil))
					h.proxy.connectors = localTimeoutConnectorHub(t, h.upstream.URL, channel)
					server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
					t.Cleanup(server.Close)
					payload := chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": promptMarker}}})
					if endpoint == "/v1/responses" {
						payload = []byte(fmt.Sprintf(`{"model":%q,"input":%q,"stream":%t}`, testModel, promptMarker, streaming))
					}
					call := func() (*http.Response, string) {
						t.Helper()
						request, err := http.NewRequest(http.MethodPost, server.URL+endpoint, strings.NewReader(string(payload)))
						if err != nil {
							t.Fatal(err)
						}
						request.Header.Set("Authorization", "Bearer "+testAPIKey)
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set("Idempotency-Key", "local-timeout-no-replay")
						response, err := server.Client().Do(request)
						if err != nil {
							t.Fatal(err)
						}
						return response, readAll(response)
					}
					started := time.Now()
					response, body := call()
					if elapsed := time.Since(started); elapsed >= limits.IdleTimeout {
						t.Fatalf("local timeout waited for a longer Gateway budget: %s", elapsed)
					}
					select {
					case <-canceled:
					case <-time.After(time.Second):
						t.Fatal("local timeout did not cancel inference")
					}
					if streaming && afterHeaders {
						if response.StatusCode != http.StatusOK || !strings.Contains(body, partial) || strings.Contains(body, "[DONE]") || strings.Contains(body, "response.completed") {
							t.Fatal("local timeout lost partial output or announced completion")
						}
						if endpoint == "/v1/responses" {
							events := responseEvents(t, body)
							last := events[len(events)-1]
							if last["type"] != "response.failed" {
								t.Fatal("Responses local timeout omitted its terminal failure event")
							}
							failure := last["response"].(map[string]any)["error"].(map[string]any)
							if failure["code"] != "server_error" || failure["message"] != errUpstreamTimeout().Message {
								t.Errorf("Responses local timeout lost its compatible static cause: %v", failure)
							}
						} else if !strings.Contains(body, `"code":"`+CodeUpstreamTimeout+`"`) || !strings.Contains(body, errUpstreamTimeout().Message) {
							t.Errorf("Chat local timeout lost its SSE cause: %s", body)
						}
					} else {
						var envelope errorEnvelope
						if json.Unmarshal([]byte(body), &envelope) != nil || response.StatusCode != http.StatusGatewayTimeout || envelope.Error.Code != CodeUpstreamTimeout || envelope.Error.Type != TypeTimeout || envelope.Error.Message != errUpstreamTimeout().Message {
							t.Errorf("local timeout lost JSON status/cause: status=%d body=%s", response.StatusCode, body)
						}
					}

					assertOneExecution := func() *TerminalRecord {
						t.Helper()
						records := h.store.Requests()
						if calls.Load() != 1 || fallbackCalls.Load() != 0 || len(records) != 1 || len(records[0].Attempts) != 1 || len(h.store.CapturedRequests()) != 1 || h.store.OutboxCount(testTenantID) != 1 || h.managed.reserveCount() != 0 {
							t.Fatal("local timeout replayed execution or changed capture/terminal/outbox cardinality")
						}
						return records[0]
					}
					record := assertOneExecution()
					if record.Status != string(OutcomeUnknown) || record.ErrorCode != CodeUpstreamTimeout || len(record.Attempts) != 1 || record.Attempts[0].Status != string(OutcomeUnknown) || record.Attempts[0].ChannelID != channel.ID || record.Attempts[0].ConnectionID != channel.ConnectionID {
						t.Errorf("local timeout lost its single unknown attempt/cause: status=%s error=%s attempts=%v", record.Status, record.ErrorCode, record.Attempts)
					}
					event := record.EventV2
					if event == nil || event.Status != "unknown" || event.Streaming != streaming || event.PriceVersionId != nil || record.ProviderPriceVersionID != "" || record.Attempts[0].PriceVersionID != "" || event.TenantId != testTenantID || event.OrganizationId != testOrgID || event.Attribution.ExecutionMode != "byok" || event.Attribution.ProjectId == nil || *event.Attribution.ProjectId != "project-test" || event.Attribution.ApiKeyId == nil || *event.Attribution.ApiKeyId != testKeyID || event.Attribution.ConnectionId == nil || *event.Attribution.ConnectionId != channel.ConnectionID {
						t.Fatal("local timeout lost frozen attribution or invented a price")
					}
					if afterHeaders {
						if event.Usage.InputTokens == nil || *event.Usage.InputTokens != 11 {
							t.Fatal("local timeout discarded already observed input usage")
						}
					} else if event.Usage.InputTokens != nil {
						t.Fatal("before-header timeout invented input usage")
					}
					if event.Usage.OutputTokens != nil || event.Usage.TotalTokens != nil || event.Usage.CachedInputTokens != nil || event.Usage.ReasoningTokens != nil || event.Usage.CacheCreationInputTokens != nil {
						t.Fatal("local timeout fabricated missing usage")
					}
					repeated, repeatedBody := call()
					if repeated.StatusCode != http.StatusConflict || !strings.Contains(repeatedBody, CodeIdempotencyConflict) {
						t.Fatal("same idempotency key did not reject an ambiguous execution")
					}
					assertOneExecution()
					facts, _ := json.Marshal(h.store.Requests())
					visible := string(facts) + logs.String() + body + repeatedBody + fmt.Sprint(response.Header)
					for _, marker := range []string{promptMarker, headerMarker} {
						if strings.Contains(visible, marker) {
							t.Fatal("local timeout exposed private prompt/header data in errors, facts, or logs")
						}
					}
				})
			}
		}
	}
}
