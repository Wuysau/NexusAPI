package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func assertAnthropicPreflightError(t *testing.T, response *http.Response, param string) {
	t.Helper()
	body := readAll(response)
	var envelope errorEnvelope
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	gotParam := ""
	if envelope.Error.Param != nil {
		gotParam = *envelope.Error.Param
	}
	if response.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Param == nil || *envelope.Error.Param != param || envelope.Error.Message != "Unsupported parameter." || strings.Contains(body, "private_") {
		t.Errorf("local translation failure must return static unsupported %s: status=%d code=%s param=%s", param, response.StatusCode, envelope.Error.Code, gotParam)
	}
}

func assertAnthropicPreflightNoWork(t *testing.T, h *testHarness, credentials *countedValidationCredentials, calls *atomic.Int32) {
	t.Helper()
	h.store.mu.Lock()
	attemptCaptures, legacyClaims := len(h.store.capturedAttempts), len(h.store.legacyClaims)
	h.store.mu.Unlock()
	if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.CapturedRequests()) != 0 || attemptCaptures != 0 || legacyClaims != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
		t.Errorf("local translation failure crossed execution: upstream=%d credentials=%d reserve=%d requestCapture=%d attemptCapture=%d legacyClaim=%d terminal=%d outbox=%d", calls.Load(), credentials.calls.Load(), h.managed.reserveCount(), len(h.store.CapturedRequests()), attemptCaptures, legacyClaims, len(h.store.Requests()), h.store.OutboxCount(testTenantID))
	}
}

func TestAnthropicToolPreflightRejectsBeforeCredentialsAndBudget(t *testing.T) {
	for _, tc := range []struct {
		name, param string
		extra       map[string]any
		messages    []map[string]any
	}{
		{"tools_object", "tools", map[string]any{"tools": map[string]any{"type": "function"}}, nil},
		{"tool_kind", "tools", map[string]any{"tools": json.RawMessage(`[{"type":"custom","custom":{"name":"private_lookup"}}]`)}, nil},
		{"tool_missing_name", "tools", map[string]any{"tools": json.RawMessage(`[{"type":"function","function":{"parameters":{"type":"object"}}}]`)}, nil},
		{"tool_strict_type", "tools", map[string]any{"tools": json.RawMessage(`[{"type":"function","function":{"name":"private_lookup","strict":"yes"}}]`)}, nil},
		{"choice_string", "tool_choice", map[string]any{"tool_choice": "private_invalid_choice"}, nil},
		{"choice_object", "tool_choice", map[string]any{"tool_choice": map[string]any{"type": "function"}}, nil},
		{"result_missing_id", "messages", nil, []map[string]any{{"role": "tool", "content": "private_result"}}},
		{"calls_wrong_role", "messages", nil, []map[string]any{{"role": "user", "content": "hello", "tool_calls": json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]`)}}},
		{"arguments_invalid_json", "messages", nil, []map[string]any{{"role": "assistant", "content": nil, "tool_calls": json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"private_{"}}]`)}}},
		{"arguments_array", "messages", nil, []map[string]any{{"role": "assistant", "content": nil, "tool_calls": json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"[]"}}]`)}}},
		{"system_only", "messages", nil, []map[string]any{{"role": "system", "content": "private_instruction"}}},
	} {
		for _, v2 := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/v2=%t", tc.name, v2), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: v2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, "anthropic")
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				headers := map[string]string{"Idempotency-Key": "anthropic-preflight-then-corrected"}
				response := h.doChat(chatBody(chatBodyOptions{Extra: tc.extra, Messages: tc.messages}), headers)
				assertAnthropicPreflightError(t, response, tc.param)
				assertAnthropicPreflightNoWork(t, h, credentials, &calls)
				if h.breaker.State(BreakerKey("chan_test_1", testModel)) != BreakerClosed || h.breaker.FailureRate(BreakerKey("chan_test_1", testModel)) != 0 {
					t.Error("caller translation failure changed upstream health")
				}
				corrected := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "system", "content": "instruction"}, {"role": "user", "content": "corrected request"}}}), headers)
				_ = readAll(corrected)
				records := h.store.Requests()
				if corrected.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 1 || len(records) != 1 || h.store.OutboxCount(testTenantID) != 1 {
					t.Fatalf("corrected undispatched request did not execute once: status=%d calls=%d reserve=%d terminal=%d", corrected.StatusCode, calls.Load(), h.managed.reserveCount(), len(records))
				}
				if records[0].Status != string(OutcomeCompleted) || len(records[0].Attempts) != 1 || (v2 && records[0].EventV2 == nil) {
					t.Fatal("corrected request lost its normal attributed completion")
				}
			})
		}
	}
}

func TestAnthropicToolPreflightBYOKRejectsBeforeDurableClaim(t *testing.T) {
	for _, v2 := range []bool{false, true} {
		t.Run(fmt.Sprintf("v2=%t", v2), func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				adapterFixtureResponse(w, r)
			}})
			setValidationProvider(t, h, "anthropic")
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			headers := map[string]string{"Idempotency-Key": "byok-invalid-then-corrected"}
			response := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "tool", "content": "private_result"}}}), headers)
			assertAnthropicPreflightError(t, response, "messages")
			assertAnthropicPreflightNoWork(t, h, credentials, &calls)
			corrected := h.doChat(chatBody(chatBodyOptions{}), headers)
			_ = readAll(corrected)
			if corrected.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("BYOK rejection prevented one valid execution or created a managed hold")
			}
			if v2 && len(h.store.CapturedRequests()) != 1 {
				t.Fatal("valid BYOK execution lost its frozen identity")
			}
		})
	}
}

func TestResponsesAnthropicToolPreflightRejectsBeforeExecution(t *testing.T) {
	for _, tc := range []struct{ name, param, body string }{
		{"strict_type", "tools", `{"model":"gpt-4o","input":"hi","tools":[{"type":"function","name":"private_lookup","strict":"yes"}]}`},
		{"arguments_array", "messages", `{"model":"gpt-4o","input":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"[]"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				adapterFixtureResponse(w, r)
			}})
			setValidationProvider(t, h, "anthropic")
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
			t.Cleanup(server.Close)
			send := func(body string) *http.Response {
				req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+testAPIKey)
				req.Header.Set("Idempotency-Key", "responses-tool-preflight")
				response, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				return response
			}
			assertAnthropicPreflightError(t, send(tc.body), tc.param)
			assertAnthropicPreflightNoWork(t, h, credentials, &calls)
			corrected := send(`{"model":"gpt-4o","input":"corrected request"}`)
			body := readAll(corrected)
			if corrected.StatusCode != http.StatusOK || !strings.Contains(body, "Hello") || calls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("corrected Responses request did not execute exactly once")
			}
		})
	}
}

func TestAnthropicToolPreflightUsesOnlyAuthorizedCompatibleCandidates(t *testing.T) {
	tools := json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`)
	choice := json.RawMessage(`{"type":"allowed_tools","allowed_tools":{"mode":"auto","tools":[{"type":"function","function":{"name":"lookup"}}]}}`)
	for _, compatibleEnabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("compatible_enabled=%t", compatibleEnabled), func(t *testing.T) {
			var nativeCalls, compatibleCalls atomic.Int32
			h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/messages") {
					nativeCalls.Add(1)
				} else {
					compatibleCalls.Add(1)
					var fields map[string]json.RawMessage
					if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
						t.Error(err)
					}
					for _, pair := range [][2]json.RawMessage{{fields["tools"], tools}, {fields["tool_choice"], choice}} {
						var actual, expected any
						if json.Unmarshal(pair[0], &actual) != nil || json.Unmarshal(pair[1], &expected) != nil || !reflect.DeepEqual(actual, expected) {
							t.Error("compatible candidate changed caller tool requirements")
						}
					}
				}
				adapterFixtureResponse(w, r)
			}})
			updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
				anthropic := b.Channels[0]
				anthropic.ID, anthropic.Provider, anthropic.ProviderID, anthropic.Priority = "anthropic-preferred", "anthropic", "provider-anthropic", -1
				b.Channels[0].Enabled = compatibleEnabled
				b.Channels = append(b.Channels, anthropic)
				price := b.Snapshot.PriceVersions[0]
				price.Provider, price.ID = "anthropic", "anthropic-price"
				b.Snapshot.PriceVersions = append(b.Snapshot.PriceVersions, price)
			})
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			response := h.doChat(chatBody(chatBodyOptions{Extra: map[string]any{"tools": tools, "tool_choice": choice}}), nil)
			if !compatibleEnabled {
				assertAnthropicPreflightError(t, response, "tool_choice")
				assertAnthropicPreflightNoWork(t, h, credentials, &compatibleCalls)
			} else {
				_ = readAll(response)
				records := h.store.Requests()
				if response.StatusCode != http.StatusOK || compatibleCalls.Load() != 1 || h.managed.reserveCount() != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || records[0].Attempts[0].ChannelID != "chan_test_1" || h.store.OutboxCount(testTenantID) != 1 {
					t.Errorf("initial compatible selection failed: status=%d compatible=%d reserve=%d terminal=%d", response.StatusCode, compatibleCalls.Load(), h.managed.reserveCount(), len(records))
				}
			}
			if nativeCalls.Load() != 0 {
				t.Error("incompatible preferred adapter was executed")
			}
		})
	}
}
