package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestChatReasoningHistoryToolRoundTrip(t *testing.T) {
	const marker = "private-reasoning-history-42f7"
	for _, code := range []string{"deepseek", "custom-compatible"} {
		for _, streaming := range []bool{false, true} {
			t.Run(code+"/"+fmtBool(streaming), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					var body struct {
						Messages []map[string]json.RawMessage `json:"messages"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if calls.Add(1) == 1 {
						w.Header().Set("Content-Type", "text/event-stream")
						_, _ = io.WriteString(w, "data: "+`{"choices":[{"index":0,"delta":{"reasoning_content":"`+marker+`"},"finish_reason":null}]}`+"\n\n")
						_, _ = io.WriteString(w, "data: "+`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
						return
					}
					if len(body.Messages) != 3 || string(body.Messages[1]["reasoning_content"]) != `"`+marker+`"` || len(body.Messages[1]["reasoning"]) != 0 || string(body.Messages[2]["tool_call_id"]) != `"call_fixture"` {
						w.WriteHeader(http.StatusBadRequest)
						_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","message":"Missing history."}}`)
						return
					}
					defaultUpstreamHandler()(w, r)
				}})
				setValidationProvider(t, h, code)
				updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) { b.Channels[0].Protocol = "openai" })
				var logs bytes.Buffer
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				extra := map[string]any{"tools": json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`)}
				first := h.doChat(chatBody(chatBodyOptions{Extra: extra}), nil)
				if first.StatusCode != http.StatusOK {
					t.Fatal("first tool call failed")
				}
				response := decodeJSON(t, first)
				message := response["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
				if message["reasoning_content"] != marker {
					t.Fatal("fixture did not expose reasoning for the caller's next turn")
				}
				second := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Extra: extra, Messages: []map[string]any{
					{"role": "user", "content": "hi"}, message, {"role": "tool", "tool_call_id": "call_fixture", "content": "ok"},
				}}), nil)
				output := readAll(second)
				if second.StatusCode != http.StatusOK || !strings.Contains(output, "Hello") || calls.Load() != 2 {
					t.Fatalf("returned assistant history did not survive the next request: status=%d calls=%d", second.StatusCode, calls.Load())
				}
				records := h.store.Requests()
				if len(records) != 2 || h.store.OutboxCount(testTenantID) != 2 || h.managed.reserveCount() != 2 {
					t.Fatal("tool turns lost execution/accounting cardinality")
				}
				for _, record := range records {
					if record.Status != string(OutcomeCompleted) || len(record.Attempts) != 1 || record.EventV2 == nil {
						t.Fatal("tool turn did not retain one attributed completed execution")
					}
				}
				persisted, _ := json.Marshal(records)
				if bytes.Contains(persisted, []byte(marker)) || strings.Contains(logs.String(), marker) {
					t.Fatal("history content escaped into execution facts or logs")
				}
			})
		}
	}
}

func TestNativeReasoningHistoryRejectedBeforeExecution(t *testing.T) {
	for _, code := range []string{"anthropic", "gemini"} {
		for _, history := range []string{"", "private-history-marker"} {
			t.Run(code+"/empty="+strconv.FormatBool(history == ""), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, code)
				credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
				h.proxy.credentials = credentials
				messages := []map[string]any{{"role": "assistant", "content": "previous", "reasoning_content": history}, {"role": "user", "content": "continue"}}
				headers := map[string]string{"Idempotency-Key": "history-before-execution"}
				response := h.doChat(chatBody(chatBodyOptions{Messages: messages}), headers)
				var envelope errorEnvelope
				_ = json.Unmarshal([]byte(readAll(response)), &envelope)
				if response.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeUnsupportedParam || envelope.Error.Param == nil || *envelope.Error.Param != "messages" {
					t.Fatalf("unsupported history was silently dropped: status=%d code=%s", response.StatusCode, envelope.Error.Code)
				}
				if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
					t.Fatal("unsupported history crossed credentials, reservation or execution")
				}
				delete(messages[0], "reasoning_content")
				corrected := h.doChat(chatBody(chatBodyOptions{Messages: messages}), headers)
				_ = readAll(corrected)
				if corrected.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 1 {
					t.Fatal("corrected request could not reuse its undispatched idempotency key")
				}
			})
		}
	}
}

func TestInvalidReasoningHistoryTypesDoNotExecute(t *testing.T) {
	for _, value := range []any{17, true, map[string]string{"content": "private"}, []string{"private"}} {
		var calls atomic.Int32
		h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			defaultUpstreamHandler()(w, r)
		}})
		response := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "assistant", "content": "prior", "reasoning_content": value}}}), nil)
		_ = readAll(response)
		if response.StatusCode != http.StatusBadRequest || calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
			t.Fatalf("invalid reasoning type %T crossed execution: status=%d", value, response.StatusCode)
		}
	}
}
