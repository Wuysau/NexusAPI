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

const openAIRequestIDHeader = "req_fixture_http_123"
const openAIRequestIDBody = "chatcmpl_fixture_body_456"

func TestOpenAIRequestIDGatewayHTTP(t *testing.T) {
	for _, ending := range []string{"completed", "truncated", "protocol_error"} {
		for _, v2 := range []bool{false, true} {
			for _, streaming := range []bool{false, true} {
				for _, header := range []string{"", openAIRequestIDHeader} {
					t.Run(fmt.Sprintf("%s/v2=%t/stream=%t/header=%t", ending, v2, streaming, header != ""), func(t *testing.T) {
						verifyOpenAIRequestIDGateway(t, ending, v2, streaming, header, header)
					})
				}
			}
		}
	}
}

func TestOpenAIRequestIDGatewayBound(t *testing.T) {
	for _, tc := range []struct{ name, id, want string }{
		{"exact", strings.Repeat("a", 512), strings.Repeat("a", 512)},
		{"oversized", strings.Repeat("a", 513), ""},
	} {
		for _, v2 := range []bool{false, true} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/v2=%t/stream=%t", tc.name, v2, streaming), func(t *testing.T) {
					verifyOpenAIRequestIDGateway(t, "completed", v2, streaming, tc.id, tc.want)
				})
			}
		}
	}
}

func verifyOpenAIRequestIDGateway(t *testing.T, ending string, v2, streaming bool, headerID, wantID string) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer upstream-test-secret" {
				t.Error("Gateway fixture did not reach the compatible endpoint")
			}
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("X-Private-Upstream", "private-openai-id-header")
			if headerID != "" {
				w.Header().Set("X-Request-ID", headerID)
			}
			_, _ = io.WriteString(w, openAIRequestIDWire(ending))
		},
		ExtraChannels: []SnapshotChannel{{ID: "openai-id-fallback", ConnectionID: "openai-id-fallback-connection", ProviderID: "prov_openai", Provider: "openai", Protocol: "openai", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal("load synthetic signed snapshot")
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "openai-id-fallback" {
		t.Fatal("primary and fallback are not both eligible")
	}
	var logs connectorRetryLogs
	h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
	response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-openai-prompt"}}}), nil)
	raw, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatal("read/close synthetic public response")
	}
	body := string(raw)
	records := h.store.Requests()
	if calls.Load() != 1 || fallbackCalls.Load() != 0 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 {
		t.Fatal("ID metadata altered execution/attempt/terminal/outbox cardinality")
	}
	r := records[0]
	if v2 {
		r = usageTotalSoleRecord(t, h, &calls, &fallbackCalls)
	}
	a := r.Attempts[0]
	serverID := response.Header.Get("X-Request-ID")
	if serverID == "" || serverID != r.RequestID || r.Event.RequestID != serverID || r.Event.AttemptID != a.AttemptID || serverID == headerID || serverID == openAIRequestIDBody || !strings.Contains(body, serverID) {
		t.Error("provider metadata changed authoritative Gateway identity")
	}
	wantStatus := string(OutcomeCompleted)
	if ending != "completed" {
		wantStatus = string(OutcomeUnknown)
		if r.ErrorCode != CodeUpstreamProtocol {
			t.Error("broken stream protocol outcome changed")
		}
	}
	if r.Status != wantStatus || a.Status != wantStatus || r.Event.Status != wantStatus || r.InputTokens != 5 || r.OutputTokens != 2 || a.InputTokens != 5 || a.OutputTokens != 2 || r.Event.Usage.InputTokens != 5 || r.Event.Usage.OutputTokens != 2 || r.Event.Usage.Estimated != (ending != "completed") {
		t.Error("metadata changed known usage or completion status")
	}
	if ending == "completed" {
		if response.StatusCode != http.StatusOK || !strings.Contains(body, "private-openai-content") || (streaming && !strings.Contains(body, "[DONE]")) {
			t.Error("completed public response changed")
		}
	} else if streaming {
		if response.StatusCode != http.StatusOK || !strings.Contains(body, CodeUpstreamProtocol) || !strings.Contains(body, "private-openai-content") || strings.Contains(body, "[DONE]") {
			t.Error("broken streamed public response changed")
		}
	} else if response.StatusCode != http.StatusBadGateway || !strings.Contains(body, CodeUpstreamProtocol) || strings.Contains(body, "private-openai-content") {
		t.Error("broken buffered public response changed")
	}
	v1ID := openAIRequestIDValue(r.Event.ProviderRequestID)
	if r.UpstreamRequestID != wantID || a.UpstreamRequestID != wantID || v1ID != wantID {
		t.Errorf("ordinary header lost from request/attempt/v1: request=%q attempt=%q event=%q want=%q", r.UpstreamRequestID, a.UpstreamRequestID, v1ID, wantID)
	}
	if v2 {
		if r.EventV2 == nil || r.EventV2.RequestId != serverID || r.EventV2.AttemptId != a.AttemptID || r.EventV2.Status != wantStatus {
			t.Fatal("v2 execution attribution changed")
		}
		u := r.EventV2.Usage
		if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.TotalTokens == nil || *u.TotalTokens != 7 || u.CachedInputTokens == nil || *u.CachedInputTokens != 0 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || u.Estimated != (ending != "completed") {
			t.Error("v2 observed usage changed or was fabricated")
		}
		if gotID := openAIRequestIDValue(r.EventV2.ProviderRequestId); gotID != wantID {
			t.Errorf("ordinary header lost from v2: event=%q want=%q", gotID, wantID)
		}
	}
	facts, err := json.Marshal(struct {
		Captured []*FrozenRequest
		Terminal []*TerminalRecord
	}{h.store.CapturedRequests(), records})
	if err != nil {
		t.Fatal("serialize synthetic execution facts")
	}
	for _, private := range []string{"private-openai-prompt", "private-openai-content", "private-upstream-detail", "private-openai-id-header", testAPIKey, "upstream-test-secret"} {
		if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
			t.Error("synthetic private content/credential entered facts or logs")
		}
	}
	if headerID != "" && (strings.Contains(body, headerID) || strings.Contains(fmt.Sprint(response.Header), headerID) || strings.Contains(logs.String(), headerID)) || strings.Contains(body, openAIRequestIDBody) || strings.Contains(fmt.Sprint(response.Header), openAIRequestIDBody) || strings.Contains(logs.String(), openAIRequestIDBody) {
		t.Error("provider IDs replaced public Gateway response identity")
	}
	for _, private := range []string{"private-upstream-detail", "private-openai-id-header", testAPIKey, "upstream-test-secret"} {
		if strings.Contains(body, private) || strings.Contains(fmt.Sprint(response.Header), private) {
			t.Error("synthetic private provider detail/credential entered public response")
		}
	}
	if h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 || r.ProviderID != "prov_openai" || a.ProviderID != "prov_openai" || a.ChannelID != "chan_test_1" {
		t.Error("request ID metadata changed routing, attribution or BYOK reservation")
	}
	if ending == "completed" {
		if strings.Count(body, "private-openai-content") != 1 || streaming && strings.Count(body, "data: [DONE]") != 1 {
			t.Error("metadata changed content or terminal frame cardinality")
		}
		if streaming {
			for _, chunk := range streamOptionChunks(t, body) {
				if chunk["id"] != "chatcmpl-"+serverID {
					t.Error("provider ID replaced the public streamed completion ID")
				}
			}
		} else {
			var completion struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(raw, &completion); err != nil || completion.ID != "chatcmpl-"+serverID {
				t.Error("provider ID replaced the public buffered completion ID")
			}
		}
	}
}

func openAIRequestIDValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func openAIRequestIDWire(ending string) string {
	first := `{"id":"chatcmpl_fixture_body_456","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"private-openai-content"},"finish_reason":null}]}`
	finish := `{"id":"chatcmpl_fixture_body_456","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
	usage := `{"id":"chatcmpl_fixture_body_456","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`
	wire := "data: " + first + "\n\n"
	if ending == "completed" {
		wire += "data: " + finish + "\n\n"
	}
	wire += "data: " + usage + "\n\n"
	switch ending {
	case "completed":
		wire += "data: [DONE]\n\n"
	case "protocol_error":
		wire += "data: {\"error\":{\"type\":\"server_error\",\"message\":\"private-upstream-detail\"}}\n\n"
	}
	return wire
}
