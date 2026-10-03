package main

import (
	"bytes"
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
)

// An initial UTF-8 BOM is framing, even when the first SSE event carries
// generated content or the only observed usage. Use real loopback HTTP and
// signed compatible-provider configuration with the in-memory accounting store.
func TestInitialSSEBOMPreservesCompletionAndAccounting(t *testing.T) {
	const prompt = "private-bom-input-fixture"
	const content = "private-bom-output-fixture"
	contentFrame := `data: {"choices":[{"index":0,"delta":{"content":"` + content + `"},"finish_reason":null}]}` + "\n\n"
	usageFrame := "data: " + `{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}` + "\n\n"
	finishFrame := "data: " + `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n"
	for _, api := range []string{"chat", "responses"} {
		for _, first := range []string{"content", "usage"} {
			for _, streaming := range []bool{false, true} {
				for _, bom := range []bool{false, true} {
					t.Run(fmt.Sprintf("%s/first=%s/stream=%t/bom=%t", api, first, streaming, bom), func(t *testing.T) {
						var primaryCalls, fallbackCalls atomic.Int32
						fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
							fallbackCalls.Add(1)
							defaultUpstreamHandler()(w, r)
						}))
						t.Cleanup(fallback.Close)
						h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", MaxAttempts: 2,
							UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
								primaryCalls.Add(1)
								var request struct {
									Stream bool `json:"stream"`
								}
								if json.NewDecoder(r.Body).Decode(&request) != nil || !request.Stream {
									t.Error("gateway did not request upstream SSE")
								}
								w.Header().Set("Content-Type", "text/event-stream")
								if bom {
									_, _ = w.Write([]byte{0xef, 0xbb, 0xbf})
								}
								frames := []string{contentFrame, finishFrame, usageFrame}
								if first == "usage" {
									frames = []string{usageFrame, contentFrame, finishFrame}
								}
								for _, frame := range append(frames, "data: [DONE]\n\n") {
									if _, err := io.WriteString(w, frame); err != nil {
										return
									}
									w.(http.Flusher).Flush()
								}
							},
							ExtraChannels: []SnapshotChannel{{
								ID: "bom-fallback", ConnectionID: "bom-fallback-connection", ProviderID: "prov_openai", Provider: "openai", Protocol: "openai", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true,
							}},
						})
						updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
							b.Channels[0].Provider = "ollama"
							b.Channels[0].ProviderID = "provider-ollama"
							b.Channels[0].Protocol = "openai"
							b.Models[0].Provider = "ollama"
							b.Snapshot.PriceVersions[0].Provider = "ollama"
						})
						var logs connectorRetryLogs
						h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
						server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
						t.Cleanup(server.Close)
						path := "/v1/chat/completions"
						body := chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": prompt}}})
						if api == "responses" {
							path = "/v1/responses"
							var err error
							body, err = json.Marshal(map[string]any{"model": testModel, "input": prompt, "stream": streaming})
							if err != nil {
								t.Fatal(err)
							}
						}
						request, err := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewReader(body))
						if err != nil {
							t.Fatal(err)
						}
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set("Authorization", "Bearer "+testAPIKey)
						client := server.Client()
						client.Timeout = 5 * time.Second
						response, err := client.Do(request)
						if err != nil {
							t.Fatal(err)
						}
						raw, err := io.ReadAll(response.Body)
						_ = response.Body.Close()
						if err != nil {
							t.Fatalf("read completion: %v", err)
						}
						records := h.store.Requests()
						captured := h.store.CapturedRequests()
						h.store.mu.Lock()
						attemptCaptures := len(h.store.capturedAttempts)
						h.store.mu.Unlock()
						if primaryCalls.Load() != 1 || fallbackCalls.Load() != 0 || len(captured) != 1 || attemptCaptures != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 || h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 {
							t.Fatalf("changed execution cardinality: primary=%d fallback=%d captures=%d attemptCaptures=%d terminal=%d outbox=%d", primaryCalls.Load(), fallbackCalls.Load(), len(captured), attemptCaptures, len(records), h.store.OutboxCount(testTenantID))
						}
						record := records[0]
						attempt := record.Attempts[0]
						if response.StatusCode != http.StatusOK || record.Status != string(OutcomeCompleted) || record.ErrorCode != "" || attempt.Status != string(OutcomeCompleted) || attempt.ErrorCode != "" || attempt.AttemptNumber != 1 || attempt.ChannelID != "chan_test_1" {
							t.Fatalf("valid initial BOM changed completion: http=%d terminal=%s code=%s attempt=%s route=%s", response.StatusCode, record.Status, record.ErrorCode, attempt.Status, attempt.ChannelID)
						}
						event := record.EventV2
						if event == nil {
							t.Fatal("missing usage v2 event")
						}
						attribution := event.Attribution
						if event.Status != string(OutcomeCompleted) || event.RequestId != record.RequestID || event.AttemptId != attempt.AttemptID || captured[0].RequestID != record.RequestID || event.Streaming != streaming || event.TenantId != testTenantID || event.OrganizationId != testOrgID || event.ProviderId == nil || *event.ProviderId != "provider-ollama" || attribution.ChannelId == nil || *attribution.ChannelId != "chan_test_1" || attribution.ConnectionId == nil || *attribution.ConnectionId != "connection-test" || attribution.ApiKeyId == nil || *attribution.ApiKeyId != testKeyID || attribution.ExecutionMode != "byok" {
							t.Error("initial BOM changed sole billing attribution")
						}
						usage := event.Usage
						if usage.Estimated || usage.InputTokens == nil || *usage.InputTokens != 5 || usage.OutputTokens == nil || *usage.OutputTokens != 2 || usage.TotalTokens == nil || *usage.TotalTokens != 7 || usage.CachedInputTokens != nil || usage.ReasoningTokens != nil || record.InputTokens != 5 || record.OutputTokens != 2 || attempt.InputTokens != 5 || attempt.OutputTokens != 2 {
							t.Error("initial BOM discarded observed usage or changed its accounting projection")
						}
						key := BreakerKey("chan_test_1", testModel)
						if h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 || !h.breaker.Available(key) {
							t.Error("initial BOM changed upstream health or cooldown")
						}
						facts, err := json.Marshal(struct {
							Captured []*FrozenRequest
							Terminal []*TerminalRecord
						}{captured, records})
						if err != nil {
							t.Fatal(err)
						}
						for _, private := range []string{prompt, content, testAPIKey, "upstream-test-secret"} {
							if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
								t.Error("request content or credentials entered execution facts or logs")
							}
						}
						for _, credential := range []string{testAPIKey, "upstream-test-secret"} {
							if bytes.Contains(raw, []byte(credential)) || strings.Contains(fmt.Sprint(response.Header), credential) {
								t.Error("credentials entered downstream output")
							}
						}
						assertSSELineEndingOutput(t, string(raw), api, streaming, content)
					})
				}
			}
		}
	}
}
