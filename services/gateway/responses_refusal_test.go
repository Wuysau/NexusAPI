package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func refusalMapper(stream bool, limit int) (*responsesWriter, *httptest.ResponseRecorder) {
	r := httptest.NewRecorder()
	w := &responsesWriter{w: r, header: make(http.Header), request: &responsesRequest{Model: "fixture", Stream: stream}, id: "resp_fixture", maxBytes: limit, textIndex: -1, tools: make(map[int]int)}
	return w, r
}

func writeRefusalDelta(t *testing.T, w *responsesWriter, delta map[string]any) {
	t.Helper()
	if _, err := w.Write(sseChunk("chat_fixture", "request", "fixture", 0, delta, nil, nil)); err != nil {
		t.Fatal(err)
	}
}

func finishRefusalMapper(t *testing.T, w *responsesWriter, r *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.request.Stream {
		if _, err := w.Write([]byte("data: [DONE]\n\n")); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.finish(); err != nil {
		t.Fatal(err)
	}
	if w.request.Stream {
		events := responseEvents(t, r.Body.String())
		for index, event := range events {
			if event["sequence_number"] != float64(index) {
				t.Fatalf("event sequence is not contiguous at %d", index)
			}
		}
		last := events[len(events)-1]
		if last["type"] != "response.completed" {
			t.Fatalf("expected completed response, got %v", last["type"])
		}
		return last["response"].(map[string]any)
	}
	var response map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestResponsesRefusalMapperLifecycle(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			w, r := refusalMapper(stream, 16<<10)
			if stream {
				writeRefusalDelta(t, w, map[string]any{"refusal": "cannot "})
				writeRefusalDelta(t, w, map[string]any{"refusal": "complete"})
			} else {
				_, err := w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null,"refusal":"cannot complete"},"finish_reason":"stop"}],"usage":null}`))
				if err != nil {
					t.Fatal(err)
				}
			}
			response := finishRefusalMapper(t, w, r)
			output := response["output"].([]any)
			if len(output) != 1 {
				t.Fatalf("refusal output items=%d, want 1", len(output))
			}
			item := output[0].(map[string]any)
			want := []any{map[string]any{"type": "refusal", "refusal": "cannot complete"}}
			if item["type"] != "message" || item["status"] != "completed" || !reflect.DeepEqual(item["content"], want) || response["usage"] != nil {
				t.Fatal("refusal was not represented as its own typed content part with unknown usage")
			}
			if stream {
				var kinds []string
				var accumulated strings.Builder
				for _, event := range responseEvents(t, r.Body.String()) {
					kind := event["type"].(string)
					kinds = append(kinds, kind)
					if strings.HasPrefix(kind, "response.refusal.") {
						if event["item_id"] != item["id"] || event["output_index"] != float64(0) || event["content_index"] != float64(0) || event["logprobs"] != nil {
							t.Fatal("refusal event has wrong identity, indices or text-only metadata")
						}
						if kind == "response.refusal.delta" {
							accumulated.WriteString(event["delta"].(string))
						}
						if kind == "response.refusal.done" && event["refusal"] != "cannot complete" {
							t.Fatal("refusal done lost content")
						}
					}
				}
				wantKinds := []string{"response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.refusal.delta", "response.refusal.delta", "response.refusal.done", "response.content_part.done", "response.output_item.done", "response.completed"}
				if !reflect.DeepEqual(kinds, wantKinds) || accumulated.String() != "cannot complete" {
					t.Fatalf("invalid refusal lifecycle: %v", kinds)
				}
			}
		})
	}
}

func TestResponsesRefusalEmptyAndNullRemainDistinct(t *testing.T) {
	for _, value := range []any{nil, ""} {
		w, r := refusalMapper(true, 4096)
		writeRefusalDelta(t, w, map[string]any{"refusal": value})
		response := finishRefusalMapper(t, w, r)
		output := response["output"].([]any)
		if value == nil {
			if len(output) != 0 {
				t.Fatal("null refusal created output")
			}
		} else if len(output) != 1 || !reflect.DeepEqual(output[0].(map[string]any)["content"], []any{map[string]any{"type": "refusal", "refusal": ""}}) {
			t.Fatal("explicit empty refusal was discarded")
		}
	}
}

func TestResponsesRefusalAfterPendingToolPreservesItemOrder(t *testing.T) {
	w, r := refusalMapper(true, 16<<10)
	writeRefusalDelta(t, w, map[string]any{"content": "before"})
	writeRefusalDelta(t, w, map[string]any{"tool_calls": json.RawMessage(`[{"index":0,"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{"}}]`)})
	writeRefusalDelta(t, w, map[string]any{"refusal": "blocked"})
	if strings.Contains(r.Body.String(), "response.refusal.delta") {
		t.Fatal("later refusal bypassed a pending tool item")
	}
	writeRefusalDelta(t, w, map[string]any{"tool_calls": json.RawMessage(`[{"index":0,"function":{"arguments":"}"}}]`)})
	response := finishRefusalMapper(t, w, r)
	output := response["output"].([]any)
	if len(output) != 3 || output[1].(map[string]any)["type"] != "function_call" || output[1].(map[string]any)["arguments"] != "{}" {
		t.Fatal("mixed output items were lost or reordered")
	}
	if !reflect.DeepEqual(output[2].(map[string]any)["content"], []any{map[string]any{"type": "refusal", "refusal": "blocked"}}) {
		t.Fatal("refusal moved before the tool")
	}
	var added []float64
	for _, event := range responseEvents(t, r.Body.String()) {
		if event["type"] == "response.output_item.added" {
			added = append(added, event["output_index"].(float64))
		}
		if event["type"] == "response.refusal.delta" && event["output_index"] != float64(2) {
			t.Fatal("refusal delta has the wrong output index")
		}
	}
	if !reflect.DeepEqual(added, []float64{0, 1, 2}) {
		t.Fatalf("item announcement order = %v", added)
	}
}

func TestResponsesRefusalHistoryRetainsAssistantSemantics(t *testing.T) {
	for _, refusal := range []string{"", "retained"} {
		raw, _ := json.Marshal([]any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "before"}, map[string]any{"type": "refusal", "refusal": refusal}}}})
		messages, err := responsesInput(raw)
		if err != nil {
			t.Fatalf("returned assistant refusal cannot be replayed: %s", err.Code)
		}
		encoded, _ := json.Marshal(messages)
		var wire []map[string]json.RawMessage
		_ = json.Unmarshal(encoded, &wire)
		want, _ := json.Marshal(refusal)
		if len(wire) != 1 || string(wire[0]["refusal"]) != string(want) || string(wire[0]["content"]) != `"before"` {
			t.Fatal("assistant text or refusal was dropped from history")
		}
	}
	for _, role := range []string{"user", "system", "developer"} {
		raw, _ := json.Marshal([]any{map[string]any{"role": role, "content": []any{map[string]any{"type": "refusal", "refusal": "blocked"}}}})
		if _, err := responsesInput(raw); err == nil {
			t.Fatalf("refusal content allowed for %s", role)
		}
	}
}

func TestResponsesRefusalRejectsInvalidHistoryParts(t *testing.T) {
	for _, content := range []string{
		`[{"type":"refusal"}]`, `[{"type":"refusal","refusal":null}]`,
		`[{"type":"refusal","refusal":12}]`, `[{"type":"refusal","refusal":[]}]`,
		`[{"type":"refusal","refusal":{}}]`,
	} {
		raw := json.RawMessage(`[{"role":"assistant","content":` + content + `}]`)
		if _, err := responsesInput(raw); err == nil {
			t.Fatal("malformed refusal history accepted")
		}
	}
	if _, err := responsesInput(json.RawMessage(`[{"type":"function_call_output","call_id":"call_a","output":[{"type":"refusal","refusal":"blocked"}]}]`)); err == nil {
		t.Fatal("tool results gained assistant refusal semantics")
	}
}

func TestResponsesRefusalLimitsIncludeEscapingAndFinalEvent(t *testing.T) {
	for _, finalEnvelope := range []bool{false, true} {
		t.Run(fmt.Sprintf("finalEnvelope=%v", finalEnvelope), func(t *testing.T) {
			w, r := refusalMapper(true, 4096)
			if finalEnvelope {
				writeRefusalDelta(t, w, map[string]any{"refusal": strings.Repeat("r", 512)})
				final, _ := json.Marshal(w.response("completed"))
				// The complete response fits; its terminal event's envelope does not.
				w.maxBytes = len(final) + 8
			} else {
				var failure error
				for n := 0; n < 12; n++ {
					_, failure = w.Write(sseChunk("c", "r", "fixture", 0, map[string]any{"refusal": strings.Repeat("\x01", 100)}, nil, nil))
					if failure != nil {
						break
					}
				}
				if failure == nil {
					t.Fatal("escaped refusal bypassed the aggregate size limit")
				}
			}
			_, _ = w.Write([]byte("data: [DONE]\n\n"))
			if err := w.finish(); err != nil {
				t.Fatal(err)
			}
			events := responseEvents(t, r.Body.String())
			if events[len(events)-1]["type"] != "response.failed" {
				t.Fatal("oversized refusal completed")
			}
			for _, event := range events {
				if event["type"] == "response.completed" || event["type"] == "response.refusal.done" {
					t.Fatal("refusal was finalized before size validation")
				}
			}
		})
	}
}

func TestResponsesRefusalHTTPAndHistoryRoundTrip(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, knownUsage := range []bool{false, true} {
			t.Run(fmt.Sprintf("stream=%v/usage=%v", stream, knownUsage), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					var body struct {
						Messages []map[string]json.RawMessage `json:"messages"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil {
						t.Error("mock request invalid")
						return
					}
					if calls.Add(1) > 1 {
						if len(body.Messages) != 2 || string(body.Messages[0]["refusal"]) != `"fixture refusal"` || string(body.Messages[0]["content"]) != "null" {
							w.WriteHeader(400)
							return
						}
						defaultUpstreamHandler()(w, r)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"refusal":"fixture "}}]}`+"\n\ndata: "+`{"choices":[{"delta":{"refusal":"refusal"},"finish_reason":"stop"}]}`+"\n\n")
					if knownUsage {
						_, _ = io.WriteString(w, "data: "+`{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}`+"\n\n")
					}
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
				}})
				server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
				defer server.Close()
				call := func(input any) map[string]any {
					payload, _ := json.Marshal(map[string]any{"model": testModel, "input": input, "stream": stream})
					req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(string(payload)))
					req.Header.Set("Authorization", "Bearer "+testAPIKey)
					res, err := server.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					text := readAll(res)
					if res.StatusCode != 200 {
						t.Fatalf("responses request failed: status=%d", res.StatusCode)
					}
					var result map[string]any
					if stream {
						events := responseEvents(t, text)
						last := events[len(events)-1]
						if last["type"] != "response.completed" {
							t.Fatalf("unexpected terminal %v", last["type"])
						}
						result = last["response"].(map[string]any)
					} else if err := json.Unmarshal([]byte(text), &result); err != nil {
						t.Fatal(err)
					}
					return result
				}
				first := call("fixture")
				output := first["output"].([]any)
				if len(output) != 1 || !reflect.DeepEqual(output[0].(map[string]any)["content"], []any{map[string]any{"type": "refusal", "refusal": "fixture refusal"}}) {
					t.Fatal("HTTP refusal output lost")
				}
				if knownUsage {
					usage := first["usage"].(map[string]any)
					if usage["input_tokens"] != float64(5) || usage["output_tokens"] != float64(1) || usage["total_tokens"] != float64(6) {
						t.Fatal("observed refusal usage changed")
					}
				} else if first["usage"] != nil {
					t.Fatal("unknown refusal usage became fabricated counters")
				}
				second := call(append(output, map[string]any{"role": "user", "content": "continue"}))
				if second["status"] != "completed" || calls.Load() != 2 {
					t.Fatal("refusal history could not complete one further turn")
				}
				records := h.store.Requests()
				if len(records) != 2 || h.managed.reserveCount() != 2 || h.store.OutboxCount(testTenantID) != 2 {
					t.Fatal("refusal changed execution cardinality")
				}
				for _, record := range records {
					if record.Status != string(OutcomeCompleted) || len(record.Attempts) != 1 || record.EventV2 == nil {
						t.Fatal("refusal did not retain a single completed execution")
					}
				}
				facts, _ := json.Marshal(records)
				if strings.Contains(string(facts), "fixture refusal") {
					t.Fatal("refusal content leaked into terminal facts")
				}
			})
		}
	}
}

func TestResponsesRefusalTruncationDoesNotFinalizeOrReplay(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{EnableUsageV2: true, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"refusal":"partial refusal"}}]}`+"\n\n")
	}})
	w := callResponses(t, h, `{"model":"gpt-4o","input":"fixture","stream":true}`, true)
	events := responseEvents(t, w.Body.String())
	if events[len(events)-1]["type"] != "response.failed" || calls.Load() != 1 {
		t.Fatal("truncated refusal completed or replayed")
	}
	var partial bool
	for _, event := range events {
		if event["type"] == "response.refusal.delta" {
			partial = true
		}
		if event["type"] == "response.refusal.done" || event["type"] == "response.completed" {
			t.Fatal("truncated refusal was finalized")
		}
	}
	if !partial {
		t.Fatal("partial refusal was lost before the terminal failure")
	}
	if records := h.store.Requests(); len(records) != 1 || records[0].Status != string(OutcomeUnknown) {
		t.Fatal("truncated refusal lost its ambiguous execution fact")
	}
}

func TestResponsesRefusalClientCancellationStopsOneUpstream(t *testing.T) {
	canceled := make(chan struct{})
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"refusal":"partial refusal"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	}})
	server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"fixture","stream":true}`))
	req.Header.Set("Authorization", "Bearer "+testAPIKey)
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(res.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "response.refusal.delta") {
			break
		}
	}
	cancel()
	_ = res.Body.Close()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("client cancellation did not reach upstream")
	}
	if calls.Load() != 1 {
		t.Fatal("canceled refusal was replayed")
	}
}
