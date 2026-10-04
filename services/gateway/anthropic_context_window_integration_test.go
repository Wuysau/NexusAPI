package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicContextWindowTruncationPreservesCompletedExecution(t *testing.T) {
	for _, responses := range []bool{false, true} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("responses=%t/stream=%t", responses, streaming), func(t *testing.T) {
				h, calls, fallback := newAnthropicUsageHarness(t, anthropicGatewayInitialUsage,
					`{"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":7}}`, false)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				var response *http.Response
				if responses {
					server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
					t.Cleanup(server.Close)
					request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(fmt.Sprintf(`{"model":"gpt-4o","input":"private-anthropic-prompt","stream":%t}`, streaming)))
					if err != nil {
						t.Fatal(err)
					}
					request.Header.Set("Authorization", "Bearer "+testAPIKey)
					request.Header.Set("Content-Type", "application/json")
					response, err = server.Client().Do(request)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					response = h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-anthropic-prompt"}}}), nil)
				}
				body := anthropicGatewayRead(t, response)
				r := usageTotalSoleRecord(t, h, calls, fallback)
				if response.StatusCode != http.StatusOK || r.Status != string(OutcomeCompleted) || r.ErrorCode != "" || r.Attempts[0].Status != string(OutcomeCompleted) || r.Event.Status != string(OutcomeCompleted) || r.EventV2.Status != string(OutcomeCompleted) {
					t.Error("valid context-window termination lost successful execution accounting")
				}
				want := anthropicGatewayKnownUsage()
				want.output = anthropicGatewayInt(7)
				assertAnthropicGatewayUsage(t, r, want, false)
				if r.Event.Usage.InputTokens != 5 || r.Event.Usage.OutputTokens != 7 || r.Event.Usage.Estimated || r.ChargeAmount != 0 || r.ReservationAmount != 0 {
					t.Error("context-window truncation changed observed usage or fabricated BYOK money")
				}
				key := BreakerKey(r.Attempts[0].ChannelID, r.RequestModel)
				if h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 {
					t.Error("valid truncation penalized channel health")
				}
				if response.Header.Get("x-request-id") != r.RequestID || !strings.Contains(body, r.RequestID) {
					t.Error("truncated response lost authoritative request identity")
				}
				assertAnthropicGatewayPrivacy(t, h, response, body, logs.String())
				var usage map[string]any
				if responses {
					var final map[string]any
					if streaming {
						events := responseEvents(t, body)
						if len(events) == 0 {
							t.Fatal("missing Responses lifecycle")
						}
						last := events[len(events)-1]
						if last["type"] != "response.incomplete" || strings.Count(body, "event: response.incomplete\n") != 1 || strings.Contains(body, "event: response.completed\n") || strings.Contains(body, "event: response.failed\n") {
							t.Error("context-window truncation did not end with one incomplete response")
						}
						final, _ = last["response"].(map[string]any)
					} else if err := json.Unmarshal([]byte(body), &final); err != nil {
						t.Fatal(err)
					}
					// Responses exposes a coarse length category; this does not preserve
					// the native distinction between context capacity and max_tokens.
					details, _ := final["incomplete_details"].(map[string]any)
					if final["status"] != "incomplete" || final["error"] != nil || details["reason"] != "max_output_tokens" {
						t.Error("context-window truncation was reported as a complete answer")
					}
					output, _ := json.Marshal(final["output"])
					if strings.Count(string(output), "private-anthropic-content") != 1 {
						t.Error("truncated response lost its partial output")
					}
					usage, _ = final["usage"].(map[string]any)
				} else {
					var chunks []map[string]any
					if streaming {
						chunks = streamOptionChunks(t, body)
					} else {
						var final map[string]any
						if err := json.Unmarshal([]byte(body), &final); err != nil {
							t.Fatal(err)
						}
						chunks = []map[string]any{final}
					}
					var finishes []string
					for _, chunk := range chunks {
						choices, _ := chunk["choices"].([]any)
						for _, choice := range choices {
							if finish, ok := choice.(map[string]any)["finish_reason"].(string); ok {
								finishes = append(finishes, finish)
							}
						}
						if reported, ok := chunk["usage"].(map[string]any); ok {
							usage = reported
						}
					}
					if len(finishes) != 1 || finishes[0] != "length" || strings.Contains(body, `"error"`) || strings.Count(body, "private-anthropic-content") != 1 || (streaming && strings.Count(body, "[DONE]") != 1) {
						t.Error("context-window truncation lost partial text or its length terminal")
					}
				}
				input, output := "prompt_tokens", "completion_tokens"
				if responses {
					input, output = "input_tokens", "output_tokens"
				}
				if usage[input] != float64(5) || usage[output] != float64(7) || usage["total_tokens"] != nil {
					t.Error("public truncation projection changed observed usage")
				}
			})
		}
	}
}
