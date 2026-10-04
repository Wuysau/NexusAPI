package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestAnthropicUnknownStopReasonIsUnknownWithoutReplay(t *testing.T) {
	for _, reason := range []string{"NOT_A_FINISH", "private-anthropic-stop-reason"} {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", reason, streaming), func(t *testing.T) {
				encodedReason, _ := json.Marshal(reason)
				later := `{"type":"message_delta","delta":{"stop_reason":` + string(encodedReason) + `},"usage":{"output_tokens":7}}`
				// The fixture supplies both a later valid end_turn/message_stop and
				// an eligible fallback. Neither may recover this accepted request.
				h, calls, fallbackCalls := newAnthropicUsageHarness(t, anthropicGatewayInitialUsage, later, true)
				var logs connectorRetryLogs
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-anthropic-prompt"}}}), nil)
				body := anthropicGatewayRead(t, response)
				r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
				if r.Status != string(OutcomeUnknown) || r.ErrorCode != CodeUpstreamProtocol || r.Attempts[0].Status != string(OutcomeUnknown) || r.Event.Status != string(OutcomeUnknown) || r.EventV2.Status != string(OutcomeUnknown) {
					t.Error("unknown native stop reason certified a completed execution")
				}
				want := anthropicGatewayKnownUsage()
				want.output = anthropicGatewayInt(7)
				assertAnthropicGatewayUsage(t, r, want, true)
				if r.Event.Usage.InputTokens != 5 || r.Event.Usage.OutputTokens != 7 || !r.Event.Usage.Estimated || r.ChargeAmount != 0 || r.ReservationAmount != 0 {
					t.Error("protocol failure changed observed usage or fabricated BYOK money")
				}
				if streaming {
					if response.StatusCode != http.StatusOK || strings.Count(body, CodeUpstreamProtocol) != 1 || strings.Contains(body, "[DONE]") || strings.Count(body, "private-anthropic-content") != 1 || strings.Contains(body, `"finish_reason":"stop"`) {
						t.Error("unknown native stop reason became a successful stream terminal or lost its accepted prefix")
					}
				} else if response.StatusCode != http.StatusBadGateway || strings.Count(body, CodeUpstreamProtocol) != 1 || strings.Contains(body, "private-anthropic-content") || strings.Contains(body, `"choices"`) {
					t.Error("unknown native stop reason became a successful buffered response")
				}
				if response.Header.Get("x-request-id") != r.RequestID || !strings.Contains(body, r.RequestID) {
					t.Error("protocol failure lost the authoritative Gateway request identity")
				}
				assertAnthropicGatewayPrivacy(t, h, response, body, logs.String())
				facts, err := json.Marshal(struct {
					Captured []*FrozenRequest
					Terminal []*TerminalRecord
				}{h.store.CapturedRequests(), h.store.Requests()})
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(facts, []byte(reason)) || strings.Contains(logs.String(), reason) || strings.Contains(body, reason) || strings.Contains(fmt.Sprint(response.Header), reason) {
					t.Error("untrusted native stop reason escaped into response, facts, or logs")
				}
			})
		}
	}
}

func TestAnthropicOrdinaryStopReasonCompletionRemainsCompatible(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%t", streaming), func(t *testing.T) {
			h, calls, fallbackCalls := newAnthropicUsageHarness(t, anthropicGatewayInitialUsage, "", true)
			response := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil)
			body := anthropicGatewayRead(t, response)
			r := usageTotalSoleRecord(t, h, calls, fallbackCalls)
			if response.StatusCode != http.StatusOK || r.Status != string(OutcomeCompleted) || r.ErrorCode != "" || r.Attempts[0].Status != string(OutcomeCompleted) || r.Event.Status != string(OutcomeCompleted) || r.EventV2.Status != string(OutcomeCompleted) {
				t.Fatal("ordinary native stop lost successful completion")
			}
			if strings.Contains(body, `"error"`) || !strings.Contains(body, `"finish_reason":"stop"`) || strings.Count(body, "private-anthropic-content") != 1 || (streaming && strings.Count(body, "[DONE]") != 1) {
				t.Error("ordinary native stop changed public content or terminal behavior")
			}
			assertAnthropicGatewayUsage(t, r, anthropicGatewayKnownUsage(), false)
		})
	}
}
