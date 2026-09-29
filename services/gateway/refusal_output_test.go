package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func refusalFixtureChunk(w io.Writer, delta map[string]any, finish any, usage any) {
	body := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
	if usage != nil {
		body["usage"] = usage
	}
	raw, _ := json.Marshal(body)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
}

func collectChatRefusal(t *testing.T, body string, streaming bool) (string, bool) {
	t.Helper()
	if !streaming {
		var completion struct {
			Choices []struct {
				Message struct {
					Refusal *string `json:"refusal"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(body), &completion) != nil || len(completion.Choices) != 1 {
			t.Fatal("invalid buffered completion")
		}
		value := completion.Choices[0].Message.Refusal
		if value != nil {
			return *value, true
		}
		return "", false
	}
	var refusal strings.Builder
	found := false
	for _, frame := range strings.Split(body, "\n\n") {
		payload := strings.TrimPrefix(frame, "data: ")
		var chunk struct {
			Choices []struct {
				Delta struct{ Refusal *string } `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Refusal != nil {
				found = true
				refusal.WriteString(*choice.Delta.Refusal)
			}
		}
	}
	return refusal.String(), found
}

func TestChatRefusalPreservesNormalCompletionAndAccounting(t *testing.T) {
	const marker = "private-refusal-说明\nfixture"
	for _, streaming := range []bool{false, true} {
		for _, observed := range []bool{false, true} {
			t.Run(fmt.Sprintf("stream=%t/usage=%t", streaming, observed), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body map[string]json.RawMessage
					if json.NewDecoder(r.Body).Decode(&body) != nil || len(body["response_format"]) == 0 {
						t.Error("structured format did not reach provider")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					refusalFixtureChunk(w, map[string]any{"content": nil, "refusal": "private-refusal-"}, nil, nil)
					refusalFixtureChunk(w, map[string]any{"refusal": "说明\nfixture"}, "stop", nil)
					if observed {
						refusalFixtureChunk(w, nil, nil, map[string]int{"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6})
					}
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
				}})
				var logs bytes.Buffer
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				for i := 1; i <= 3; i++ {
					response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Extra: map[string]any{
						"response_format": json.RawMessage(`{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object","properties":{},"additionalProperties":false}}}`),
					}}), nil)
					body := readAll(response)
					refusal, found := collectChatRefusal(t, body, streaming)
					if response.StatusCode != http.StatusOK || !found || refusal != marker || (streaming && !strings.Contains(body, "[DONE]")) {
						t.Fatalf("normal refusal lost: status=%d found=%t", response.StatusCode, found)
					}
					if !streaming && !strings.Contains(body, `"content":null`) {
						t.Fatal("refusal-only response invented text content")
					}
					if calls.Load() != int32(i) || len(h.store.Requests()) != i || h.store.OutboxCount(testTenantID) != i {
						t.Fatal("normal refusal changed execution cardinality")
					}
				}
				for _, record := range h.store.Requests() {
					if record.Status != string(OutcomeCompleted) || len(record.Attempts) != 1 || record.EventV2 == nil {
						t.Fatal("normal refusal became execution failure")
					}
					u := record.EventV2.Usage
					if observed {
						if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens == nil || *u.OutputTokens != 1 || u.TotalTokens == nil || *u.TotalTokens != 6 {
							t.Fatal("refusal lost reliable usage")
						}
					} else if u.InputTokens != nil || u.OutputTokens != nil || u.TotalTokens != nil {
						t.Fatal("refusal fabricated usage")
					}
				}
				key := BreakerKey("chan_test_1", testModel)
				// A fast local call can have a zero-duration clock sample on Windows.
				// Verify one first-output observation per call, independent of duration.
				h.breaker.mu.Lock()
				samples := h.breaker.entryLocked(key).ttftSamples
				h.breaker.mu.Unlock()
				if h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 || samples != 3 {
					t.Fatalf("refusal health: state=%s failures=%f samples=%d", h.breaker.State(key), h.breaker.FailureRate(key), samples)
				}
				facts, _ := json.Marshal(h.store.Requests())
				if bytes.Contains(facts, []byte("private-refusal-")) || strings.Contains(logs.String(), "private-refusal-") {
					t.Fatal("refusal content entered execution facts or logs")
				}
			})
		}
	}
}

func TestChatRefusalEmptyAndMixedText(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		for _, text := range []string{"", "visible text"} {
			t.Run(fmt.Sprintf("stream=%t/text=%t", streaming, text != ""), func(t *testing.T) {
				h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					_, _ = io.Copy(io.Discard, r.Body)
					w.Header().Set("Content-Type", "text/event-stream")
					refusalFixtureChunk(w, map[string]any{"content": text, "refusal": ""}, "stop", nil)
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
				}})
				body := readAll(h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil))
				value, found := collectChatRefusal(t, body, streaming)
				if !found || value != "" || (text != "" && !strings.Contains(body, text)) {
					t.Fatal("explicit empty refusal or independent text was lost")
				}
			})
		}
	}
}

func TestChatBufferedRefusalEnforcesResponseLimit(t *testing.T) {
	for _, value := range []string{strings.Repeat("x", 8192), strings.Repeat("\x01", 1024)} {
		t.Run(fmt.Sprintf("decoded=%d", len(value)), func(t *testing.T) {
			limits := defaultLimits()
			limits.MaxResponseBytes = 4096
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{Limits: limits, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				refusalFixtureChunk(w, map[string]any{"refusal": value}, "stop", nil)
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
			}})
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			body := readAll(response)
			records := h.store.Requests()
			if response.StatusCode != http.StatusBadGateway || calls.Load() != 1 || len(records) != 1 || records[0].Status != string(OutcomeUnknown) || len(records[0].Attempts) != 1 || strings.Contains(body, value) {
				t.Fatal("oversized refusal bypassed bounded output or safe terminal accounting")
			}
		})
	}
}

func TestChatPartialRefusalDoesNotReplay(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmtBool(streaming), func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{EnableUsageV2: true, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				refusalFixtureChunk(w, map[string]any{"refusal": "partial refusal"}, nil, map[string]int{"prompt_tokens": 5})
				w.(http.Flusher).Flush()
			}, ExtraChannelsFn: func(url string) []SnapshotChannel {
				return []SnapshotChannel{{ID: "refusal-fallback", ConnectionID: "connection-fallback", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", CredentialMode: "managed", CredentialRef: "cred_fallback", Priority: 1, Enabled: true}}
			}})
			response := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil)
			body := readAll(response)
			if streaming {
				value, found := collectChatRefusal(t, body, true)
				if !found || value != "partial refusal" || strings.Contains(body, "[DONE]") {
					t.Fatal("partial refusal lost or marked completed")
				}
			} else if response.StatusCode != http.StatusBadGateway || strings.Contains(body, "partial refusal") {
				t.Fatal("incomplete buffered refusal leaked or succeeded")
			}
			records := h.store.Requests()
			if calls.Load() != 1 || len(records) != 1 || records[0].Status != string(OutcomeUnknown) || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("partial refusal replayed or lost terminal")
			}
			u := records[0].EventV2.Usage
			if u.InputTokens == nil || *u.InputTokens != 5 || u.OutputTokens != nil || u.TotalTokens != nil {
				t.Fatal("partial refusal lost observed/unknown usage")
			}
		})
	}
}
