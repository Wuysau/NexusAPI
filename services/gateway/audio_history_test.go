package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestChatAudioHistoryRejectsNonNullField(t *testing.T) {
	for _, tc := range []struct {
		name, role string
		audio      any
	}{
		{"assistant_reference", "assistant", map[string]any{"id": "private_audio_history_id"}},
		{"empty_object", "assistant", map[string]any{}},
		{"empty_array", "assistant", []any{}},
		{"array_reference", "assistant", []any{map[string]any{"id": "private_audio_history_id"}}},
		{"string", "assistant", "private_audio_history_id"},
		{"empty_string", "assistant", ""},
		{"false", "assistant", false},
		{"zero", "assistant", 0},
		{"null_id", "assistant", map[string]any{"id": nil}},
		{"user_envelope", "user", map[string]any{"id": "private_audio_history_id"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			messages := audioHistoryMessages(tc.audio)
			messages[1]["role"] = tc.role
			req, apiErr := parseChatRequest(chatBody(chatBodyOptions{Messages: messages}), 8192)
			if req != nil || apiErr == nil {
				t.Fatal("non-null message audio was accepted and can be silently discarded")
			}
			if apiErr.Status != http.StatusBadRequest || apiErr.Code != CodeUnsupportedParam || apiErr.Type != TypeInvalidRequest || apiErr.Message != "Unsupported parameter." || apiErr.Param == nil || *apiErr.Param != "messages[1].audio" {
				t.Error("unsupported message audio did not retain a static error and indexed field path")
			}
		})
	}
}

func TestChatAudioHistoryRejectedBeforeExecution(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		audio      any
	}{
		{"managed_reference", "managed", map[string]any{"id": "private_audio_history_id"}},
		{"byok_malformed", "byok", false},
	} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, streaming), func(t *testing.T) {
				h, credentials, calls := newAudioHistoryHarness(t, tc.mode, nil)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				messages := audioHistoryMessages(tc.audio)
				headers := map[string]string{"Idempotency-Key": "audio-history-then-corrected"}
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), headers)
				body := assertAudioHistoryRejected(t, h, credentials, calls, response)
				assertAudioHistoryPrivacy(t, h, body, logs.String())
				if t.Failed() {
					return
				}

				delete(messages[1], "audio")
				corrected := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), headers)
				assertNativeHistoryCompleted(t, h, credentials, calls, corrected, true, tc.mode == "byok", "chan_test_1")
				duplicate := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), headers)
				duplicateBody := readAll(duplicate)
				if duplicate.StatusCode != http.StatusConflict || !strings.Contains(duplicateBody, CodeIdempotencyConflict) || calls.Load() != 1 || credentials.calls.Load() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
					t.Error("corrected request did not retain sole execution ownership of its idempotency key")
				}
				assertAudioHistoryPrivacy(t, h, duplicateBody, logs.String())
			})
		}
	}
}

func TestChatAudioHistoryRejectedBeforeAuthentication(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%t", streaming), func(t *testing.T) {
			h, credentials, calls := newAudioHistoryHarness(t, "managed", nil)
			messages := audioHistoryMessages(map[string]any{"id": "private_audio_history_id"})
			headers := map[string]string{"Authorization": "", "Idempotency-Key": "audio-without-authentication"}
			response := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), headers)
			assertAudioHistoryRejected(t, h, credentials, calls, response)
			if t.Failed() {
				return
			}
			delete(messages[1], "audio")
			corrected := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), headers)
			body := readAll(corrected)
			if corrected.StatusCode != http.StatusUnauthorized || !strings.Contains(body, CodeInvalidAPIKey) {
				t.Error("ordinary request bypassed authentication after audio preflight")
			}
			assertAnthropicPreflightNoWork(t, h, credentials, calls)
		})
	}
}

func TestChatAudioHistoryAbsentAndNullPreserveCompatibleHistory(t *testing.T) {
	// The assistant audio envelope is optional {id}|null. Input audio content
	// is a separate raw content part and must retain its existing pass-through.
	// https://developers.openai.com/api/reference/resources/chat
	for _, withNull := range []bool{false, true} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("null=%t/stream=%t", withNull, streaming), func(t *testing.T) {
				messages := audioHistoryCompatibleMessages()
				expectedJSON, err := json.Marshal(messages)
				if err != nil {
					t.Fatal(err)
				}
				var expected []map[string]any
				if err := json.Unmarshal(expectedJSON, &expected); err != nil {
					t.Fatal(err)
				}
				if withNull {
					messages[1]["audio"] = nil
				}
				wire := make(chan []map[string]any, 1)
				h, credentials, calls := newAudioHistoryHarness(t, "managed", wire)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages, Stream: streaming}), nil)
				assertNativeHistoryCompleted(t, h, credentials, calls, response, true, false, "chan_test_1")
				select {
				case actual := <-wire:
					if !reflect.DeepEqual(actual, expected) {
						t.Error("audio guard changed raw input audio/image content, refusal, reasoning or tool history")
					}
				default:
					t.Fatal("accepted compatible history did not reach the actual upstream fixture")
				}
				assertAudioHistoryPrivacy(t, h, "", logs.String())
			})
		}
	}
}

func audioHistoryMessages(audio any) []map[string]any {
	return []map[string]any{
		{"role": "user", "content": "private_audio_history_prompt"},
		{"role": "assistant", "content": "private_audio_history_previous", "audio": audio},
		{"role": "user", "content": "continue"},
	}
}

func audioHistoryCompatibleMessages() []map[string]any {
	return []map[string]any{
		{"role": "user", "content": "private_audio_history_prompt"},
		{"role": "assistant", "content": "private_audio_history_previous", "reasoning_content": ""},
		{"role": "assistant", "content": nil, "refusal": "private_audio_history_refusal"},
		{"role": "assistant", "content": nil, "reasoning_content": "private_audio_history_reasoning", "tool_calls": []any{map[string]any{"id": "call_audio_history", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{}`}}}},
		{"role": "tool", "tool_call_id": "call_audio_history", "content": "private_audio_history_result"},
		{"role": "user", "content": []any{
			map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": "cHJpdmF0ZV9hdWRpb19oaXN0b3J5X2RhdGE=", "format": "wav"}},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/private_audio_history_image"}},
			map[string]any{"type": "text", "text": "continue"},
		}},
	}
}

func newAudioHistoryHarness(t *testing.T, mode string, wire chan<- []map[string]any) (*testHarness, *countedValidationCredentials, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: mode, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error("upstream could not decode the synthetic conversation")
		}
		if wire != nil {
			wire <- body.Messages
		}
		defaultUpstreamHandler()(w, r)
	}})
	credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
	h.proxy.credentials = credentials
	return h, credentials, &calls
}

func assertAudioHistoryRejected(t *testing.T, h *testHarness, credentials *countedValidationCredentials, calls *atomic.Int32, response *http.Response) string {
	t.Helper()
	body := readAll(response)
	var envelope errorEnvelope
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Error("audio preflight did not return the JSON error contract")
	}
	if response.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Type != TypeInvalidRequest || envelope.Error.Message != "Unsupported parameter." || envelope.Error.Param == nil || *envelope.Error.Param != "messages[1].audio" {
		t.Errorf("message audio was not rejected precisely: status=%d code=%s", response.StatusCode, envelope.Error.Code)
	}
	if envelope.Error.RequestID == "" || envelope.Error.RequestID != response.Header.Get("x-request-id") || strings.Contains(body, "private_audio_history") || strings.Contains(body, "data:") || strings.Contains(body, "[DONE]") {
		t.Error("audio preflight lost Gateway identity, exposed private content, or started SSE")
	}
	assertAnthropicPreflightNoWork(t, h, credentials, calls)
	if h.byok.reserveCount() != 0 {
		t.Error("audio preflight reached the BYOK reservation boundary")
	}
	h.proxy.idempotency.mu.Lock()
	claims := len(h.proxy.idempotency.entries)
	h.proxy.idempotency.mu.Unlock()
	if claims != 0 {
		t.Error("rejected audio history retained an idempotency claim")
	}
	assertNativeHistoryHealth(t, h, "chan_test_1")
	return body
}

func assertAudioHistoryPrivacy(t *testing.T, h *testHarness, body, logs string) {
	t.Helper()
	facts, err := json.Marshal(struct {
		Captured []*FrozenRequest
		Terminal []*TerminalRecord
	}{h.store.CapturedRequests(), h.store.Requests()})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private_audio_history", "cHJpdmF0ZV9hdWRpb19oaXN0b3J5X2RhdGE=", testAPIKey, "upstream-test-secret"} {
		if bytes.Contains(facts, []byte(private)) || strings.Contains(body, private) || strings.Contains(logs, private) {
			t.Error("audio/history content or credentials entered the public error, facts, or logs")
		}
	}
}
