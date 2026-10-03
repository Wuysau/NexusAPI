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

const anthropicRequestIDHeaderValue = "req_anthropic_http_identity"
const anthropicRequestIDBodyValue = "msg_anthropic_body_identity"

type anthropicRequestIDCase struct {
	name, header, bodyID, wantID string
	setHeader                    bool
}

func TestAnthropicStreamRequestIDMetadata(t *testing.T) {
	for _, tc := range []anthropicRequestIDCase{
		{"header request identity", anthropicRequestIDHeaderValue, anthropicRequestIDBodyValue, anthropicRequestIDHeaderValue, true},
		{"absent header body fallback", "", anthropicRequestIDBodyValue, anthropicRequestIDBodyValue, false},
		{"header exact ASCII boundary", strings.Repeat("a", 512), anthropicRequestIDBodyValue, strings.Repeat("a", 512), true},
		{"header above ASCII boundary", strings.Repeat("a", 513), anthropicRequestIDBodyValue, "", true},
	} {
		for _, v2 := range []bool{false, true} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/v2=%t/stream=%t", tc.name, v2, streaming), func(t *testing.T) {
					assertAnthropicStreamRequestID(t, tc, v2, streaming)
				})
			}
		}
	}
}

func TestAnthropicStreamRequestIDCompatibility(t *testing.T) {
	for _, tc := range []anthropicRequestIDCase{
		// These values exceed 512 bytes while exercising the shared code-point limit.
		{"header exact Unicode boundary", strings.Repeat("界", 512), anthropicRequestIDBodyValue, strings.Repeat("界", 512), true},
		{"header above Unicode boundary", strings.Repeat("界", 513), anthropicRequestIDBodyValue, "", true},
		{"empty header body fallback", "", anthropicRequestIDBodyValue, anthropicRequestIDBodyValue, true},
		{"absent body ID preserves header", anthropicRequestIDHeaderValue, "", anthropicRequestIDHeaderValue, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertAnthropicStreamRequestID(t, tc, true, false)
		})
	}
}

func assertAnthropicStreamRequestID(t *testing.T, tc anthropicRequestIDCase, v2, streaming bool) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		adapterFixtureResponse(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if !strings.HasSuffix(r.URL.Path, "/messages") || r.Header.Get("x-api-key") != "upstream-test-secret" {
				t.Error("request missed native Anthropic endpoint or authentication")
			}
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("x-private-upstream", "private-anthropic-request-id-header")
			if tc.setHeader {
				w.Header().Set("request-id", tc.header)
			}
			_, _ = io.WriteString(w, anthropicRequestIDWire(tc.bodyID))
		},
		ExtraChannels: []SnapshotChannel{{ID: "anthropic-request-id-fallback", ConnectionID: "anthropic-request-id-fallback-connection", ProviderID: "provider-anthropic", Provider: "anthropic", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	setValidationProvider(t, h, "anthropic")
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "anthropic-request-id-fallback" {
		t.Fatal("primary and fallback are not both eligible")
	}
	var logs connectorRetryLogs
	h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
	response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-anthropic-request-id-prompt"}}}), nil)
	body := anthropicGatewayRead(t, response)
	records := h.store.Requests()
	if response.StatusCode != http.StatusOK || calls.Load() != 1 || fallbackCalls.Load() != 0 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 {
		t.Fatal("metadata changed execution/attempt/terminal/outbox cardinality")
	}
	wantCaptured := 0
	if v2 {
		wantCaptured = 1
	}
	if len(h.store.CapturedRequests()) != wantCaptured || h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 {
		t.Error("metadata changed capture count or fabricated a BYOK reservation")
	}
	r, a := records[0], records[0].Attempts[0]
	assertProviderRequestIDPublicOutput(t, response, body, streaming, r.RequestID)
	// An oversized selected header is omitted by the shared projection. It must
	// not silently fall back to the otherwise compliant body message ID.
	assertProviderRequestIDProjection(t, r, tc.wantID)
	input := 3 // Keep the legacy exclusive input projection.
	if v2 {
		input = 5
		if r.EventV2 == nil {
			t.Fatal("canonical event missing")
		}
		e, u := r.EventV2, r.EventV2.Usage
		if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.CachedInputTokens == nil || *u.CachedInputTokens != 1 || u.CacheCreationInputTokens == nil || *u.CacheCreationInputTokens != 1 || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || u.TotalTokens != nil || u.Estimated || u.Semantics != "anthropic-inclusive-v1" {
			t.Error("metadata changed canonical measured evidence or fabricated a total")
		}
		if e.Status != string(OutcomeCompleted) || e.RequestId != r.RequestID || e.AttemptId != a.AttemptID || e.ProviderId == nil || *e.ProviderId != "provider-anthropic" || e.Attribution.ConnectionId == nil || *e.Attribution.ConnectionId != candidates[0].Channel.ConnectionID || e.Attribution.ChannelId == nil || *e.Attribution.ChannelId != candidates[0].Channel.ID || e.Attribution.ProjectId == nil || *e.Attribution.ProjectId != "project-test" || e.Attribution.ApiKeyId == nil || *e.Attribution.ApiKeyId != testKeyID {
			t.Error("metadata changed frozen execution attribution")
		}
	} else if r.EventV2 != nil {
		t.Error("legacy request changed its event version")
	}
	if r.Status != string(OutcomeCompleted) || a.Status != string(OutcomeCompleted) || r.Event.Status != string(OutcomeCompleted) || r.ErrorCode != "" || r.InputTokens != input || a.InputTokens != input || r.OutputTokens != 2 || a.OutputTokens != 2 || r.CachedTokens != 1 || a.CachedTokens != 1 || r.ReasoningTokens != 0 || a.ReasoningTokens != 0 || r.Event.Usage.InputTokens != input || r.Event.Usage.OutputTokens != 2 || r.Event.Usage.Estimated || r.ProviderID != "provider-anthropic" || a.ProviderID != r.ProviderID || r.ChargeAmount != 0 || r.ReservationAmount != 0 {
		t.Error("metadata changed completion, usage, provider attribution, or money")
	}
	facts, err := json.Marshal(struct {
		Captured []*FrozenRequest
		Terminal []*TerminalRecord
	}{h.store.CapturedRequests(), records})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-anthropic-request-id-prompt", "private-id-output-marker", "private-anthropic-request-id-header", testAPIKey, "upstream-test-secret"} {
		if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
			t.Error("private content or credentials entered facts or logs")
		}
	}
	for _, id := range []string{tc.header, tc.bodyID} {
		if id != "" && (strings.Contains(body, id) || strings.Contains(fmt.Sprint(response.Header), id) || strings.Contains(logs.String(), id)) {
			t.Error("provider identity replaced public Gateway identity or entered routine logs")
		}
	}
}

func anthropicRequestIDWire(bodyID string) string {
	idField := ""
	if bodyID != "" {
		encodedID, _ := json.Marshal(bodyID)
		idField = `"id":` + string(encodedID) + `,`
	}
	frames := []string{
		`{"type":"message_start","message":{` + idField + `"type":"message","role":"assistant","model":"gpt-4o","content":[],"stop_reason":null,"stop_sequence":null,"usage":` + anthropicGatewayInitialUsage + `}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"private-id-output-marker"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`,
		`{"type":"message_stop"}`,
	}
	return "data: " + strings.Join(frames, "\n\ndata: ") + "\n\n"
}
