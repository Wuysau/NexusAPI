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

func TestAnthropicMalformedUsageIsUnknownWithoutReplay(t *testing.T) {
	for _, field := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "thinking_tokens"} {
		for _, tc := range []struct{ name, value string }{
			{"fractional", "1.5"},
			{"wrong type", `"private-invalid-anthropic-usage"`},
			{"int64 overflow", "9223372036854775808"},
		} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/stream=%t", field, tc.name, streaming), func(t *testing.T) {
					anthropicMalformedGatewayCase(t, anthropicGatewayInitialUsage, anthropicGatewayCounter(field, tc.value), true, streaming, true, anthropicGatewayKnownUsage())
				})
			}
		}
	}
	for _, tc := range []struct {
		name, initial, later string
		recovery, content    bool
		want                 anthropicGatewayUsage
	}{
		{"direct cache creation", anthropicGatewayInitialUsage, anthropicGatewayCounter("cache_creation_input_tokens", "1.5"), false, true, anthropicGatewayKnownUsage()},
		{"direct thinking", anthropicGatewayInitialUsage, anthropicGatewayCounter("thinking_tokens", "1.5"), false, true, anthropicGatewayKnownUsage()},
		{"partial prior usage", `{"input_tokens":3,"output_tokens":2}`, anthropicGatewayCounter("cache_creation_input_tokens", "1.5"), true, true, anthropicGatewayUsage{output: anthropicGatewayInt(2), semantics: "anthropic-inclusive-v1"}},
		{"initial cache creation", `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":1.5,"output_tokens_details":{"thinking_tokens":0}}`, "", true, false, anthropicGatewayUsage{}},
		{"initial thinking", `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":1.5}}`, "", true, false, anthropicGatewayUsage{}},
	} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, streaming), func(t *testing.T) {
				anthropicMalformedGatewayCase(t, tc.initial, tc.later, tc.recovery, streaming, tc.content, tc.want)
			})
		}
	}
}

func anthropicMalformedGatewayCase(t *testing.T, initial, later string, recovery, streaming, content bool, want anthropicGatewayUsage) {
	t.Helper()
	h, calls, fallbackCalls := newAnthropicUsageHarness(t, initial, later, recovery)
	var logs connectorRetryLogs
	h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
	response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-anthropic-prompt"}}}), nil)
	body := anthropicGatewayRead(t, response)
	r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
	if r.Status != string(OutcomeUnknown) || r.ErrorCode != CodeUpstreamProtocol || r.Attempts[0].Status != string(OutcomeUnknown) || r.EventV2.Status != string(OutcomeUnknown) {
		t.Errorf("malformed native usage completed: terminal=%s/%s attempt=%s", r.Status, r.ErrorCode, r.Attempts[0].Status)
	}
	assertAnthropicGatewayUsage(t, r, want, true)
	if streaming {
		if response.StatusCode != http.StatusOK || strings.Count(body, CodeUpstreamProtocol) != 1 || strings.Contains(body, "[DONE]") || strings.Contains(body, "private-anthropic-content") != content {
			t.Error("malformed native streamed usage reported successful completion or lost the accepted prefix")
		}
	} else if response.StatusCode != http.StatusBadGateway || strings.Count(body, CodeUpstreamProtocol) != 1 || strings.Contains(body, "private-anthropic-content") {
		t.Error("malformed native buffered usage reported successful completion")
	}
	assertAnthropicGatewayPrivacy(t, h, response, body, logs.String())
}

func TestAnthropicUsageCompatibilityPreservesInclusiveGuards(t *testing.T) {
	known := anthropicGatewayKnownUsage()
	for _, tc := range []struct {
		name, initial, later string
		want                 anthropicGatewayUsage
		invalid              bool
	}{
		{"updated input", anthropicGatewayInitialUsage, anthropicGatewayCounter("input_tokens", "4"), anthropicGatewayUsage{anthropicGatewayInt(6), anthropicGatewayInt(2), anthropicGatewayInt(1), anthropicGatewayInt(1), anthropicGatewayInt(0), "anthropic-inclusive-v1"}, false},
		{"updated cache read", anthropicGatewayInitialUsage, anthropicGatewayCounter("cache_read_input_tokens", "2"), anthropicGatewayUsage{anthropicGatewayInt(6), anthropicGatewayInt(2), anthropicGatewayInt(2), anthropicGatewayInt(1), anthropicGatewayInt(0), "anthropic-inclusive-v1"}, false},
		{"updated cache creation", anthropicGatewayInitialUsage, anthropicGatewayCounter("cache_creation_input_tokens", "2"), anthropicGatewayUsage{anthropicGatewayInt(6), anthropicGatewayInt(2), anthropicGatewayInt(1), anthropicGatewayInt(2), anthropicGatewayInt(0), "anthropic-inclusive-v1"}, false},
		{"updated thinking subset", anthropicGatewayInitialUsage, anthropicGatewayCounter("thinking_tokens", "1"), anthropicGatewayUsage{anthropicGatewayInt(5), anthropicGatewayInt(2), anthropicGatewayInt(1), anthropicGatewayInt(1), anthropicGatewayInt(1), "anthropic-inclusive-v1"}, false},
		{"absent usage", anthropicGatewayInitialUsage, `{"type":"message_delta","delta":{}}`, known, false},
		{"null usage", anthropicGatewayInitialUsage, `{"type":"message_delta","delta":{},"usage":null}`, known, false},
		{"null counters", anthropicGatewayInitialUsage, `{"type":"message_delta","delta":{},"usage":{"input_tokens":null,"output_tokens":null,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"output_tokens_details":{"thinking_tokens":null}}}`, known, false},
		{"missing cache creation", `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}`, "", anthropicGatewayUsage{output: anthropicGatewayInt(2), cached: anthropicGatewayInt(1), thinking: anthropicGatewayInt(0), semantics: "anthropic-inclusive-v1"}, false},
		// A negative raw delta input makes observedSum unknown. It is not copied
		// into the legacy input projection; preserve this existing behavior.
		{"negative delta input", anthropicGatewayInitialUsage, anthropicGatewayCounter("input_tokens", "-1"), anthropicGatewayUsage{output: anthropicGatewayInt(2), cached: anthropicGatewayInt(1), creation: anthropicGatewayInt(1), thinking: anthropicGatewayInt(0), semantics: "anthropic-inclusive-v1"}, false},
		{"negative cache read", anthropicGatewayInitialUsage, anthropicGatewayCounter("cache_read_input_tokens", "-1"), anthropicGatewayUsage{}, true},
		{"negative cache creation", anthropicGatewayInitialUsage, anthropicGatewayCounter("cache_creation_input_tokens", "-1"), anthropicGatewayUsage{}, true},
		{"negative thinking", anthropicGatewayInitialUsage, anthropicGatewayCounter("thinking_tokens", "-1"), anthropicGatewayUsage{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, calls, fallbackCalls := newAnthropicUsageHarness(t, tc.initial, tc.later, true)
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = anthropicGatewayRead(t, response)
			r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
			if response.StatusCode != http.StatusOK {
				t.Fatal("integer/optional native usage changed protocol acceptance")
			}
			if tc.invalid {
				if r.Status != string(OutcomeUnknown) || r.ErrorCode != "invalid_provider_usage" || r.EventV2.Status != string(OutcomeUnknown) || r.Attempts[0].Status != string(OutcomeUnknown) {
					t.Error("negative subset bypassed the existing semantic guard")
				}
			} else if r.Status != string(OutcomeCompleted) || r.ErrorCode != "" || r.EventV2.Status != string(OutcomeCompleted) || r.Attempts[0].Status != string(OutcomeCompleted) {
				t.Error("valid/null/partial native usage lost completion")
			}
			assertAnthropicGatewayUsage(t, r, tc.want, tc.invalid)
		})
	}
}

type anthropicGatewayUsage struct {
	input, output, cached, creation, thinking *int64
	semantics                                 string
}

const anthropicGatewayInitialUsage = `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}`

func anthropicGatewayInt(value int64) *int64 { return &value }

func anthropicGatewayKnownUsage() anthropicGatewayUsage {
	return anthropicGatewayUsage{anthropicGatewayInt(5), anthropicGatewayInt(2), anthropicGatewayInt(1), anthropicGatewayInt(1), anthropicGatewayInt(0), "anthropic-inclusive-v1"}
}

func assertAnthropicGatewayUsage(t *testing.T, r *TerminalRecord, want anthropicGatewayUsage, estimated bool) {
	t.Helper()
	u := r.EventV2.Usage
	if u.TotalTokens != nil || u.Estimated != estimated || u.Semantics != want.semantics || r.EventV2.ProviderId == nil || *r.EventV2.ProviderId != "provider-anthropic" {
		t.Error("native usage invented a total or changed estimation/semantics/provider attribution")
	}
	for _, counter := range []struct {
		name      string
		got, want *int64
	}{
		{"inclusive input", u.InputTokens, want.input}, {"output", u.OutputTokens, want.output}, {"cache read", u.CachedInputTokens, want.cached}, {"cache creation", u.CacheCreationInputTokens, want.creation}, {"thinking", u.ReasoningTokens, want.thinking},
	} {
		if (counter.got == nil) != (counter.want == nil) || (counter.got != nil && counter.want != nil && *counter.got != *counter.want) {
			t.Errorf("native observed %s presence/value changed", counter.name)
		}
	}
	project := func(value *int64) int {
		if value == nil {
			return 0
		}
		return int(*value)
	}
	a := r.Attempts[0]
	if r.InputTokens != project(want.input) || r.OutputTokens != project(want.output) || r.CachedTokens != project(want.cached) || r.ReasoningTokens != project(want.thinking) || a.InputTokens != r.InputTokens || a.OutputTokens != r.OutputTokens || a.CachedTokens != r.CachedTokens || a.ReasoningTokens != r.ReasoningTokens {
		t.Error("canonical nullable evidence changed request/attempt compatibility projections")
	}
}

func anthropicGatewayCounter(field, value string) string {
	usage := `{"output_tokens":2,"` + field + `":` + value + `}`
	if field == "thinking_tokens" {
		usage = `{"output_tokens":2,"output_tokens_details":{"thinking_tokens":` + value + `}}`
	}
	return `{"type":"message_delta","delta":{},"usage":` + usage + `}`
}

func newAnthropicUsageHarness(t *testing.T, initial, later string, recovery bool, messageText ...string) (*testHarness, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	text := "private-anthropic-content"
	if len(messageText) > 0 {
		text = messageText[0]
	}
	encodedText, _ := json.Marshal(text)
	var calls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		adapterFixtureResponse(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			request, err := io.ReadAll(r.Body)
			if err != nil || r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/messages") || r.Header.Get("x-api-key") != "upstream-test-secret" || !bytes.Contains(request, []byte(`"stream":true`)) {
				t.Error("fixture did not reach native authenticated Anthropic SSE")
			}
			frames := []string{
				`{"type":"message_start","message":{"id":"msg_usage_fixture","type":"message","role":"assistant","model":"gpt-4o","content":[],"stop_reason":null,"stop_sequence":null,"usage":` + initial + `}}`,
				`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":` + string(encodedText) + `}}`,
				`{"type":"content_block_stop","index":0}`,
			}
			if later != "" {
				laterFrame := later
				if !recovery {
					laterFrame = strings.Replace(laterFrame, `"delta":{}`, `"delta":{"stop_reason":"end_turn","stop_sequence":null}`, 1)
				}
				frames = append(frames, laterFrame)
			}
			if recovery {
				frames = append(frames, `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`)
			}
			frames = append(frames, `{"type":"message_stop"}`)
			w.Header().Set("Content-Type", "text/event-stream")
			for _, frame := range frames {
				var event struct {
					Type string `json:"type"`
				}
				if err := json.Unmarshal([]byte(frame), &event); err != nil {
					t.Error("usage fixture has invalid JSON")
					return
				}
				_, _ = io.WriteString(w, "event: "+event.Type+"\ndata: "+frame+"\n\n")
				w.(http.Flusher).Flush()
			}
		},
		ExtraChannels: []SnapshotChannel{{ID: "anthropic-usage-fallback", ConnectionID: "anthropic-usage-fallback-connection", ProviderID: "provider-anthropic", Provider: "anthropic", BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "cred_byok_test", Priority: 1, Weight: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}},
	})
	setValidationProvider(t, h, "anthropic")
	state, err := h.snapshots.Get(context.Background(), testTenantID)
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := h.proxy.router.Select(state.Verified.Bundle, RouteRequest{TenantID: testTenantID, ProjectID: "project-test", RequestedModel: testModel, ResolvedModel: testModel, CredentialMode: "byok", RequiredCapabilities: []string{"text", "streaming"}})
	if err != nil || len(candidates) != 2 || candidates[0].Channel.ID != "chan_test_1" || candidates[1].Channel.ID != "anthropic-usage-fallback" {
		t.Fatalf("native fallback fixture is not eligible: candidates=%+v error=%v", candidates, err)
	}
	return h, &calls, &fallbackCalls
}

func anthropicGatewayRead(t *testing.T, response *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("downstream response did not terminate cleanly: read=%v close=%v", err, closeErr)
	}
	return string(body)
}

func assertAnthropicGatewayPrivacy(t *testing.T, h *testHarness, response *http.Response, body, logs string) {
	t.Helper()
	facts, err := json.Marshal(struct {
		Captured []*FrozenRequest
		Terminal []*TerminalRecord
	}{h.store.CapturedRequests(), h.store.Requests()})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-anthropic-prompt", "private-anthropic-content", "private-anthropic-stop-explanation", "private-invalid-anthropic-usage", testAPIKey, "upstream-test-secret"} {
		if bytes.Contains(facts, []byte(private)) || strings.Contains(logs, private) {
			t.Error("provider/request content or credentials entered durable facts or logs")
		}
	}
	for _, private := range []string{"private-invalid-anthropic-usage", "private-anthropic-stop-explanation", testAPIKey, "upstream-test-secret"} {
		if strings.Contains(body, private) || strings.Contains(fmt.Sprint(response.Header), private) {
			t.Error("provider details or credentials entered downstream response")
		}
	}
}
