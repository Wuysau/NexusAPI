package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResponsesReviewMalformedOutputDoesNotRecordSuccessfulRequest(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", streaming), func(t *testing.T) {
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}`+"\n\ndata: [DONE]\n\n")
			}})
			w := callResponses(t, h, fmt.Sprintf(`{"model":"gpt-4o","input":"hi","stream":%v}`, streaming), true)
			if !streaming && w.Code != http.StatusBadGateway {
				t.Fatalf("malformed function output should fail: %d %s", w.Code, w.Body.String())
			}
			if streaming && (!strings.Contains(w.Body.String(), "response.failed") || strings.Contains(w.Body.String(), "response.completed")) {
				t.Fatalf("malformed streamed function output should fail: %s", w.Body.String())
			}
			records := h.store.Requests()
			if len(records) != 1 {
				t.Fatalf("usage fact lost: %d records", len(records))
			}
			if records[0].Status == "completed" {
				t.Fatal("mapper rejected malformed provider output but durable request says completed")
			}
			if records[0].InputTokens != 7 || records[0].OutputTokens != 2 {
				t.Fatal("validation failure lost measured usage")
			}
		})
	}
}
