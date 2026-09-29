package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCompletionLimitReachesCompatibleUpstream(t *testing.T) {
	for _, tc := range []struct {
		name, provider, endpoint, field string
		params                          map[string]any
		limit                           int
	}{
		{"modern", "openai", "/v1/chat/completions", "max_completion_tokens", map[string]any{"max_completion_tokens": 17}, 17},
		{"legacy", "openai", "/v1/chat/completions", "max_tokens", map[string]any{"max_tokens": 19}, 19},
		{"modern_wins", "openai", "/v1/chat/completions", "max_completion_tokens", map[string]any{"max_tokens": 19, "max_completion_tokens": 17}, 17},
		{"null_modern", "openai", "/v1/chat/completions", "max_tokens", map[string]any{"max_tokens": 19, "max_completion_tokens": nil}, 19},
		{"null_legacy", "openai", "/v1/chat/completions", "max_completion_tokens", map[string]any{"max_tokens": nil, "max_completion_tokens": 17}, 17},
		{"omitted", "openai", "/v1/chat/completions", "", nil, 0},
		{"null_both", "openai", "/v1/chat/completions", "", map[string]any{"max_tokens": nil, "max_completion_tokens": nil}, 0},
		{"ollama", "ollama", "/v1/chat/completions", "max_tokens", map[string]any{"max_completion_tokens": 17}, 17},
		{"deepseek", "deepseek", "/v1/chat/completions", "max_tokens", map[string]any{"max_completion_tokens": 17}, 17},
		{"qwen", "qwen", "/v1/chat/completions", "max_completion_tokens", map[string]any{"max_completion_tokens": 17}, 17},
		{"custom", "custom-fixture", "/v1/chat/completions", "max_completion_tokens", map[string]any{"max_completion_tokens": 17}, 17},
		{"responses", "openai", "/v1/responses", "max_completion_tokens", map[string]any{"max_output_tokens": 17}, 17},
		{"responses_omitted", "openai", "/v1/responses", "", nil, 0},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, stream), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body map[string]json.RawMessage
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error("upstream request was not JSON")
					}
					valid := true
					for _, field := range []string{"max_tokens", "max_completion_tokens"} {
						if field == tc.field {
							valid = valid && string(body[field]) == fmt.Sprint(tc.limit)
						} else {
							valid = valid && len(body[field]) == 0
						}
					}
					if !valid {
						w.WriteHeader(http.StatusBadRequest)
						_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","code":"unsupported_parameter"}}`))
						return
					}
					defaultUpstreamHandler()(w, r)
				}})
				if tc.provider != "openai" {
					setValidationProvider(t, h, tc.provider)
					updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) { b.Channels[0].Protocol = "openai" })
				}
				server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
				defer server.Close()
				body := map[string]any{"model": testModel, "stream": stream}
				if tc.endpoint == "/v1/responses" {
					body["input"] = "fixture"
				} else {
					body["messages"] = []map[string]string{{"role": "user", "content": "fixture"}}
				}
				for key, value := range tc.params {
					body[key] = value
				}
				raw, _ := json.Marshal(body)
				req, _ := http.NewRequest(http.MethodPost, server.URL+tc.endpoint, strings.NewReader(string(raw)))
				req.Header.Set("Authorization", "Bearer "+testAPIKey)
				response, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				output := readAll(response)
				if response.StatusCode != http.StatusOK || !strings.Contains(output, "Hello") || calls.Load() != 1 {
					t.Fatalf("token-limit mapping prevented one successful execution: status=%d calls=%d", response.StatusCode, calls.Load())
				}
				reserves := h.managed.reserveRequests()
				estimate := tc.limit
				if estimate == 0 {
					estimate = 1024
				}
				if len(reserves) != 1 || reserves[0].EstimatedOutputTokens != estimate {
					t.Fatal("wire field selection changed the effective reservation estimate")
				}
				records := h.store.Requests()
				if len(records) != 1 || records[0].Status != string(OutcomeCompleted) || len(records[0].Attempts) != 1 || records[0].Attempts[0].ChannelID != "chan_test_1" || h.store.OutboxCount(testTenantID) != 1 {
					t.Fatal("successful mapping lost the original execution/accounting cardinality")
				}
			})
		}
	}
}
