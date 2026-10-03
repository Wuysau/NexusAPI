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
)

func TestGeminiMalformedStreamTotalIsUnknownWithoutReplay(t *testing.T) {
	for _, tc := range []struct {
		name, total string
		recovery    bool
	}{
		{"fractional recovery", "25.5", true},
		{"wrong type recovery", `"private-invalid-gemini-total"`, true},
		{"int64 overflow recovery", "9223372036854775808", true},
		// The old direct-terminal path lost usage and reached missing_usage;
		// the repair must reject the malformed frame and retain prior evidence.
		{"fractional direct terminal", "25.5", false},
	} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, streaming), func(t *testing.T) {
				later := fmt.Sprintf(`{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":%s}}`, tc.total)
				h, calls, fallbackCalls := newGeminiUsageTotalHarness(t, later, tc.recovery)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-gemini-prompt"}}}), nil)
				body := readAll(response)
				r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
				a := r.Attempts[0]
				if r.Status != string(OutcomeUnknown) || r.ErrorCode != CodeUpstreamProtocol || a.Status != string(OutcomeUnknown) || r.EventV2.Status != string(OutcomeUnknown) {
					t.Errorf("malformed native total completed: terminal=%s/%s attempt=%s", r.Status, r.ErrorCode, a.Status)
				}
				u := r.EventV2.Usage
				if !u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.TotalTokens == nil || *u.TotalTokens != 7 || u.CachedInputTokens == nil || *u.CachedInputTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || r.InputTokens != 5 || r.OutputTokens != 2 || a.InputTokens != 5 || a.OutputTokens != 2 {
					t.Error("protocol error lost prior reliable usage or certified malformed current usage")
				}
				if r.EventV2.ProviderId == nil || *r.EventV2.ProviderId != "provider-gemini" {
					t.Error("native Gemini execution changed provider attribution")
				}
				if streaming {
					if response.StatusCode != http.StatusOK || !strings.Contains(body, "private-gemini-content") || !strings.Contains(body, CodeUpstreamProtocol) || strings.Contains(body, "[DONE]") {
						t.Error("malformed native streamed total reported successful completion")
					}
				} else if response.StatusCode != http.StatusBadGateway || !strings.Contains(body, CodeUpstreamProtocol) || strings.Contains(body, "private-gemini-content") {
					t.Error("malformed native buffered total reported successful completion")
				}
				facts, err := json.Marshal(struct {
					Captured []*FrozenRequest
					Terminal []*TerminalRecord
				}{h.store.CapturedRequests(), h.store.Requests()})
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{"private-gemini-prompt", "private-gemini-content", "private-invalid-gemini-total", testAPIKey, "upstream-test-secret"} {
					if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
						t.Error("provider/request content or credentials entered durable facts or logs")
					}
				}
				for _, private := range []string{"private-invalid-gemini-total", testAPIKey, "upstream-test-secret"} {
					if strings.Contains(body, private) || strings.Contains(fmt.Sprint(response.Header), private) {
						t.Error("provider details or credentials entered downstream error")
					}
				}
			})
		}
	}
}

func TestGeminiStreamUsageTotalCompatibilityPreservesGuards(t *testing.T) {
	for _, tc := range []struct {
		name, later   string
		negative      bool
		output, total int64
	}{
		{"updated integer", `{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":25}}`, false, 20, 25},
		{"negative integer", `{"usageMetadata":{"totalTokenCount":-1}}`, true, 0, 0},
		{"null counters", `{"usageMetadata":{"promptTokenCount":null,"candidatesTokenCount":null,"thoughtsTokenCount":null,"cachedContentTokenCount":null,"totalTokenCount":null}}`, false, 2, 7},
		{"absent total", `{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}`, false, 2, 7},
		{"partial update", `{"usageMetadata":{"candidatesTokenCount":20,"totalTokenCount":25}}`, false, 20, 25},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, calls, fallbackCalls := newGeminiUsageTotalHarness(t, tc.later, true)
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(response)
			r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
			u := r.EventV2.Usage
			if response.StatusCode != http.StatusOK {
				t.Fatal("integer/optional total changed protocol acceptance")
			}
			if tc.negative {
				if r.Status != string(OutcomeUnknown) || r.ErrorCode != "invalid_provider_usage" || !u.Estimated || u.InputTokens != nil || u.OutputTokens != nil || u.TotalTokens != nil || u.CachedInputTokens != nil || u.ReasoningTokens != nil || r.InputTokens != 0 || r.OutputTokens != 0 {
					t.Fatal("negative total bypassed existing semantic validation")
				}
			} else if r.Status != string(OutcomeCompleted) || u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != tc.output || u.TotalTokens == nil || *u.TotalTokens != tc.total || r.InputTokens != 5 || r.OutputTokens != int(tc.output) {
				t.Fatal("valid/nullable native usage lost current reliable observations")
			}
		})
	}
}

func newGeminiUsageTotalHarness(t *testing.T, later string, recovery bool) (*testHarness, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"candidates":[{"content":{"parts":[{"text":"fallback"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":25}}`+"\n\n")
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if !strings.Contains(r.URL.Path, ":streamGenerateContent") {
				t.Error("fixture did not reach native Gemini stream wire")
			}
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			first := `{"candidates":[{"content":{"parts":[{"text":"private-gemini-content"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":7}}`
			last := `{"candidates":[{"finishReason":"STOP"}]}`
			if recovery {
				last = `{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5}}`
			}
			for _, frame := range []string{first, later, last} {
				_, _ = io.WriteString(w, "data: "+frame+"\n\n")
				w.(http.Flusher).Flush()
			}
		},
		ExtraChannels: []SnapshotChannel{{ID: "gemini-usage-fallback", ConnectionID: "gemini-usage-fallback-connection", ProviderID: "provider-gemini", Provider: "gemini", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	setValidationProvider(t, h, "gemini")
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "gemini-usage-fallback" {
		t.Fatalf("native fallback fixture is not eligible: candidates=%+v error=%v", candidates, err)
	}
	return h, &calls, &fallbackCalls
}
