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

func TestOptionalProviderRequestIDPreservesTerminal(t *testing.T) {
	for _, adapter := range []string{"gemini", "anthropic"} {
		normal := "6b14d2a7-e5ce-4b6a-bdda-78b7285ae399"
		if adapter == "anthropic" {
			normal = "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY"
		}
		for _, tc := range []struct{ name, id, want string }{
			{"normal", normal, normal},
			{"absent", "", ""},
			{"ASCII 512", strings.Repeat("a", 512), strings.Repeat("a", 512)},
			{"ASCII 513", strings.Repeat("a", 513), ""},
			{"Unicode 512", strings.Repeat("界", 512), strings.Repeat("界", 512)},
			{"Unicode 513", strings.Repeat("界", 513), ""},
		} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/stream=%t", adapter, tc.name, streaming), func(t *testing.T) {
					h, calls, fallbackCalls := newProviderRequestIDHarness(t, adapter, tc.id, true)
					var logs connectorRetryLogs
					h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
					opts := chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-id-prompt"}}}
					if streaming {
						opts.Extra = map[string]any{"stream_options": map[string]any{"include_usage": true}}
					}
					response := h.doChat(chatBody(opts), nil)
					body := anthropicGatewayRead(t, response)
					if response.StatusCode != http.StatusOK {
						t.Errorf("optional provider ID invalidated valid generation: HTTP=%d", response.StatusCode)
					}
					r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
					if r.Status != string(OutcomeCompleted) || r.ErrorCode != "" || r.Attempts[0].Status != string(OutcomeCompleted) || r.EventV2.Status != string(OutcomeCompleted) {
						t.Error("optional provider metadata changed completed execution")
					}
					assertProviderRequestIDProjection(t, r, tc.want)
					u := r.EventV2.Usage
					cached := int64(0)
					if adapter == "anthropic" {
						cached = 1
					}
					if u.Estimated || u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 2 || u.CachedInputTokens == nil || *u.CachedInputTokens != cached || u.ReasoningTokens == nil || *u.ReasoningTokens != 0 || r.InputTokens != 5 || r.OutputTokens != 2 || r.Attempts[0].InputTokens != 5 || r.Attempts[0].OutputTokens != 2 || r.EventV2.ProviderId == nil || *r.EventV2.ProviderId != "provider-"+adapter {
						t.Error("optional provider ID changed exact native usage or attribution")
					}
					if adapter == "gemini" {
						if u.TotalTokens == nil || *u.TotalTokens != 7 || u.CacheCreationInputTokens != nil || u.Semantics != "" {
							t.Error("Gemini usage changed its measured total")
						}
					} else if u.TotalTokens != nil || u.CacheCreationInputTokens == nil || *u.CacheCreationInputTokens != 1 || u.Semantics != "anthropic-inclusive-v1" {
						t.Error("Anthropic usage lost inclusive cache evidence or invented a total")
					}
					assertProviderRequestIDPublicOutput(t, response, body, streaming, r.RequestID)
					facts, err := json.Marshal(struct {
						Captured []*FrozenRequest
						Terminal []*TerminalRecord
					}{h.store.CapturedRequests(), h.store.Requests()})
					if err != nil {
						t.Fatal(err)
					}
					for _, private := range []string{"private-id-prompt", "private-id-output-marker", "private-id-upstream-header", testAPIKey, "upstream-test-secret"} {
						if bytes.Contains(facts, []byte(private)) || strings.Contains(logs.String(), private) {
							t.Error("provider/request content, unrelated headers or credentials entered facts/logs")
						}
					}
					for _, private := range []string{"private-id-upstream-header", testAPIKey, "upstream-test-secret"} {
						if strings.Contains(body, private) || strings.Contains(fmt.Sprint(response.Header), private) {
							t.Error("private upstream headers or credentials entered public output")
						}
					}
					if tc.id != "" && (strings.Contains(body, tc.id) || strings.Contains(fmt.Sprint(response.Header), tc.id) || strings.Contains(logs.String(), tc.id)) {
						t.Error("provider ID replaced public Gateway identity or entered routine logs")
					}
				})
			}
		}
	}
}

func TestLegacyOptionalProviderRequestIDIsBounded(t *testing.T) {
	for _, adapter := range []string{"gemini", "anthropic"} {
		t.Run(adapter, func(t *testing.T) {
			h, calls, fallbackCalls := newProviderRequestIDHarness(t, adapter, strings.Repeat("a", 513), false)
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = anthropicGatewayRead(t, response)
			records := h.store.Requests()
			if response.StatusCode != http.StatusOK || calls.Load() != 1 || fallbackCalls.Load() != 0 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("optional ID changed legacy execution cardinality")
			}
			r := records[0]
			assertProviderRequestIDProjection(t, r, "")
			input := 5
			if adapter == "anthropic" {
				input = 3 // Preserve the pre-existing V1 provider projection.
			}
			if r.EventV2 != nil || r.Status != string(OutcomeCompleted) || r.InputTokens != input || r.OutputTokens != 2 || r.Event.Usage.Estimated || r.Attempts[0].InputTokens != input || r.Attempts[0].OutputTokens != 2 {
				t.Error("optional metadata changed legacy usage semantics")
			}
		})
	}
}

func TestApplyUsageBoundsProviderIDWithoutMutatingSource(t *testing.T) {
	for _, tc := range []struct{ name, id, want string }{
		{"ASCII oversized", strings.Repeat("a", 513), ""},
		{"Unicode exact boundary", strings.Repeat("界", 512), strings.Repeat("界", 512)},
		{"Unicode oversized", strings.Repeat("界", 513), ""},
		{"opaque format", " opaque/vendor:id? zone=global ", " opaque/vendor:id? zone=global "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observed := &provider.ObservedUsage{InputTokens: anthropicGatewayInt(5), OutputTokens: anthropicGatewayInt(2), TotalTokens: anthropicGatewayInt(7)}
			source := &provider.CanonicalUsage{ProviderRequestID: tc.id, InputTokens: 5, OutputTokens: 2, Observed: observed}
			var result attemptResult
			result.applyUsage(source, &chatRequest{})
			if result.usage.ProviderRequestID != tc.want || result.usage.InputTokens != 5 || result.usage.OutputTokens != 2 || result.usage.Observed != observed || result.usage.Estimated || result.usageEstimated {
				t.Error("optional ID projection changed copied usage or opaque identifier semantics")
			}
			if source.ProviderRequestID != tc.id || source.InputTokens != 5 || source.OutputTokens != 2 || source.Observed != observed || *observed.TotalTokens != 7 {
				t.Error("Gateway optional ID projection mutated provider-owned usage")
			}
		})
	}
}

func assertProviderRequestIDProjection(t *testing.T, r *TerminalRecord, want string) {
	t.Helper()
	if r.UpstreamRequestID != want || r.Attempts[0].UpstreamRequestID != want || (r.Event.ProviderRequestID == nil) != (want == "") || r.Event.ProviderRequestID != nil && *r.Event.ProviderRequestID != want {
		t.Error("optional provider ID differed across request/attempt/event projections")
	}
	if r.EventV2 != nil && ((r.EventV2.ProviderRequestId == nil) != (want == "") || r.EventV2.ProviderRequestId != nil && *r.EventV2.ProviderRequestId != want) {
		t.Error("canonical provider ID did not preserve the bounded optional projection")
	}
}

func assertProviderRequestIDPublicOutput(t *testing.T, response *http.Response, body string, streaming bool, requestID string) {
	t.Helper()
	if response.Header.Get("x-request-id") != requestID || !strings.HasPrefix(requestID, "req_") || strings.Contains(body, `"error"`) || strings.Count(body, "private-id-output-marker") != 1 {
		t.Error("optional upstream metadata changed public Gateway identity/content")
	}
	if streaming {
		if strings.Count(body, "data: [DONE]") != 1 {
			t.Error("valid native generation lost its sole terminal frame")
		}
		for _, chunk := range streamOptionChunks(t, body) {
			if chunk["id"] != "chatcmpl-"+requestID {
				t.Error("native stream chunk lost the authoritative Gateway request ID")
			}
		}
		return
	}
	var completion struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &completion); err != nil || completion.ID != "chatcmpl-"+requestID {
		t.Error("buffered completion lost the authoritative Gateway request ID")
	}
}

func newProviderRequestIDHarness(t *testing.T, adapter, id string, v2 bool) (*testHarness, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		adapterFixtureResponse(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok", MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-private-upstream", "private-id-upstream-header")
		if adapter == "gemini" {
			if !strings.Contains(r.URL.Path, ":streamGenerateContent") {
				t.Error("fixture missed native Gemini SSE")
			}
			if id != "" {
				w.Header().Set("x-request-id", id)
			}
			_, _ = io.WriteString(w, "data: "+`{"candidates":[{"content":{"parts":[{"text":"private-id-output-marker"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":7}}`+"\n\ndata: "+`{"candidates":[{"finishReason":"STOP"}]}`+"\n\n")
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/messages") {
			t.Error("fixture missed native Anthropic SSE")
		}
		encodedID, _ := json.Marshal(id)
		for _, frame := range []string{
			`{"type":"message_start","message":{"id":` + string(encodedID) + `,"type":"message","role":"assistant","model":"gpt-4o","content":[],"stop_reason":null,"stop_sequence":null,"usage":` + anthropicGatewayInitialUsage + `}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"private-id-output-marker"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		} {
			_, _ = io.WriteString(w, "data: "+frame+"\n\n")
		}
	}, ExtraChannels: []SnapshotChannel{{ID: "provider-id-fallback", ConnectionID: "provider-id-fallback-connection", ProviderID: "provider-" + adapter, Provider: adapter, BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}}})
	setValidationProvider(t, h, adapter)
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "provider-id-fallback" {
		t.Fatalf("native metadata fallback fixture is not eligible: candidates=%+v error=%v", candidates, err)
	}
	return h, &calls, &fallbackCalls
}
