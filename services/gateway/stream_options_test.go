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
)

func streamOptionsBody(extra string) []byte {
	return []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]` + extra + `}`)
}

func TestStreamOptionsValidation(t *testing.T) {
	for _, tc := range []struct {
		name, extra string
		valid       bool
	}{
		{"true", `,"stream":true,"stream_options":{"include_usage":true}`, true},
		{"false", `,"stream":true,"stream_options":{"include_usage":false}`, true},
		{"empty", `,"stream":true,"stream_options":{}`, true},
		{"missing stream", `,"stream_options":{"include_usage":true}`, false},
		{"nonstream", `,"stream":false,"stream_options":{"include_usage":false}`, false},
		{"null streaming", `,"stream":true,"stream_options":null`, true},
		{"null nonstreaming", `,"stream":false,"stream_options":null`, true},
		{"null stream flag", `,"stream":null,"stream_options":null`, true},
		{"null omitted stream", `,"stream_options":null`, true},
		{"array", `,"stream":true,"stream_options":[]`, false},
		{"scalar", `,"stream":true,"stream_options":true`, false},
		{"string boolean", `,"stream":true,"stream_options":{"include_usage":"true"}`, false},
		{"number boolean", `,"stream":true,"stream_options":{"include_usage":1}`, false},
		{"null boolean", `,"stream":true,"stream_options":{"include_usage":null}`, false},
		{"unknown nested", `,"stream":true,"stream_options":{"include_usage":true,"other":true}`, false},
		{"unknown top", `,"stream":true,"other":true`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, apiErr := parseChatRequest(streamOptionsBody(tc.extra), 4096)
			if (apiErr == nil) != tc.valid {
				t.Fatalf("valid=%v error=%+v", tc.valid, apiErr)
			}
		})
	}
}

func TestMaxCompletionTokensRangeValidation(t *testing.T) {
	for _, value := range []int{-1, 0, 1, 64, 65} {
		_, apiErr := parseChatRequest(streamOptionsBody(fmt.Sprintf(`,"max_completion_tokens":%d`, value)), 64)
		valid := value >= 1 && value <= 64
		if (apiErr == nil) != valid {
			t.Errorf("max_completion_tokens=%d valid=%v error=%+v", value, valid, apiErr)
		}
		if apiErr != nil && (apiErr.Param == nil || *apiErr.Param != "max_completion_tokens") {
			t.Errorf("wrong error parameter: %+v", apiErr)
		}
	}
}

func TestMaxCompletionTokensRejectedBeforeAdmissionOrSpend(t *testing.T) {
	var calls atomic.Int64
	limits := defaultLimits()
	limits.MaxTokensEstimate = 64
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		defaultUpstreamHandler()(w, r)
	}})
	for _, value := range []int{-1, 0, 65} {
		response := h.doChat(streamOptionsBody(fmt.Sprintf(`,"stream":true,"max_completion_tokens":%d`, value)), nil)
		body := readAll(response)
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(body, `"param":"max_completion_tokens"`) {
			t.Errorf("max_completion_tokens=%d status=%d body=%s", value, response.StatusCode, body)
		}
	}
	if calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
		t.Fatal("invalid completion limit reached upstream, budget reservation, or terminal metering")
	}
}

func streamOptionChunks(t *testing.T, body string) []map[string]any {
	t.Helper()
	if !strings.HasSuffix(strings.TrimSpace(body), "data: [DONE]") {
		t.Fatalf("missing final DONE: %s", body)
	}
	var chunks []map[string]any
	for _, frame := range strings.Split(body, "\n\n") {
		frame = strings.TrimSpace(frame)
		if frame == "" || frame == "data: [DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(frame, "data: ")), &chunk); err != nil {
			t.Fatal(err)
		}
		chunks = append(chunks, chunk)
	}
	return chunks
}

func TestStreamOptionsUsageChunks(t *testing.T) {
	for _, tc := range []struct {
		name, upstream       string
		input, output, total any
	}{
		{"reported", `,"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}`, float64(11), float64(4), float64(15)},
		{"partial zero", `,"usage":{"prompt_tokens":0}`, float64(0), nil, nil},
		{"missing", ``, nil, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, `data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]`+tc.upstream+"}\n\ndata: [DONE]\n\n")
			}})
			resp := h.doChat(streamOptionsBody(`,"stream":true,"stream_options":{"include_usage":true}`), nil)
			body := readAll(resp)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status=%d %s", resp.StatusCode, body)
			}
			chunks := streamOptionChunks(t, body)
			if len(chunks) < 3 {
				t.Fatalf("missing semantic/usage frames: %s", body)
			}
			for _, chunk := range chunks[:len(chunks)-1] {
				if usage, exists := chunk["usage"]; !exists || usage != nil {
					t.Fatalf("ordinary chunk must contain usage:null: %+v", chunk)
				}
			}
			last := chunks[len(chunks)-1]
			if choices, ok := last["choices"].([]any); !ok || len(choices) != 0 {
				t.Fatalf("usage choices must be []: %+v", last)
			}
			usage, ok := last["usage"].(map[string]any)
			if !ok || usage["prompt_tokens"] != tc.input || usage["completion_tokens"] != tc.output || usage["total_tokens"] != tc.total {
				t.Fatalf("wrong usage: %+v", usage)
			}
			if len(h.store.Requests()) != 1 {
				t.Fatal("missing durable request")
			}
		})
	}
}

func TestStreamOptionsFalseSuppressesWireUsageButStillMeters(t *testing.T) {
	for _, option := range []string{`{"include_usage":false}`, `{}`} {
		h := newHarness(t, harnessOptions{})
		body := readAll(h.doChat(streamOptionsBody(`,"stream":true,"stream_options":`+option), nil))
		for _, chunk := range streamOptionChunks(t, body) {
			if _, exists := chunk["usage"]; exists {
				t.Fatalf("unexpected usage with %s: %s", option, body)
			}
		}
		records := h.store.Requests()
		if len(records) != 1 || records[0].InputTokens != 11 || records[0].OutputTokens != 4 {
			t.Fatal("wire preference changed accounting")
		}
	}
}

func TestStreamOptionsOmittedPreservesLegacyUsage(t *testing.T) {
	for _, option := range []string{"", `,"stream_options":null`} {
		h := newHarness(t, harnessOptions{})
		body := readAll(h.doChat(streamOptionsBody(`,"stream":true`+option), nil))
		chunks := streamOptionChunks(t, body)
		if chunks[len(chunks)-1]["usage"] == nil {
			t.Fatalf("omitted/null option lost legacy usage: %s", body)
		}
	}
}

func TestStreamOptionsInterruptedStreamHasNoFinalUsageOrDone(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}],\"usage\":{\"prompt_tokens\":3}}\n\n")
	}})
	body := readAll(h.doChat(streamOptionsBody(`,"stream":true,"stream_options":{"include_usage":true}`), nil))
	if strings.Contains(body, "[DONE]") || strings.Contains(body, `"choices":[]`) {
		t.Fatalf("interrupted stream advertised final usage/success: %s", body)
	}
	if !strings.Contains(body, `"error":`) || len(h.store.Requests()) != 1 {
		t.Fatalf("interrupted stream lost error or terminal: %s", body)
	}
}

type streamOptionsPersistenceProbe struct {
	Store
	before func()
}

func (s *streamOptionsPersistenceProbe) PersistTerminal(ctx context.Context, record *TerminalRecord) error {
	s.before()
	return s.Store.PersistTerminal(ctx, record)
}

func TestStreamOptionsDoneStillRequiresPersistence(t *testing.T) {
	for _, failure := range []bool{false, true} {
		h := newHarness(t, harnessOptions{})
		w := httptest.NewRecorder()
		called := false
		h.proxy.store = &streamOptionsPersistenceProbe{Store: h.store, before: func() {
			called = true
			if strings.Contains(w.Body.String(), "[DONE]") {
				t.Error("DONE before durable terminal")
			}
		}}
		if failure {
			h.store.FailNext()
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(streamOptionsBody(`,"stream":true,"stream_options":{"include_usage":true}`))))
		req.Header.Set("Authorization", "Bearer "+testAPIKey)
		h.proxy.ServeChatCompletions(w, req)
		if !called {
			t.Fatalf("never persisted: %s", w.Body.String())
		}
		if strings.Contains(w.Body.String(), "[DONE]") == failure {
			t.Fatalf("incorrect DONE on persist failure=%v: %s", failure, w.Body.String())
		}
	}
}
