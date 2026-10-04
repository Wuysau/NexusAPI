package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestChatLegacyFunctionHistoryRejectsNonNullField(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"documented_call", map[string]any{"name": "private_function_history_lookup", "arguments": `{}`}},
		{"empty_object", map[string]any{}},
		{"array", []any{}},
		{"string", "private_function_history_call"},
		{"empty_string", ""},
		{"false", false},
		{"zero", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, apiErr := parseChatRequest(chatBody(chatBodyOptions{Messages: legacyFunctionHistoryMessages(tc.value)}), 8192)
			if req != nil || apiErr == nil {
				t.Fatal("non-null legacy function history was accepted and can be discarded")
			}
			if apiErr.Status != http.StatusBadRequest || apiErr.Code != CodeUnsupportedParam || apiErr.Type != TypeInvalidRequest || apiErr.Message != "Unsupported parameter." || apiErr.Param == nil || *apiErr.Param != "messages[1].function_call" {
				t.Error("legacy function history lost its static indexed unsupported-parameter error")
			}
		})
	}
}

func TestChatLegacyFunctionHistoryRejectedBeforeExecution(t *testing.T) {
	for _, mode := range []string{"managed", "byok"} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", mode, streaming), func(t *testing.T) {
				h, credentials, calls := newAudioHistoryHarness(t, mode, nil)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				headers := map[string]string{"Idempotency-Key": "legacy-function-then-corrected"}
				legacy := legacyFunctionHistoryMessages(map[string]any{"name": "private_function_history_lookup", "arguments": `{"city":"private_function_history_city"}`})
				response := h.doChat(chatBody(chatBodyOptions{Messages: legacy, Stream: streaming}), headers)
				assertLegacyFunctionHistoryError(t, response)
				assertAnthropicPreflightNoWork(t, h, credentials, calls)
				h.proxy.idempotency.mu.Lock()
				claims := len(h.proxy.idempotency.entries)
				h.proxy.idempotency.mu.Unlock()
				if h.byok.reserveCount() != 0 || claims != 0 {
					t.Error("rejected legacy history reached reservation or retained idempotency ownership")
				}
				assertNativeHistoryHealth(t, h, "chan_test_1")
				if strings.Contains(logs.String(), "private_function_history") {
					t.Error("rejected function history entered logs")
				}
				if t.Failed() {
					return
				}
				corrected := chatBody(chatBodyOptions{Messages: legacyFunctionModernMessages(), Stream: streaming})
				assertNativeHistoryCompleted(t, h, credentials, calls, h.doChat(corrected, headers), true, mode == "byok", "chan_test_1")
				duplicate := h.doChat(corrected, headers)
				body := readAll(duplicate)
				if duplicate.StatusCode != http.StatusConflict || !strings.Contains(body, CodeIdempotencyConflict) || calls.Load() != 1 || credentials.calls.Load() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
					t.Error("corrected modern history did not execute exactly once with the same idempotency key")
				}
				facts, err := json.Marshal(h.store.Requests())
				if err != nil || strings.Contains(string(facts), "private_function_history") || strings.Contains(logs.String(), "private_function_history") {
					t.Error("function history entered terminal facts or logs")
				}
			})
		}
	}
}

func TestChatLegacyFunctionHistoryRejectedBeforeAuthentication(t *testing.T) {
	h, credentials, calls := newAudioHistoryHarness(t, "managed", nil)
	headers := map[string]string{"Authorization": ""}
	legacy := legacyFunctionHistoryMessages(map[string]any{"name": "private_function_history_lookup", "arguments": `{}`})
	assertLegacyFunctionHistoryError(t, h.doChat(chatBody(chatBodyOptions{Messages: legacy, Stream: true}), headers))
	assertAnthropicPreflightNoWork(t, h, credentials, calls)
	corrected := h.doChat(chatBody(chatBodyOptions{Messages: legacyFunctionModernMessages()}), headers)
	body := readAll(corrected)
	if corrected.StatusCode != http.StatusUnauthorized || !strings.Contains(body, CodeInvalidAPIKey) {
		t.Error("modern history no longer requires authentication")
	}
	assertAnthropicPreflightNoWork(t, h, credentials, calls)
}

func TestChatLegacyFunctionHistoryAbsentAndNullPreserveModernWire(t *testing.T) {
	// Deprecated assistant function_call remains a documented optional object
	// or null. Modern tool_calls and Responses function-call items are distinct.
	// https://developers.openai.com/api/reference/resources/chat
	for _, withNull := range []bool{false, true} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("null=%t/stream=%t", withNull, streaming), func(t *testing.T) {
				messages := legacyFunctionModernMessages()
				raw, _ := json.Marshal(messages)
				var expected []map[string]any
				if err := json.Unmarshal(raw, &expected); err != nil {
					t.Fatal(err)
				}
				if withNull {
					messages[1]["function_call"] = nil
				}
				wire := make(chan []map[string]any, 1)
				h, credentials, calls := newAudioHistoryHarness(t, "managed", wire)
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), nil)
				assertNativeHistoryCompleted(t, h, credentials, calls, response, true, false, "chan_test_1")
				select {
				case actual := <-wire:
					if !reflect.DeepEqual(actual, expected) {
						t.Error("legacy envelope guard changed the modern function-call history")
					}
				default:
					t.Fatal("accepted modern history did not reach the actual upstream fixture")
				}
			})
		}
	}
}

func legacyFunctionHistoryMessages(call any) []map[string]any {
	return []map[string]any{
		{"role": "user", "content": "private_function_history_prompt"},
		{"role": "assistant", "content": nil, "function_call": call},
		{"role": "user", "content": "explain the preceding call"},
	}
}

func assertLegacyFunctionHistoryError(t *testing.T, response *http.Response) {
	t.Helper()
	body := readAll(response)
	var envelope errorEnvelope
	if json.Unmarshal([]byte(body), &envelope) != nil {
		t.Error("legacy function preflight started a stream instead of returning a JSON error")
	}
	if response.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Type != TypeInvalidRequest || envelope.Error.Message != "Unsupported parameter." || envelope.Error.Param == nil || *envelope.Error.Param != "messages[1].function_call" {
		t.Errorf("legacy history lost its static indexed rejection: status=%d code=%s", response.StatusCode, envelope.Error.Code)
	}
	if strings.Contains(body, "private_function_history") || strings.Contains(body, "[DONE]") {
		t.Error("legacy function preflight leaked history or certified a successful stream")
	}
}

func legacyFunctionModernMessages() []map[string]any {
	return []map[string]any{
		{"role": "user", "content": "private_function_history_prompt"},
		{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": "call_function_history", "type": "function", "function": map[string]any{"name": "private_function_history_lookup", "arguments": `{"city":"private_function_history_city"}`}}}},
		{"role": "tool", "tool_call_id": "call_function_history", "content": "private_function_history_result"},
	}
}
