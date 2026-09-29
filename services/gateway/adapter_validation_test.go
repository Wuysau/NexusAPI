package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"nexus/gateway/provider"
)

type countedValidationCredentials struct {
	CredentialResolver
	calls atomic.Int32
}

func (c *countedValidationCredentials) Resolve(ctx context.Context, ref CredentialRef) (provider.Credential, error) {
	c.calls.Add(1)
	return c.CredentialResolver.Resolve(ctx, ref)
}

func adapterFixtureResponse(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "text/event-stream")
	switch {
	case strings.Contains(r.URL.Path, "/models/"):
		_, _ = io.WriteString(w, "data: "+`{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4}}`+"\n\n")
	case strings.HasSuffix(r.URL.Path, "/messages"):
		_, _ = io.WriteString(w, "data: "+`{"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":11}}}`+"\n\n"+
			"data: "+`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`+"\n\n"+
			"data: "+`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`+"\n\n"+
			"data: "+`{"type":"message_stop"}`+"\n\n")
	default:
		defaultUpstreamHandler()(w, r)
	}
}

func setValidationProvider(t *testing.T, h *testHarness, name string) {
	t.Helper()
	updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
		b.Channels[0].Provider = name
		b.Channels[0].ProviderID = "provider-" + name
		b.Models[0].Provider = name
		b.Snapshot.PriceVersions[0].Provider = name
	})
}

func TestUnsupportedAdapterInputFailsBeforeCredentialsOrBudget(t *testing.T) {
	tool := json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`)
	for _, tc := range []struct {
		name, adapter, param string
		extra                map[string]any
		messages             []map[string]any
	}{
		{"gemini_tools", "gemini", "tools", map[string]any{"tools": tool}, nil},
		{"gemini_required_tool", "gemini", "tool_choice", map[string]any{"tool_choice": "required"}, nil},
		{"gemini_json", "gemini", "response_format", map[string]any{"response_format": map[string]any{"type": "json_object"}}, nil},
		{"gemini_schema", "gemini", "response_format", map[string]any{"response_format": map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "fixture", "schema": map[string]any{"type": "object"}}}}, nil},
		{"gemini_tool_history", "gemini", "messages", nil, []map[string]any{{"role": "assistant", "content": nil, "tool_calls": json.RawMessage(`[{"id":"call-fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]`)}}},
		{"gemini_tool_result", "gemini", "messages", nil, []map[string]any{{"role": "tool", "tool_call_id": "call-fixture", "content": "result"}}},
		{"gemini_image", "gemini", "messages", nil, []map[string]any{{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/image"}}}}}},
		{"gemini_system_image", "gemini", "messages", nil, []map[string]any{{"role": "system", "content": []any{map[string]any{"type": "text", "text": "instruction"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/image"}}}}, {"role": "user", "content": "hi"}}},
		{"anthropic_json", "anthropic", "response_format", map[string]any{"response_format": map[string]any{"type": "json_object"}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				adapterFixtureResponse(w, r)
			}})
			setValidationProvider(t, h, tc.adapter)
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			headers := map[string]string{"Idempotency-Key": "unsupported-then-corrected"}
			resp := h.doChat(chatBody(chatBodyOptions{Extra: tc.extra, Messages: tc.messages}), headers)
			var envelope errorEnvelope
			if err := json.Unmarshal([]byte(readAll(resp)), &envelope); err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Param == nil || *envelope.Error.Param != tc.param {
				t.Errorf("unsupported request was not rejected precisely: status=%d code=%s", resp.StatusCode, envelope.Error.Code)
			}
			if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Errorf("unsupported request crossed execution boundary: upstream=%d credentials=%d reserve=%d records=%d", calls.Load(), credentials.calls.Load(), h.managed.reserveCount(), len(h.store.Requests()))
			}
			if h.breaker.State(BreakerKey("chan_test_1", testModel)) != BreakerClosed {
				t.Error("request compatibility poisoned provider health")
			}
			if t.Failed() {
				return
			}
			recovered := h.doChat(chatBody(chatBodyOptions{}), headers)
			_ = readAll(recovered)
			if recovered.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 {
				t.Fatal("corrected request failed to execute exactly once")
			}
		})
	}
}

func TestResponsesUnsupportedToolDoesNotReachGemini(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { calls.Add(1); adapterFixtureResponse(w, r) }})
	setValidationProvider(t, h, "gemini")
	router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hi","tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]}`))
	req.Header.Set("Authorization", "Bearer "+testAPIKey)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), CodeUnsupportedParam) || calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
		t.Fatal("Responses lost tool requirements or created accounting for a rejected call")
	}
}

func TestOpenAIProtocolKeepsCustomModelConstraints(t *testing.T) {
	wire := make(chan map[string]json.RawMessage, 1)
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		var fields map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
			t.Error(err)
		}
		wire <- fields
		adapterFixtureResponse(w, r)
	}})
	const customModel = "local-custom-model:fixture"
	updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
		b.Channels[0].Provider, b.Channels[0].Protocol = "ollama", "openai"
		b.Channels[0].Models = []string{customModel}
		b.Models[0].ID, b.Models[0].Provider = customModel, "ollama"
		b.Snapshot.PriceVersions[0].ModelID, b.Snapshot.PriceVersions[0].Provider = customModel, "ollama"
	})
	constraints := map[string]any{
		"tools":           json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`),
		"tool_choice":     json.RawMessage(`{"type":"function","function":{"name":"lookup"}}`),
		"response_format": json.RawMessage(`{"type":"json_schema","json_schema":{"name":"result","schema":{"type":"object"}}}`),
	}
	resp := h.doChat(chatBody(chatBodyOptions{Model: customModel, Extra: constraints}), nil)
	_ = readAll(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("OpenAI-compatible custom model was rejected: %d", resp.StatusCode)
	}
	fields := <-wire
	for key, expected := range constraints {
		var want, actual any
		if json.Unmarshal(expected.(json.RawMessage), &want) != nil || json.Unmarshal(fields[key], &actual) != nil {
			t.Fatal("missing upstream constraint")
		}
		wantJSON, _ := json.Marshal(want)
		actualJSON, _ := json.Marshal(actual)
		if string(wantJSON) != string(actualJSON) {
			t.Errorf("custom model lost %s", key)
		}
	}
	if h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 {
		t.Fatal("custom model validation changed accounting")
	}
}

func TestAnthropicToolConversionStillExecutes(t *testing.T) {
	wire := make(chan map[string]json.RawMessage, 1)
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		var fields map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
			t.Error(err)
		}
		wire <- fields
		adapterFixtureResponse(w, r)
	}})
	setValidationProvider(t, h, "anthropic")
	resp := h.doChat(chatBody(chatBodyOptions{Extra: map[string]any{
		"tools":       json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`),
		"tool_choice": "required", "response_format": map[string]string{"type": "text"},
	}}), nil)
	_ = readAll(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("supported Anthropic tools rejected: %d", resp.StatusCode)
	}
	fields := <-wire
	var tools []struct {
		Name        string
		InputSchema json.RawMessage `json:"input_schema"`
	}
	var choice struct{ Type string }
	if json.Unmarshal(fields["tools"], &tools) != nil || len(tools) != 1 || tools[0].Name != "lookup" || len(tools[0].InputSchema) == 0 || json.Unmarshal(fields["tool_choice"], &choice) != nil || choice.Type != "any" {
		t.Fatal("supported Anthropic tool translation changed")
	}
}

func TestRequestCompatibilityUsesOnlyExistingEligibleCandidates(t *testing.T) {
	for _, compatibleEnabled := range []bool{true, false} {
		t.Run(map[bool]string{true: "compatible_route", false: "compatible_route_disabled"}[compatibleEnabled], func(t *testing.T) {
			var geminiCalls, openAICalls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/models/") {
					geminiCalls.Add(1)
				} else {
					openAICalls.Add(1)
				}
				adapterFixtureResponse(w, r)
			}})
			updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
				gemini := b.Channels[0]
				gemini.ID, gemini.Provider, gemini.ProviderID, gemini.Priority = "gemini-preferred", "gemini", "provider-gemini", -1
				b.Channels[0].Enabled = compatibleEnabled
				b.Channels = append(b.Channels, gemini)
				price := b.Snapshot.PriceVersions[0]
				price.Provider, price.ID = "gemini", "gemini-price"
				b.Snapshot.PriceVersions = append(b.Snapshot.PriceVersions, price)
			})
			resp := h.doChat(chatBody(chatBodyOptions{Extra: map[string]any{"tool_choice": "required"}}), nil)
			_ = readAll(resp)
			if geminiCalls.Load() != 0 {
				t.Error("preferred incompatible adapter silently changed the request")
			}
			if compatibleEnabled {
				if resp.StatusCode != http.StatusOK || openAICalls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 || len(h.store.Requests()[0].Attempts) != 1 || h.store.Requests()[0].Attempts[0].ChannelID != "chan_test_1" {
					t.Fatal("compatible initial selection did not retain execution attribution")
				}
			} else if resp.StatusCode != http.StatusBadRequest || openAICalls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
				t.Fatal("compatibility check bypassed existing channel authorization")
			}
		})
	}
}

func TestSafeConnectionFailureCannotSwitchToLossyAdapter(t *testing.T) {
	var geminiCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { geminiCalls.Add(1); adapterFixtureResponse(w, r) }))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{CredentialMode: "byok", MaxAttempts: 2})
	updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
		gemini := b.Channels[0]
		gemini.ID, gemini.Provider, gemini.ProviderID, gemini.Priority, gemini.BaseURL = "gemini-fallback", "gemini", "provider-gemini", 1, fallback.URL
		b.Channels = append(b.Channels, gemini)
		price := b.Snapshot.PriceVersions[0]
		price.Provider, price.ID = "gemini", "gemini-price"
		b.Snapshot.PriceVersions = append(b.Snapshot.PriceVersions, price)
	})
	primary, _ := url.Parse(h.upstream.URL)
	transport := &legacyFailPrimaryTransport{base: http.DefaultTransport, primaryHost: primary.Host}
	h.proxy.httpClient = &http.Client{Transport: transport}
	resp := h.doChat(chatBody(chatBodyOptions{Extra: map[string]any{"tool_choice": "required"}}), nil)
	_ = readAll(resp)
	if resp.StatusCode == http.StatusOK || transport.failed.Load() != 1 || geminiCalls.Load() != 0 || h.managed.reserveCount() != 0 {
		t.Fatal("connection failure selected an adapter that loses requested semantics")
	}
	if records := h.store.Requests(); len(records) != 1 || len(records[0].Attempts) != 1 || records[0].Attempts[0].ChannelID != "chan_test_1" {
		t.Fatal("filtered adapter entered execution history")
	}
}
