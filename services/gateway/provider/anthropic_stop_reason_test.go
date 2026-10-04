package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestAnthropicUnknownStopReasonPreservesUsage(t *testing.T) {
	for _, reason := range []string{"NOT_A_FINISH", "private-anthropic-stop-reason"} {
		for _, updateUsage := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/update_usage=%t", reason, updateUsage), func(t *testing.T) {
				encodedReason, _ := json.Marshal(reason)
				delta := `{"type":"message_delta","delta":{"stop_reason":` + string(encodedReason) + `}`
				want := anthropicUsageValidationPrior()
				// message_start supplies authoritative ObservedUsage output; the
				// existing legacy counter is assigned only by message_delta.
				legacyOutput := 0
				if updateUsage {
					delta += `,"usage":{"output_tokens":7}`
					want.OutputTokens = observedInt(7)
					legacyOutput = 7
				}
				delta += `}`
				// A later ordinary ending must not erase an invalid earlier reason.
				stream := testProtocolStream("anthropic", anthropicStopReasonWire(delta,
					`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`))
				first, err := stream.Next()
				if err != nil || first.Done || first.Text != "private-anthropic-content" {
					t.Fatal("valid content before the unknown reason was not accepted")
				}
				chunk, err := stream.Next()
				if err == nil || err == io.EOF {
					t.Fatalf("unknown stop reason accepted: finish=%q done=%t error=%v", chunk.FinishReason, chunk.Done, err)
				}
				if err.Error() != "anthropic: invalid stop reason" {
					t.Error("invalid stop reason must produce a static content-free protocol error")
				}
				if chunk.Done || chunk.FinishReason != "" || chunk.Text != "" || chunk.Reasoning != "" || chunk.Refusal != nil || len(chunk.ToolCallDelta) != 0 {
					t.Error("invalid reason exposed a successful terminal or unrelated content")
				}
				anthropicUsageValidationAssertObserved(t, chunk.Usage, want)
				if chunk.Usage != nil && (chunk.Usage.InputTokens != 3 || chunk.Usage.OutputTokens != legacyOutput || chunk.Usage.CachedInputTokens != 1 || chunk.Usage.Estimated || chunk.Usage.LegacyMissing) {
					t.Error("unknown stop reason discarded or fabricated legacy usage evidence")
				}
			})
		}
	}
}

func TestAnthropicKnownStopReasonsRemainCompatible(t *testing.T) {
	// All seven documented reasons remain accepted. Context-window exhaustion
	// is valid truncation; classifier refusals are filtered, while pause stays compatible.
	// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
	for _, tc := range []struct{ reason, finish string }{
		{"end_turn", "stop"},
		{"stop_sequence", "stop"},
		{"max_tokens", "length"},
		{"tool_use", "tool_calls"},
		{"pause_turn", "stop"},
		{"refusal", "content_filter"},
		{"model_context_window_exceeded", "length"},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			delta := `{"type":"message_delta","delta":{"stop_reason":"` + tc.reason + `"},"usage":{"output_tokens":7}}`
			chunks := drain(t, testProtocolStream("anthropic", anthropicStopReasonWire(delta)))
			if len(chunks) != 3 || chunks[0].Text != "private-anthropic-content" || chunks[1].FinishReason != tc.finish || !chunks[2].Done {
				t.Fatal("known stop reason lost its existing content, finish mapping, or completion")
			}
			want := anthropicUsageValidationPrior()
			want.OutputTokens = observedInt(7)
			anthropicUsageValidationAssertObserved(t, chunks[2].Usage, want)
		})
	}
}

func TestAnthropicAbsentStopReasonRemainsCompatible(t *testing.T) {
	for _, tc := range []struct{ name, delta string }{
		{"message_stop_only", ""},
		{"missing_delta", `{"type":"message_delta"}`},
		{"missing_reason", `{"type":"message_delta","delta":{}}`},
		{"null_reason", `{"type":"message_delta","delta":{"stop_reason":null}}`},
		{"empty_reason", `{"type":"message_delta","delta":{"stop_reason":""}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chunks := drain(t, testProtocolStream("anthropic", anthropicStopReasonWire(tc.delta)))
			if len(chunks) != 2 || chunks[0].Text != "private-anthropic-content" || !chunks[1].Done || chunks[1].FinishReason != "" {
				t.Fatal("optional stop reason changed message_stop compatibility")
			}
			anthropicUsageValidationAssertObserved(t, chunks[1].Usage, anthropicUsageValidationPrior())
		})
	}
}

func anthropicStopReasonWire(deltas ...string) string {
	frames := []string{
		`{"type":"message_start","message":{"usage":` + anthropicUsageValidationInitial + `}}`,
		`{"type":"content_block_delta","delta":{"type":"text_delta","text":"private-anthropic-content"}}`,
	}
	for _, delta := range deltas {
		if delta != "" {
			frames = append(frames, delta)
		}
	}
	frames = append(frames, `{"type":"message_stop"}`)
	return "data: " + strings.Join(frames, "\n\ndata: ") + "\n\n"
}
