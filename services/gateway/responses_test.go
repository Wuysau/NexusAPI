package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nexus/gateway/provider"
)

func callResponses(t *testing.T, h *testHarness, payload string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
	r := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(payload))
	r.Header.Set("Content-Type", "application/json")
	if authenticated {
		r.Header.Set("Authorization", "Bearer "+testAPIKey)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	return w
}

func TestResponsesJSONUsesSharedAccounting(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","store":false}`, true)
	var body struct {
		Object, Status string
		Output         []struct {
			Type, Role string
			Content    []struct{ Type, Text string }
		}
		Usage struct {
			InputTokens  *int `json:"input_tokens"`
			OutputTokens *int `json:"output_tokens"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || body.Object != "response" || body.Status != "completed" || len(body.Output) != 1 || body.Output[0].Type != "message" || len(body.Output[0].Content) != 1 || body.Output[0].Content[0].Text != "Hello" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if body.Usage.InputTokens == nil || *body.Usage.InputTokens != 11 || body.Usage.OutputTokens == nil || *body.Usage.OutputTokens != 4 {
		t.Fatalf("usage=%s", w.Body.String())
	}
	if len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 || h.managed.reserveCount() != 1 {
		t.Fatal("responses bypassed shared accounting")
	}
}

func TestResponsesAuthenticationAndUnsupportedState(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { calls.Add(1); defaultUpstreamHandler()(w, r) }})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi"}`, false)
	if w.Code != 401 {
		t.Fatalf("auth status=%d body=%s", w.Code, w.Body.String())
	}
	for _, extra := range []string{`"previous_response_id":"resp_old"`, `"store":true`, `"background":true`, `"conversation":"conv_old"`, `"tools":[{"type":"web_search"}]`, `"input":[{"type":"item_reference","id":"msg_old"}]`} {
		payload := `{"model":"gpt-4o","input":"hi",` + extra + `}`
		w := callResponses(t, h, payload, true)
		if w.Code != 400 {
			t.Fatalf("unsupported %s status=%d body=%s", extra, w.Code, w.Body.String())
		}
	}
	if calls.Load() != 0 || h.managed.reserveCount() != 0 {
		t.Fatal("rejected request reached provider or reservation")
	}
}

func TestResponsesMapsFunctionHistoryAndTools(t *testing.T) {
	var upstream map[string]json.RawMessage
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&upstream); err != nil {
			t.Error(err)
		}
		defaultUpstreamHandler()(w, r)
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","instructions":"Be brief","input":[{"role":"user","content":[{"type":"input_text","text":"weather"}]},{"type":"function_call","call_id":"call_a","name":"weather","arguments":"{\"city\":\"Paris\"}"},{"type":"function_call_output","call_id":"call_a","output":"sunny"}],"tools":[{"type":"function","name":"weather","parameters":{"type":"object"},"strict":true}],"tool_choice":{"type":"function","name":"weather"}}`, true)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var messages []provider.Message
	if err := json.Unmarshal(upstream["messages"], &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[0].Role != "developer" || string(messages[0].Content) != `"Be brief"` || messages[2].Role != "assistant" || !strings.Contains(string(messages[2].ToolCalls), "call_a") || messages[3].Role != "tool" || messages[3].ToolCallID != "call_a" {
		t.Fatalf("messages=%s", upstream["messages"])
	}
	if !strings.Contains(string(upstream["tools"]), `"function"`) || !strings.Contains(string(upstream["tool_choice"]), `"function":{"name":"weather"}`) {
		t.Fatalf("tools=%s choice=%s", upstream["tools"], upstream["tool_choice"])
	}
}

func TestResponsesSSEHasTypedLifecycleAndTools(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]}}]}`+"\n\ndata: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"weather","stream":true}`, true)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	events := responseEvents(t, w.Body.String())
	var args strings.Builder
	var completed map[string]any
	var sawAdded bool
	for i, e := range events {
		if e["sequence_number"] != float64(i) {
			t.Fatalf("sequence=%v", e)
		}
		switch e["type"] {
		case "response.output_item.added":
			sawAdded = true
		case "response.function_call_arguments.delta":
			args.WriteString(e["delta"].(string))
		case "response.completed":
			completed = e["response"].(map[string]any)
		}
	}
	if len(events) == 0 || events[0]["type"] != "response.created" || !sawAdded || args.String() != `{"city":"Paris"}` || completed == nil {
		t.Fatalf("missing responses events: %s", w.Body.String())
	}
	if completed["usage"] != nil {
		t.Fatalf("invented usage: %+v", completed["usage"])
	}
	if strings.Contains(w.Body.String(), "[DONE]") || strings.Contains(w.Body.String(), "chat.completion") {
		t.Fatal("chat wire escaped responses mapper")
	}
}

func TestResponsesTruncatedStreamNeverCompletes(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"partial"}}]}`+"\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	var failed bool
	for _, e := range events {
		if e["type"] == "response.completed" {
			t.Fatal("truncation marked completed")
		}
		if e["type"] == "response.failed" {
			failed = true
			failure := e["response"].(map[string]any)["error"].(map[string]any)
			if failure["code"] != "server_error" {
				t.Fatalf("non-Responses failure code: %+v", failure)
			}
		}
	}
	if !failed {
		t.Fatalf("missing failure terminal: %s", w.Body.String())
	}
	if records := h.store.Requests(); len(records) != 1 || records[0].Status == "completed" {
		t.Fatalf("incorrect terminal accounting: %+v", records)
	}
}

func responseEvents(t *testing.T, body string) []map[string]any {
	t.Helper()
	r := provider.NewSSEReader(strings.NewReader(body))
	var events []map[string]any
	for {
		e, err := r.Next()
		if err == io.EOF {
			return events
		}
		if err != nil {
			t.Fatal(err)
		}
		var event map[string]any
		if err := json.Unmarshal(e.Data, &event); err != nil {
			t.Fatalf("invalid Responses SSE %s: %v", e.Data, err)
		}
		if event["type"] != e.Event {
			t.Fatalf("event type mismatch: %+v %s", event, e.Event)
		}
		events = append(events, event)
	}
}

func TestResponsesNonStreamFunctionOutputAndNullableUsage(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":0,"prompt_tokens_details":{"cached_tokens":0}}}`+"\n\ndata: [DONE]\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"weather"}`, true)
	var body struct {
		Status string
		Output []struct {
			Type, Name, Arguments string
			CallID                string `json:"call_id"`
		}
		Usage struct {
			InputTokens        *int `json:"input_tokens"`
			OutputTokens       *int `json:"output_tokens"`
			TotalTokens        *int `json:"total_tokens"`
			InputTokensDetails struct {
				CachedTokens *int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
		}
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != 200 || body.Status != "completed" || len(body.Output) != 1 || body.Output[0].Type != "function_call" || body.Output[0].CallID != "call_a" || body.Output[0].Arguments != "{}" {
		t.Fatalf("invalid function output: %s", w.Body.String())
	}
	if body.Usage.InputTokens == nil || *body.Usage.InputTokens != 0 || body.Usage.OutputTokens != nil || body.Usage.TotalTokens != nil || body.Usage.InputTokensDetails.CachedTokens == nil || *body.Usage.InputTokensDetails.CachedTokens != 0 {
		t.Fatalf("usage presence lost: %s", w.Body.String())
	}
}

func TestResponsesLengthIsIncomplete(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}`+"\n\ndata: [DONE]\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	last := events[len(events)-1]
	if last["type"] != "response.incomplete" || last["response"].(map[string]any)["incomplete_details"].(map[string]any)["reason"] != "max_output_tokens" {
		t.Fatalf("invalid incomplete terminal: %s", w.Body.String())
	}
}

func TestResponsesStreamBoundsFinalSerializedOutput(t *testing.T) {
	limits := defaultLimits()
	limits.MaxResponseBytes = 4096
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 12; i++ {
			raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": strings.Repeat("\x01", 100)}}}})
			_, _ = io.WriteString(w, "data: "+string(raw)+"\n\n")
		}
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	var failed bool
	for _, e := range events {
		if e["type"] == "response.completed" {
			t.Fatal("oversized serialized response completed")
		}
		if e["type"] == "response.failed" {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("missing size failure: %s", w.Body.String())
	}
}

func TestResponsesMapperBoundsFinalObjectAcrossSmallWrites(t *testing.T) {
	recorder := httptest.NewRecorder()
	w := &responsesWriter{w: recorder, header: make(http.Header), request: &responsesRequest{Model: "test", Stream: true}, id: "resp_test", maxBytes: 4096, textIndex: -1, tools: make(map[int]int)}
	for i := 0; i < 12; i++ {
		chunk := sseChunk("chat_test", "request", "test", 0, map[string]any{"content": strings.Repeat("\x01", 100)}, nil, nil)
		if _, err := w.Write(chunk); err != nil {
			break
		}
	}
	_, _ = w.Write([]byte("data: [DONE]\n\n"))
	// The terminal error is asserted through the emitted response.failed event.
	_ = w.finish()
	events := responseEvents(t, recorder.Body.String())
	last := events[len(events)-1]
	if last["type"] != "response.failed" {
		t.Fatal("escaped JSON final object bypassed response size limit")
	}
}

func TestResponsesStreamPreservesFragmentedToolIdentity(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, payload := range []string{
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"wea","arguments":""}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"ther","arguments":"}"}}]},"finish_reason":"tool_calls"}]}`,
			`[DONE]`,
		} {
			_, _ = io.WriteString(w, "data: "+payload+"\n\n")
		}
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	last := events[len(events)-1]
	if last["type"] != "response.completed" {
		t.Fatalf("fragmented identity failed: %s", w.Body.String())
	}
	output := last["response"].(map[string]any)["output"].([]any)
	call := output[0].(map[string]any)
	if call["call_id"] != "call_a" || call["name"] != "weather" || call["arguments"] != "{}" {
		t.Fatalf("lost identity: %+v", call)
	}
	var args strings.Builder
	for _, event := range events {
		if event["type"] == "response.function_call_arguments.delta" {
			args.WriteString(event["delta"].(string))
		}
	}
	if args.String() != "{}" {
		t.Fatalf("lost pre-identity arguments: %q", args.String())
	}
}

func TestResponsesPersistenceFailureNeverCompletes(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.store.FailNext()
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	if events[len(events)-1]["type"] != "response.failed" {
		t.Fatalf("persistence failure completed: %s", w.Body.String())
	}
	for _, event := range events {
		if event["type"] == "response.completed" {
			t.Fatal("completion emitted before persistence")
		}
	}
}

func TestResponsesRejectsOutputTextInUserInput(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	w := callResponses(t, h, `{"model":"gpt-4o","input":[{"role":"user","content":[{"type":"output_text","text":"hi"}]}]}`, true)
	if w.Code != 400 || len(h.store.Requests()) != 0 {
		t.Fatalf("output_text accepted as user input: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestResponsesClientCancellationStopsUpstream(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"partial"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hi","stream":true}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+testAPIKey)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
	go func() { router.ServeHTTP(w, r); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream did not start")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream did not cancel")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("responses handler did not stop")
	}
	if strings.Contains(w.Body.String(), "response.completed") {
		t.Fatal("cancelled request completed")
	}
	if records := h.store.Requests(); len(records) != 1 || records[0].Status == "completed" {
		t.Fatalf("cancellation not accounted: %+v", records)
	}
}

func TestResponsesRejectsIncompleteFunctionIdentity(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"hi"}`, true)
	if w.Code != 502 {
		t.Fatalf("missing function identity completed: %s", w.Body.String())
	}
}

func TestResponsesFinalObjectSizeFailurePreservesUsageWithoutCompletedRecord(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", streaming), func(t *testing.T) {
			limits := defaultLimits()
			limits.MaxResponseBytes = 4096
			h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				payload, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": strings.Repeat("a", 3500)}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 7, "completion_tokens": 2}})
				_, _ = io.WriteString(w, "data: "+string(payload)+"\n\ndata: [DONE]\n\n")
			}})
			w := callResponses(t, h, fmt.Sprintf(`{"model":"gpt-4o","input":"hi","stream":%v}`, streaming), true)
			if !streaming && w.Code != 502 {
				t.Fatalf("oversize final response succeeded: %d %s", w.Code, w.Body.String())
			}
			if streaming && (!strings.Contains(w.Body.String(), "response.failed") || strings.Contains(w.Body.String(), "response.completed")) {
				t.Fatalf("oversize final stream succeeded: %s", w.Body.String())
			}
			records := h.store.Requests()
			if len(records) != 1 || records[0].Status != "unknown" {
				t.Fatalf("validation did not record unknown: %+v", records)
			}
			if records[0].InputTokens != 7 || records[0].OutputTokens != 2 {
				t.Fatal("validation lost measured usage")
			}
		})
	}
}
