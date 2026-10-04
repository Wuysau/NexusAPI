package main

import (
	"bytes"
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

	"nexus/gateway/provider"
)

func TestGeminiSafetyChatFinishPreservesCompletedAccounting(t *testing.T) {
	for _, tc := range []struct{ reason, finish string }{{"SAFETY", "content_filter"}, {"STOP", "stop"}, {"MAX_TOKENS", "length"}} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.reason, streaming), func(t *testing.T) {
				h, calls, fallback := newGeminiSafetyHarness(t, tc.reason)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-gemini-safety-prompt"}}}), nil)
				body := readAll(response)
				assertGeminiSafetyAccounting(t, h, calls, fallback, logs.String())
				if response.StatusCode != http.StatusOK {
					t.Fatal("known terminal became an upstream failure")
				}
				var finish, text string
				var usage map[string]any
				consume := func(raw []byte) {
					var wire struct {
						Choices []struct {
							Finish  string                   `json:"finish_reason"`
							Message struct{ Content string } `json:"message"`
							Delta   struct{ Content string } `json:"delta"`
						} `json:"choices"`
						Usage map[string]any `json:"usage"`
					}
					if json.Unmarshal(raw, &wire) != nil {
						t.Fatal("invalid public completion JSON")
					}
					for _, choice := range wire.Choices {
						text += choice.Message.Content + choice.Delta.Content
						if choice.Finish != "" {
							finish = choice.Finish
						}
					}
					if wire.Usage != nil {
						usage = wire.Usage
					}
				}
				if streaming {
					reader := provider.NewSSEReader(strings.NewReader(body))
					done := 0
					for {
						event, err := reader.Next()
						if err == io.EOF {
							break
						}
						if err != nil {
							t.Fatal("invalid public SSE")
						}
						if string(event.Data) == "[DONE]" {
							done++
							continue
						}
						consume(event.Data)
					}
					if done != 1 {
						t.Fatal("known blocked terminal lost normal stream completion")
					}
				} else {
					consume([]byte(body))
				}
				if text != "private-gemini-safety-content" || usage["prompt_tokens"] != float64(5) || usage["completion_tokens"] != float64(2) || usage["total_tokens"] != nil {
					t.Fatal("finish projection changed text or public nullable usage")
				}
				if strings.Contains(body, "upstream-test-secret") || strings.Contains(body, testAPIKey) {
					t.Fatal("credential entered public response")
				}
				if finish != tc.finish {
					t.Errorf("public finish = %q, want %q", finish, tc.finish)
				}
			})
		}
	}
}

func TestGeminiSafetyResponsesRemainIncompleteWithCompletedAccounting(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%t", streaming), func(t *testing.T) {
			h, calls, fallback := newGeminiSafetyHarness(t, "SAFETY")
			w := callResponses(t, h, fmt.Sprintf(`{"model":"gpt-4o","input":"private-gemini-safety-prompt","stream":%t}`, streaming), true)
			assertGeminiSafetyAccounting(t, h, calls, fallback, "")
			if w.Code != http.StatusOK {
				t.Fatal("known filtered response became a protocol failure")
			}
			var result map[string]any
			if streaming {
				events := responseEvents(t, w.Body.String())
				result = events[len(events)-1]["response"].(map[string]any)
			} else if json.Unmarshal(w.Body.Bytes(), &result) != nil {
				t.Fatal("invalid Responses JSON")
			}
			details, _ := result["incomplete_details"].(map[string]any)
			if result["status"] != "incomplete" || details["reason"] != "content_filter" || result["error"] != nil {
				t.Error("filtered generation was not represented as incomplete/content_filter")
			}
		})
	}
}

func assertGeminiSafetyAccounting(t *testing.T, h *testHarness, calls, fallback *atomic.Int32, logs string) {
	t.Helper()
	r := usageTotalSoleRecord(t, h, calls, fallback)
	if r.Status != string(OutcomeCompleted) || r.Attempts[0].Status != string(OutcomeCompleted) || r.EventV2.Status != string(OutcomeCompleted) || r.ErrorCode != "" {
		t.Fatal("known finish changed completed execution accounting")
	}
	u := r.EventV2.Usage
	if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || u.CachedInputTokens != nil || u.TotalTokens != nil {
		t.Fatal("known finish changed reliable usage or replaced absent counters with zero")
	}
	facts, err := json.Marshal(struct {
		Captured []*FrozenRequest
		Terminal []*TerminalRecord
	}{h.store.CapturedRequests(), h.store.Requests()})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-gemini-safety-content", "private-gemini-safety-prompt", "upstream-test-secret", testAPIKey} {
		if bytes.Contains(facts, []byte(private)) || strings.Contains(logs, private) {
			t.Fatal("private content or credentials entered facts/logs")
		}
	}
}

func newGeminiSafetyHarness(t *testing.T, reason string) (*testHarness, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		adapterFixtureResponse(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if !strings.Contains(r.URL.Path, ":streamGenerateContent") {
				t.Error("fixture missed native Gemini HTTP adapter")
			}
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "data: "+`{"candidates":[{"content":{"parts":[{"text":"private-gemini-safety-content"}]},"finishReason":%q}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":null,"totalTokenCount":null}}`+"\n\n", reason)
		},
		ExtraChannels: []SnapshotChannel{{ID: "gemini-safety-fallback", ConnectionID: "gemini-safety-fallback-connection", ProviderID: "provider-gemini", Provider: "gemini", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	setValidationProvider(t, h, "gemini")
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "gemini-safety-fallback" {
		t.Fatal("fallback fixture is not eligible")
	}
	return h, &calls, &fallbackCalls
}
