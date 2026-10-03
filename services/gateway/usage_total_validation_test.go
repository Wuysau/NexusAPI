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

func TestMalformedStreamUsageTotalIsUnknownWithoutReplay(t *testing.T) {
	for _, tc := range []struct{ name, total string }{
		{"fractional", "25.5"},
		{"wrong type", `"private-invalid-total"`},
		{"int64 overflow", "9223372036854775808"},
	} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, streaming), func(t *testing.T) {
				later := fmt.Sprintf(`{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":20,"total_tokens":%s,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`, tc.total)
				h, calls, fallbackCalls := newUsageTotalHarness(t, later)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-usage-prompt"}}}), nil)
				body := readAll(response)
				record := usageTotalSoleRecord(t, h, calls, fallbackCalls)
				attempt := record.Attempts[0]
				if record.Status != string(OutcomeUnknown) || record.ErrorCode != CodeUpstreamProtocol || attempt.Status != string(OutcomeUnknown) || record.EventV2.Status != string(OutcomeUnknown) {
					t.Errorf("malformed usage persisted completion: terminal=%s/%s attempt=%s/%s", record.Status, record.ErrorCode, attempt.Status, attempt.ErrorCode)
				}
				u := record.EventV2.Usage
				if !u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.TotalTokens == nil || *u.TotalTokens != 7 || u.CachedInputTokens == nil || *u.CachedInputTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || record.InputTokens != 5 || record.OutputTokens != 2 || attempt.InputTokens != 5 || attempt.OutputTokens != 2 {
					t.Error("protocol error lost prior reliable observations or retained malformed current usage")
				}
				if streaming {
					if response.StatusCode != http.StatusOK || !strings.Contains(body, "private-usage-content") || !strings.Contains(body, CodeUpstreamProtocol) || strings.Contains(body, "[DONE]") {
						t.Error("malformed streamed total reported successful completion")
					}
				} else if response.StatusCode != http.StatusBadGateway || !strings.Contains(body, CodeUpstreamProtocol) || strings.Contains(body, "private-usage-content") {
					t.Error("malformed buffered total reported successful completion")
				}
				facts, err := json.Marshal(struct {
					Captured []*FrozenRequest
					Terminal []*TerminalRecord
				}{h.store.CapturedRequests(), h.store.Requests()})
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{"private-usage-prompt", "private-usage-content", "private-invalid-total", testAPIKey, "upstream-test-secret"} {
					if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
						t.Error("provider/request content or credential entered durable facts or logs")
					}
				}
				for _, private := range []string{"private-invalid-total", testAPIKey, "upstream-test-secret"} {
					if strings.Contains(body, private) || strings.Contains(fmt.Sprint(response.Header), private) {
						t.Error("provider details or credentials entered downstream error")
					}
				}
			})
		}
	}
}

func TestStreamUsageTotalCompatibilityPreservesGatewayGuards(t *testing.T) {
	for _, tc := range []struct {
		name, later string
		negative    bool
	}{
		{"negative integer", `{"usage":{"total_tokens":-1}}`, true},
		{"absent usage", `{"choices":[]}`, false},
		{"null counters", `{"usage":{"prompt_tokens":null,"completion_tokens":null,"total_tokens":null}}`, false},
		{"partial update", `{"usage":{"completion_tokens":2}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, calls, fallbackCalls := newUsageTotalHarness(t, tc.later)
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(response)
			r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
			u := r.EventV2.Usage
			if response.StatusCode != http.StatusOK {
				t.Fatal("integer/optional total changed protocol acceptance")
			}
			if tc.negative {
				if r.Status != string(OutcomeUnknown) || r.ErrorCode != "invalid_provider_usage" || !u.Estimated || u.InputTokens != nil || u.OutputTokens != nil || u.TotalTokens != nil || u.CachedInputTokens != nil || u.ReasoningTokens != nil || r.InputTokens != 0 || r.OutputTokens != 0 {
					t.Fatal("negative integer bypassed existing unknown-usage guard")
				}
			} else if r.Status != string(OutcomeCompleted) || u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.TotalTokens == nil || *u.TotalTokens != 7 {
				t.Fatal("optional/partial usage lost existing observations")
			}
		})
	}
}

func newUsageTotalHarness(t *testing.T, later string) (*testHarness, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"private-usage-content"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`+"\n\n")
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, "data: "+later+"\n\ndata: [DONE]\n\n")
		},
		ExtraChannels: []SnapshotChannel{{ID: "usage-total-fallback", ConnectionID: "usage-total-fallback-connection", ProviderID: "prov_openai", Provider: "openai", Protocol: "openai", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "usage-total-fallback" {
		t.Fatalf("fallback fixture is not eligible: candidates=%+v error=%v", candidates, err)
	}
	return h, &calls, &fallbackCalls
}

func usageTotalSoleRecord(t *testing.T, h *testHarness, calls, fallbackCalls *atomic.Int32) *TerminalRecord {
	t.Helper()
	records := h.store.Requests()
	captured := h.store.CapturedRequests()
	h.store.mu.Lock()
	attemptCaptures := len(h.store.capturedAttempts)
	h.store.mu.Unlock()
	if calls.Load() != 1 || fallbackCalls.Load() != 0 || len(captured) != 1 || attemptCaptures != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 || h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 {
		t.Fatalf("usage error replayed or lost terminal: calls=%d fallback=%d captures=%d attempts=%d terminals=%d outbox=%d", calls.Load(), fallbackCalls.Load(), len(captured), attemptCaptures, len(records), h.store.OutboxCount(testTenantID))
	}
	r := records[0]
	a := r.Attempts[0]
	if r.EventV2 == nil || r.EventV2.RequestId != r.RequestID || captured[0].RequestID != r.RequestID || r.EventV2.AttemptId != a.AttemptID || a.AttemptNumber != 1 || a.ChannelID != "chan_test_1" {
		t.Fatal("usage error rebound sole execution attribution")
	}
	return r
}
