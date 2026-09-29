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

func nativeHistorySender(t *testing.T, h *testHarness, responses bool, idempotencyKey string) func([]map[string]any, bool) *http.Response {
	t.Helper()
	if !responses {
		return func(messages []map[string]any, stream bool) *http.Response {
			return h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: stream}), map[string]string{"Idempotency-Key": idempotencyKey})
		}
	}
	server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
	t.Cleanup(server.Close)
	return func(messages []map[string]any, stream bool) *http.Response {
		raw, err := json.Marshal(map[string]any{"model": testModel, "input": messages, "stream": stream})
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(string(raw)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+testAPIKey)
		request.Header.Set("Idempotency-Key", idempotencyKey)
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
}

func assertNativeHistoryHealth(t *testing.T, h *testHarness, channels ...string) {
	t.Helper()
	for _, channel := range channels {
		key := BreakerKey(channel, testModel)
		if h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 {
			t.Errorf("request compatibility changed health for channel %s", channel)
		}
	}
}

func assertNativeHistoryRejected(t *testing.T, h *testHarness, credentials *countedValidationCredentials, calls *atomic.Int32, response *http.Response, channels ...string) {
	t.Helper()
	assertAnthropicPreflightError(t, response, "messages")
	assertAnthropicPreflightNoWork(t, h, credentials, calls)
	if h.byok.reserveCount() != 0 {
		t.Error("rejected history reached BYOK reservation")
	}
	assertNativeHistoryHealth(t, h, channels...)
}

func assertNativeHistoryCompleted(t *testing.T, h *testHarness, credentials *countedValidationCredentials, calls *atomic.Int32, response *http.Response, v2, byok bool, channel string) {
	t.Helper()
	body := readAll(response)
	wantReservations := 1
	if byok {
		wantReservations = 0
	}
	records := h.store.Requests()
	if response.StatusCode != http.StatusOK || !strings.Contains(body, "Hello") || calls.Load() != 1 || credentials.calls.Load() != 1 || h.managed.reserveCount() != wantReservations || len(records) != 1 || h.store.OutboxCount(testTenantID) != 1 {
		t.Fatalf("valid history did not execute once: status=%d upstream=%d credentials=%d reserve=%d terminal=%d outbox=%d", response.StatusCode, calls.Load(), credentials.calls.Load(), h.managed.reserveCount(), len(records), h.store.OutboxCount(testTenantID))
	}
	if records[0].Status != string(OutcomeCompleted) || len(records[0].Attempts) != 1 || records[0].Attempts[0].ChannelID != channel {
		t.Fatal("valid history lost its completed attempt attribution")
	}
	if v2 {
		if records[0].EventV2 == nil {
			t.Fatal("valid history lost its v2 terminal event")
		}
		if byok {
			if len(h.store.CapturedRequests()) != 1 {
				t.Fatal("valid BYOK history lost its frozen request identity")
			}
		} else {
			reservations := h.managed.reserveRequests()
			if len(reservations) != 1 || reservations[0].AttributionContext == nil || reservations[0].AttributionContext.APIKeyID != testKeyID {
				t.Fatal("valid managed history lost its frozen reservation identity")
			}
		}
	}
	assertNativeHistoryHealth(t, h, channel)
}

func TestNativeNamedHistoryPreflightBeforeExecution(t *testing.T) {
	for _, adapter := range []string{"anthropic", "gemini"} {
		for _, v2 := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/v2=%t", adapter, v2), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: v2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, adapter)
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				send := nativeHistorySender(t, h, false, "named-history-then-corrected")
				messages := []map[string]any{
					{"role": "user", "name": "private_alice", "content": "I prefer tea."},
					{"role": "user", "name": "private_bob", "content": "I prefer coffee."},
				}
				assertNativeHistoryRejected(t, h, credentials, &calls, send(messages, v2), "chan_test_1")
				for _, message := range messages {
					delete(message, "name")
				}
				assertNativeHistoryCompleted(t, h, credentials, &calls, send(messages, v2), v2, false, "chan_test_1")
			})
		}
	}
}

func TestGeminiConversationPreflightChatAndResponses(t *testing.T) {
	for _, responses := range []bool{false, true} {
		for _, v2 := range []bool{false, true} {
			t.Run(fmt.Sprintf("responses=%t/v2=%t", responses, v2), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: v2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, "gemini")
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				send := nativeHistorySender(t, h, responses, "conversation-history-then-corrected")
				messages := []map[string]any{
					{"role": "system", "content": "private_instruction"},
					{"role": "developer", "content": "private_developer_instruction"},
				}
				assertNativeHistoryRejected(t, h, credentials, &calls, send(messages, v2), "chan_test_1")
				messages = append(messages, map[string]any{"role": "user", "content": "hello"})
				assertNativeHistoryCompleted(t, h, credentials, &calls, send(messages, v2), v2, false, "chan_test_1")
			})
		}
	}
}

func TestNativeHistoryPreflightBYOKPreservesIdempotency(t *testing.T) {
	for _, tc := range []struct {
		name, adapter string
		v2, responses bool
		messages      []map[string]any
	}{
		{"named_anthropic_v1", "anthropic", false, false, []map[string]any{{"role": "user", "name": "private_alice", "content": "hello"}}},
		{"system_only_gemini_responses_v2", "gemini", true, true, []map[string]any{{"role": "system", "content": "private_instruction"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{EnableUsageV2: tc.v2, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				adapterFixtureResponse(w, r)
			}})
			setValidationProvider(t, h, tc.adapter)
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			send := nativeHistorySender(t, h, tc.responses, "byok-history-then-corrected")
			assertNativeHistoryRejected(t, h, credentials, &calls, send(tc.messages, tc.v2), "chan_test_1")
			corrected := []map[string]any{{"role": "user", "content": "hello"}}
			assertNativeHistoryCompleted(t, h, credentials, &calls, send(corrected, tc.v2), tc.v2, true, "chan_test_1")
		})
	}
}

func TestNamedHistoryUsesOnlyEligibleCompatibleCandidates(t *testing.T) {
	for _, adapter := range []string{"anthropic", "gemini"} {
		for _, enabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/compatible_enabled=%t", adapter, enabled), func(t *testing.T) {
				messages := []map[string]any{
					{"role": "user", "name": "private_alice", "content": "I prefer tea."},
					{"role": "user", "name": "private_bob", "content": "I prefer coffee."},
				}
				var nativeCalls, compatibleCalls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					if strings.HasSuffix(r.URL.Path, "/messages") || strings.Contains(r.URL.Path, "/models/") {
						nativeCalls.Add(1)
					} else {
						compatibleCalls.Add(1)
						var body struct {
							Messages []map[string]any `json:"messages"`
						}
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !reflect.DeepEqual(body.Messages, messages) {
							t.Errorf("compatible candidate changed named participants: got=%#v err=%v", body.Messages, err)
						}
					}
					adapterFixtureResponse(w, r)
				}})
				nativeID := adapter + "-preferred"
				updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
					native := b.Channels[0]
					native.ID, native.Provider, native.ProviderID, native.Priority = nativeID, adapter, "provider-"+adapter, -1
					b.Channels[0].Enabled = enabled
					b.Channels = append(b.Channels, native)
					price := b.Snapshot.PriceVersions[0]
					price.Provider, price.ID = adapter, adapter+"-price"
					b.Snapshot.PriceVersions = append(b.Snapshot.PriceVersions, price)
				})
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages}), nil)
				if enabled {
					assertNativeHistoryCompleted(t, h, credentials, &compatibleCalls, response, true, false, "chan_test_1")
				} else {
					assertNativeHistoryRejected(t, h, credentials, &compatibleCalls, response, nativeID, "chan_test_1")
				}
				if nativeCalls.Load() != 0 {
					t.Errorf("incompatible native adapter executed %d times", nativeCalls.Load())
				}
				assertNativeHistoryHealth(t, h, nativeID, "chan_test_1")
			})
		}
	}
}
