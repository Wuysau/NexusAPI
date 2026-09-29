package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"
)

func TestRefusalHistoryCompatibleHTTPPreservesExplicitValues(t *testing.T) {
	for _, code := range []string{"openai", "deepseek", "ollama", "custom-compatible"} {
		for _, stream := range []bool{false, true} {
			t.Run(code+"/stream="+strconv.FormatBool(stream), func(t *testing.T) {
				var calls atomic.Int32
				wire := make(chan []map[string]any, 1)
				h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body struct {
						Messages []map[string]any `json:"messages"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					select {
					case wire <- body.Messages:
					default:
						t.Error("history request unexpectedly replayed")
					}
					defaultUpstreamHandler()(w, r)
				}})
				setValidationProvider(t, h, code)
				updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) { b.Channels[0].Protocol = "openai" })
				messages := []map[string]any{
					{"role": "assistant", "content": nil, "name": "fixture-assistant", "refusal": "I cannot comply.\n无法提供。"},
					{"role": "assistant", "content": "safe alternative", "refusal": ""},
					{"role": "assistant", "content": "ordinary history"},
					{"role": "assistant", "content": "nullable history", "refusal": nil},
					{"role": "assistant", "refusal": "refusal without ordinary content"},
					{"role": "assistant", "refusal": ""},
					{"role": "user", "content": "continue"},
				}
				response := h.doChat(chatBody(chatBodyOptions{Stream: stream, Messages: messages}), nil)
				_ = readAll(response)
				if response.StatusCode != http.StatusOK || calls.Load() != 1 {
					t.Fatalf("refusal history did not execute once: status=%d calls=%d", response.StatusCode, calls.Load())
				}
				delete(messages[3], "refusal")
				select {
				case got := <-wire:
					if !reflect.DeepEqual(got, messages) {
						t.Fatalf("caller refusal history changed before reaching compatible provider\ngot: %#v\nwant: %#v", got, messages)
					}
				default:
					t.Fatal("upstream received no history")
				}
			})
		}
	}
}

func TestRefusalHistoryMissingContentRequiresExplicitAssistantRefusal(t *testing.T) {
	for _, tc := range []struct {
		name    string
		message map[string]any
	}{
		{"user", map[string]any{"role": "user", "refusal": "refusal"}},
		{"system", map[string]any{"role": "system", "refusal": "refusal"}},
		{"developer", map[string]any{"role": "developer", "refusal": "refusal"}},
		{"tool", map[string]any{"role": "tool", "refusal": "refusal", "tool_call_id": "call_fixture"}},
		{"assistant_null", map[string]any{"role": "assistant", "refusal": nil}},
		{"assistant_missing", map[string]any{"role": "assistant"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			response := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{tc.message}}), nil)
			var envelope errorEnvelope
			if err := json.Unmarshal([]byte(readAll(response)), &envelope); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusBadRequest || envelope.Error.Param == nil || *envelope.Error.Param != "messages[0].content" {
				t.Fatalf("refusal bypassed the ordinary content requirement: status=%d param=%v", response.StatusCode, envelope.Error.Param)
			}
			if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
				t.Fatal("invalid missing-content message crossed execution")
			}
		})
	}
}

func TestRefusalHistoryNativeHTTPRejectsBeforeExecution(t *testing.T) {
	for _, code := range []string{"anthropic", "gemini"} {
		for _, refusal := range []string{"", "private_refusal_marker"} {
			t.Run(code+"/empty="+strconv.FormatBool(refusal == ""), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, code)
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				messages := []map[string]any{{"role": "assistant", "content": "safe alternative", "refusal": refusal}, {"role": "user", "content": "continue"}}
				headers := map[string]string{"Idempotency-Key": "refusal-history-before-execution"}
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages}), headers)
				var envelope errorEnvelope
				if err := json.Unmarshal([]byte(readAll(response)), &envelope); err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Param == nil || *envelope.Error.Param != "messages" {
					t.Fatalf("unsupported refusal history was silently dropped: status=%d code=%s", response.StatusCode, envelope.Error.Code)
				}
				if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
					t.Fatal("unsupported refusal history crossed credentials, reservation, or execution")
				}
				// Null retains the native request contract and can reuse the key.
				messages[0]["refusal"] = nil
				corrected := h.doChat(chatBody(chatBodyOptions{Messages: messages}), headers)
				_ = readAll(corrected)
				if corrected.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 1 {
					t.Fatal("null refusal could not reuse the undispatched idempotency key")
				}
			})
		}
	}
}

func TestRefusalHistoryInvalidHTTPTypesDoNotExecute(t *testing.T) {
	for _, value := range []any{17, true, map[string]string{"text": "private_refusal_marker"}, []string{"private_refusal_marker"}} {
		t.Run(reflect.TypeOf(value).String(), func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			response := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "assistant", "content": "safe alternative", "refusal": value}}}), nil)
			_ = readAll(response)
			if response.StatusCode != http.StatusBadRequest || calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Fatalf("invalid refusal type %T crossed execution: status=%d", value, response.StatusCode)
			}
		})
	}
}
