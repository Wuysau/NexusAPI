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

// Exercise real upstream and downstream HTTP with the shared in-memory harness.
// The compatible provider always receives SSE, including buffered requests.
func TestSSELineEndingsPreserveCompletionAndAccounting(t *testing.T) {
	const prompt = "private-sse-input-fixture"
	const content = "Hello-private-sse-output-fixture"
	for _, api := range []string{"chat", "responses"} {
		for _, streaming := range []bool{false, true} {
			for _, ending := range []struct{ name, value string }{{"LF", "\n"}, {"CRLF", "\r\n"}, {"CR", "\r"}} {
				t.Run(fmt.Sprintf("%s/stream=%t/%s", api, streaming, ending.name), func(t *testing.T) {
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
							for _, payload := range []string{
								`{"choices":[{"index":0,"delta":{"content":"` + content + `"},"finish_reason":null}]}`,
								`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
								`{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`,
								`[DONE]`,
							} {
								if _, err := io.WriteString(w, "data: "+payload+ending.value+ending.value); err != nil {
									return
								}
								w.(http.Flusher).Flush()
							}
						},
						ExtraChannels: []SnapshotChannel{{
							ID: "sse-fallback", ConnectionID: "sse-fallback-connection", ProviderID: "prov_openai", Provider: "openai", Protocol: "openai",
							BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true,
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
					rawOutput, err := io.ReadAll(response.Body)
					_ = response.Body.Close()
					if err != nil {
						t.Fatalf("read completion: %v", err)
					}
					output := string(rawOutput)
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
					if record.Status != string(OutcomeCompleted) || record.ErrorCode != "" || attempt.Status != string(OutcomeCompleted) || attempt.ErrorCode != "" || attempt.AttemptNumber != 1 || attempt.ChannelID != "chan_test_1" || record.ChannelKind != "byok" || record.ExecutionMode != "byok" {
						t.Errorf("valid SSE became an execution failure: terminal=%s code=%s attempt=%s route=%s", record.Status, record.ErrorCode, attempt.Status, attempt.ChannelID)
					}
					event := record.EventV2
					if event == nil {
						t.Fatal("missing usage v2 event")
					}
					attribution := event.Attribution
					if event.TenantId != testTenantID || event.OrganizationId != testOrgID || event.ProviderId == nil || *event.ProviderId != "provider-ollama" || event.ModelId != testModel || event.ResolvedModel == nil || *event.ResolvedModel != testModel || attribution.ChannelId == nil || *attribution.ChannelId != "chan_test_1" || attribution.ConnectionId == nil || *attribution.ConnectionId != "connection-test" || attribution.ApiKeyId == nil || *attribution.ApiKeyId != testKeyID || attribution.CredentialId == nil || *attribution.CredentialId != "cred_byok_test" || attribution.ExecutionMode != "byok" || captured[0].Attribution.APIKeyID != testKeyID {
						t.Error("valid SSE changed frozen tenant, key or provider attribution")
					}
					usage := event.Usage
					if event.Status != string(OutcomeCompleted) || event.RequestId != record.RequestID || event.AttemptId != attempt.AttemptID || captured[0].RequestID != record.RequestID || event.Streaming != streaming || usage.Estimated || usage.InputTokens == nil || *usage.InputTokens != 5 || usage.OutputTokens == nil || *usage.OutputTokens != 2 || usage.TotalTokens == nil || *usage.TotalTokens != 7 || usage.CachedInputTokens != nil || usage.ReasoningTokens != nil || record.InputTokens != 5 || record.OutputTokens != 2 || attempt.InputTokens != 5 || attempt.OutputTokens != 2 {
						t.Error("valid SSE changed observed usage or its sole billing attribution")
					}
					key := BreakerKey("chan_test_1", testModel)
					h.breaker.mu.Lock()
					primaryHealth := *h.breaker.entryLocked(key)
					fallbackHealth := *h.breaker.entryLocked(BreakerKey("sse-fallback", testModel))
					h.breaker.mu.Unlock()
					// A successful local call may take zero milliseconds on Windows.
					if primaryHealth.state != BreakerClosed || primaryHealth.failureEwma != 0 || primaryHealth.healthSamples != 1 || primaryHealth.samples != 1 || primaryHealth.ttftSamples != 1 || primaryHealth.consecutiveFailures != 0 || !primaryHealth.retryAt.IsZero() || !h.breaker.Available(key) || fallbackHealth.healthSamples != 0 {
						t.Errorf("valid SSE changed upstream health or cooldown: state=%s failures=%g healthSamples=%d", primaryHealth.state, primaryHealth.failureEwma, primaryHealth.healthSamples)
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
						if strings.Contains(output, credential) || strings.Contains(fmt.Sprint(response.Header), credential) {
							t.Error("credentials entered downstream output")
						}
					}
					if response.StatusCode != http.StatusOK {
						t.Fatalf("valid SSE returned HTTP %d instead of a completion", response.StatusCode)
					}
					if streaming {
						if response.Header.Get("Content-Type") != "text/event-stream" {
							t.Fatal("streaming completion lost its SSE content type")
						}
					} else if response.Header.Get("Content-Type") != "application/json" {
						t.Fatal("buffered completion lost its JSON content type")
					}
					assertSSELineEndingOutput(t, output, api, streaming, content)
				})
			}
		}
	}
}

func assertSSELineEndingUsage(t *testing.T, usage any, inputKey, outputKey string) {
	t.Helper()
	u, ok := usage.(map[string]any)
	if !ok || u[inputKey] != float64(5) || u[outputKey] != float64(2) || u["total_tokens"] != float64(7) {
		t.Fatal("downstream completion lost exact observed usage")
	}
}

func assertSSELineEndingOutput(t *testing.T, output, api string, streaming bool, content string) {
	t.Helper()
	var completion map[string]any
	if !streaming {
		if err := json.Unmarshal([]byte(output), &completion); err != nil {
			t.Fatal("invalid buffered completion")
		}
	} else if api == "chat" {
		chunks := streamOptionChunks(t, output)
		var text strings.Builder
		finishes, usages := 0, 0
		for _, chunk := range chunks {
			if chunk["object"] != "chat.completion.chunk" {
				t.Fatal("chat SSE lost its completion chunk envelope")
			}
			choices, ok := chunk["choices"].([]any)
			if !ok {
				t.Fatal("invalid chat SSE choices")
			}
			for _, item := range choices {
				choice, ok := item.(map[string]any)
				if !ok || choice["index"] != float64(0) {
					t.Fatal("invalid chat SSE choice")
				}
				delta, ok := choice["delta"].(map[string]any)
				if !ok {
					t.Fatal("invalid chat SSE delta")
				}
				if value, ok := delta["content"].(string); ok {
					text.WriteString(value)
				}
				if finish := choice["finish_reason"]; finish != nil {
					if finish != "stop" {
						t.Fatal("chat SSE changed the finish reason")
					}
					finishes++
				}
			}
			if usage := chunk["usage"]; usage != nil {
				assertSSELineEndingUsage(t, usage, "prompt_tokens", "completion_tokens")
				usages++
			}
		}
		if text.String() != content || finishes != 1 || usages != 1 || strings.Count(output, "data: [DONE]") != 1 {
			t.Fatal("chat SSE lost content or its sole finish, usage and DONE frames")
		}
		return
	} else {
		events := responseEvents(t, output)
		var text strings.Builder
		terminals := 0
		for index, event := range events {
			if event["sequence_number"] != float64(index) {
				t.Fatal("Responses SSE changed lifecycle ordering")
			}
			switch event["type"] {
			case "response.output_text.delta":
				value, ok := event["delta"].(string)
				if !ok {
					t.Fatal("invalid Responses text delta")
				}
				text.WriteString(value)
			case "response.completed":
				completion, _ = event["response"].(map[string]any)
				terminals++
			case "response.failed", "response.incomplete":
				t.Fatal("valid SSE became a failed Responses event")
			}
		}
		if len(events) == 0 || events[0]["type"] != "response.created" || events[len(events)-1]["type"] != "response.completed" || text.String() != content || terminals != 1 || strings.Contains(output, "[DONE]") || strings.Contains(output, "chat.completion") {
			t.Fatal("Responses SSE lost content or its sole completed lifecycle")
		}
	}
	if api == "chat" {
		choices, ok := completion["choices"].([]any)
		if !ok || len(choices) != 1 || completion["object"] != "chat.completion" {
			t.Fatal("invalid buffered chat completion envelope")
		}
		choice, ok := choices[0].(map[string]any)
		if !ok {
			t.Fatal("invalid buffered chat choice")
		}
		message, ok := choice["message"].(map[string]any)
		if !ok || message["content"] != content || choice["finish_reason"] != "stop" {
			t.Fatal("buffered chat lost content or stop finish reason")
		}
		assertSSELineEndingUsage(t, completion["usage"], "prompt_tokens", "completion_tokens")
		return
	}
	items, ok := completion["output"].([]any)
	if !ok || len(items) != 1 || completion["object"] != "response" || completion["status"] != "completed" || completion["error"] != nil || completion["incomplete_details"] != nil {
		t.Fatal("invalid completed Responses envelope")
	}
	item, ok := items[0].(map[string]any)
	if !ok || item["type"] != "message" || item["role"] != "assistant" || item["status"] != "completed" {
		t.Fatal("Responses completion lost its assistant message")
	}
	parts, ok := item["content"].([]any)
	if !ok || len(parts) != 1 {
		t.Fatal("Responses completion lost its text part")
	}
	part, ok := parts[0].(map[string]any)
	if !ok || part["type"] != "output_text" || part["text"] != content {
		t.Fatal("Responses completion lost its output text")
	}
	assertSSELineEndingUsage(t, completion["usage"], "input_tokens", "output_tokens")
}
