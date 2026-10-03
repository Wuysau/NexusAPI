package provider

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAnthropicStreamRejectsMalformedObservedUsageFields(t *testing.T) {
	for _, field := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "thinking_tokens"} {
		for _, malformed := range []struct{ name, value string }{
			{"fractional", "25.5"},
			{"wrong type", `"private-invalid-anthropic-usage"`},
			{"int64 overflow", "9223372036854775808"},
		} {
			t.Run(field+"/"+malformed.name, func(t *testing.T) {
				stream := anthropicUsageValidationStream(t, anthropicUsageValidationInitial, anthropicUsageValidationMalformed(field, malformed.value), true)
				anthropicUsageValidationReadFirst(t, stream, anthropicUsageValidationPrior())
				// A later valid partial delta must not turn a malformed event
				// into a successful completion with stale observed usage.
				anthropicUsageValidationReject(t, stream, anthropicUsageValidationPrior())
			})
		}
	}
}

func TestAnthropicMalformedUsagePreservesObservationBoundaries(t *testing.T) {
	partial := `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}`
	partialObserved := &ObservedUsage{Semantics: "anthropic-inclusive-v1", OutputTokens: observedInt(2), CachedInputTokens: observedInt(1), ReasoningTokens: observedInt(0)}
	for _, tc := range []struct {
		name, first, field, value string
		recovery                  bool
		want                      *ObservedUsage
	}{
		{"direct terminal", anthropicUsageValidationInitial, "cache_creation_input_tokens", "25.5", false, anthropicUsageValidationPrior()},
		{"partial prior cache creation", partial, "cache_creation_input_tokens", `"private-invalid-anthropic-usage"`, true, partialObserved},
		{"partial prior thinking", partial, "thinking_tokens", "9223372036854775808", true, partialObserved},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := anthropicUsageValidationStream(t, tc.first, anthropicUsageValidationMalformed(tc.field, tc.value), tc.recovery)
			anthropicUsageValidationReadFirst(t, stream, tc.want)
			anthropicUsageValidationReject(t, stream, tc.want)
		})
	}
}

func TestAnthropicMalformedInitialUsageHasNoObservations(t *testing.T) {
	for _, field := range []string{"cache_creation_input_tokens", "thinking_tokens"} {
		for _, malformed := range []struct{ name, value string }{
			{"fractional", "25.5"},
			{"wrong type", `"private-invalid-anthropic-usage"`},
			{"int64 overflow", "9223372036854775808"},
		} {
			t.Run(field+"/"+malformed.name, func(t *testing.T) {
				// The sole message_start is malformed, so no earlier usage
				// can certify counts or justify exposing the first content.
				stream := anthropicUsageValidationStream(t, anthropicUsageValidationMalformed(field, malformed.value), `{"output_tokens":2}`, false)
				anthropicUsageValidationReject(t, stream, nil)
			})
		}
	}
}

func TestAnthropicExistingUsageTypeGuardsRemain(t *testing.T) {
	for _, tc := range []struct {
		name, field, value string
		initial            bool
	}{
		{"initial input fractional", "input_tokens", "25.5", true},
		{"initial output wrong type", "output_tokens", `"private-invalid-anthropic-usage"`, true},
		{"initial cache read overflow", "cache_read_input_tokens", "9223372036854775808", true},
		{"delta output overflow", "output_tokens", "9223372036854775808", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first, later := anthropicUsageValidationInitial, anthropicUsageValidationMalformed(tc.field, tc.value)
			want := anthropicUsageValidationPrior()
			if tc.initial {
				first, later = later, `{"output_tokens":2}`
				want = nil
			}
			stream := anthropicUsageValidationStream(t, first, later, false)
			if !tc.initial {
				anthropicUsageValidationReadFirst(t, stream, want)
			}
			anthropicUsageValidationReject(t, stream, want)
		})
	}
}

func TestAnthropicStreamUsageFieldCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, first, later  string
		want                *ObservedUsage
		legacyOutput        int
		legacyInputAndCache bool
	}{
		{"updated integers", anthropicUsageValidationInitial, `{"input_tokens":4,"output_tokens":20,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens_details":{"thinking_tokens":1}}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", InputTokens: observedInt(9), OutputTokens: observedInt(20), CachedInputTokens: observedInt(2), CacheCreationInputTokens: observedInt(3), ReasoningTokens: observedInt(1)}, 20, true},
		{"observed zero", anthropicUsageValidationInitial, `{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens_details":{"thinking_tokens":0}}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", InputTokens: observedInt(0), OutputTokens: observedInt(0), CachedInputTokens: observedInt(0), CacheCreationInputTokens: observedInt(0), ReasoningTokens: observedInt(0)}, 0, true},
		{"null counters", anthropicUsageValidationInitial, `{"input_tokens":null,"output_tokens":null,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"output_tokens_details":{"thinking_tokens":null}}`, anthropicUsageValidationPrior(), 0, true},
		{"absent usage", anthropicUsageValidationInitial, "", anthropicUsageValidationPrior(), 0, true},
		{"null usage", anthropicUsageValidationInitial, "null", anthropicUsageValidationPrior(), 0, true},
		{"empty usage", anthropicUsageValidationInitial, `{}`, anthropicUsageValidationPrior(), 0, true},
		{"partial update", anthropicUsageValidationInitial, `{"output_tokens":20}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", InputTokens: observedInt(5), OutputTokens: observedInt(20), CachedInputTokens: observedInt(1), CacheCreationInputTokens: observedInt(1), ReasoningTokens: observedInt(0)}, 20, true},
		{"missing initial cache creation", `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}`, `{"output_tokens":2}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", OutputTokens: observedInt(2), CachedInputTokens: observedInt(1), ReasoningTokens: observedInt(0)}, 2, true},
		{"missing initial thinking", `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}`, `{"output_tokens":2}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", InputTokens: observedInt(5), OutputTokens: observedInt(2), CachedInputTokens: observedInt(1), CacheCreationInputTokens: observedInt(1)}, 2, true},
		// Negative integers remain decoded facts for Gateway's semantic guards.
		{"negative integers", anthropicUsageValidationInitial, `{"input_tokens":-3,"output_tokens":-2,"cache_read_input_tokens":-1,"cache_creation_input_tokens":-1,"output_tokens_details":{"thinking_tokens":-1}}`, &ObservedUsage{Semantics: "anthropic-inclusive-v1", OutputTokens: observedInt(-2), CachedInputTokens: observedInt(-1), CacheCreationInputTokens: observedInt(-1), ReasoningTokens: observedInt(-1)}, -2, true},
		{"absent initial observations", "null", "", nil, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := anthropicUsageValidationStream(t, tc.first, tc.later, false)
			first, err := stream.Next()
			if err != nil || first.Done || first.Text != "private-anthropic-content" {
				t.Fatalf("optional/integer initial usage changed native content: done=%t error=%v", first.Done, err)
			}
			finish, err := stream.Next()
			if err != nil || finish.Done || finish.FinishReason != "stop" {
				t.Fatalf("optional/integer delta changed native finish: done=%t finish=%q error=%v", finish.Done, finish.FinishReason, err)
			}
			terminal, err := stream.Next()
			if err != nil || !terminal.Done {
				t.Fatalf("optional/integer usage changed native message_stop: done=%t error=%v", terminal.Done, err)
			}
			anthropicUsageValidationAssertObserved(t, terminal.Usage, tc.want)
			if terminal.Usage == nil {
				return
			}
			wantInput, wantCache := 0, 0
			if tc.legacyInputAndCache {
				wantInput, wantCache = 3, 1
			}
			// Top delta input/cache facts have never overwritten the legacy
			// message_start assignments; typed validation preserves this.
			if terminal.Usage.InputTokens != wantInput || terminal.Usage.CachedInputTokens != wantCache || terminal.Usage.OutputTokens != tc.legacyOutput || terminal.Usage.ProviderRequestID != "anthropic-usage-provider-request" {
				t.Error("legacy native usage assignments or provider attribution changed")
			}
		})
	}
}

const anthropicUsageValidationInitial = `{"input_tokens":3,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}`

func anthropicUsageValidationPrior() *ObservedUsage {
	return &ObservedUsage{Semantics: "anthropic-inclusive-v1", InputTokens: observedInt(5), OutputTokens: observedInt(2), CachedInputTokens: observedInt(1), CacheCreationInputTokens: observedInt(1), ReasoningTokens: observedInt(0)}
}

func anthropicUsageValidationMalformed(field, value string) string {
	input, output, cacheRead, cacheCreation, thinking := "30", "2", "2", "3", "1"
	switch field {
	case "input_tokens":
		input = value
	case "output_tokens":
		output = value
	case "cache_read_input_tokens":
		cacheRead = value
	case "cache_creation_input_tokens":
		cacheCreation = value
	case "thinking_tokens":
		thinking = value
	}
	return fmt.Sprintf(`{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"output_tokens_details":{"thinking_tokens":%s}}`, input, output, cacheRead, cacheCreation, thinking)
}

func anthropicUsageValidationStream(t *testing.T, firstUsage, laterUsage string, recovery bool) *anthropicStream {
	t.Helper()
	var wire strings.Builder
	emit := func(name, payload string) { fmt.Fprintf(&wire, "event: %s\ndata: %s\n\n", name, payload) }
	emit("message_start", fmt.Sprintf(`{"type":"message_start","message":{"id":"anthropic-usage-provider-request","type":"message","role":"assistant","model":"anthropic-usage-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":%s}}`, firstUsage))
	emit("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
	emit("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"private-anthropic-content"}}`)
	emit("content_block_stop", `{"type":"content_block_stop","index":0}`)
	stopReason := `"end_turn"`
	if recovery {
		stopReason = "null"
	}
	later := fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":%s,"stop_sequence":null}`, stopReason)
	if laterUsage != "" {
		later += `,"usage":` + laterUsage
	}
	emit("message_delta", later+"}")
	if recovery {
		emit("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`)
	}
	emit("message_stop", `{"type":"message_stop"}`)
	body := io.NopCloser(strings.NewReader(wire.String()))
	stream := &anthropicStream{resp: &http.Response{Body: body}, reader: NewSSEReader(body), usage: &CanonicalUsage{}}
	t.Cleanup(func() {
		if err := stream.Close(); err != nil {
			t.Errorf("close native usage fixture: %v", err)
		}
	})
	return stream
}

func anthropicUsageValidationReadFirst(t *testing.T, stream *anthropicStream, want *ObservedUsage) {
	t.Helper()
	first, err := stream.Next()
	if err != nil || first.Done || first.Text != "private-anthropic-content" {
		t.Fatalf("valid first native usage/content changed: done=%t error=%v", first.Done, err)
	}
	anthropicUsageValidationAssertObserved(t, stream.usage, want)
}

func anthropicUsageValidationReject(t *testing.T, stream *anthropicStream, want *ObservedUsage) {
	t.Helper()
	before, beforeID := *stream.usage, stream.providerRequestID
	chunk, err := stream.Next()
	if err == nil {
		t.Errorf("malformed native usage accepted: done=%t finish=%q", chunk.Done, chunk.FinishReason)
		return
	}
	if chunk.Done || chunk.FinishReason != "" || chunk.Text != "" {
		t.Error("malformed usage exposed content or successful completion")
	}
	if err.Error() != "anthropic: malformed stream event" {
		t.Errorf("protocol error must be static and generic: %v", err)
	}
	anthropicUsageValidationAssertObserved(t, chunk.Usage, want)
	if chunk.Usage != nil && (chunk.Usage.InputTokens != before.InputTokens || chunk.Usage.CachedInputTokens != before.CachedInputTokens || chunk.Usage.OutputTokens != before.OutputTokens || chunk.Usage.ReasoningTokens != before.ReasoningTokens || chunk.Usage.Estimated != before.Estimated || chunk.Usage.LegacyMissing != before.LegacyMissing || chunk.Usage.ProviderRequestID != before.ProviderRequestID || stream.providerRequestID != beforeID) {
		t.Error("malformed usage mutated legacy counts or provider attribution")
	}
}

func anthropicUsageValidationAssertObserved(t *testing.T, usage *CanonicalUsage, want *ObservedUsage) {
	t.Helper()
	if usage == nil {
		t.Error("native canonical usage lost")
		return
	}
	got := usage.Observed
	if want == nil {
		if got != nil {
			t.Error("usage before reliable observation invented counts")
		}
		return
	}
	if got == nil {
		t.Error("prior native observed usage lost")
		return
	}
	if got.Semantics != want.Semantics {
		t.Error("native observed usage semantics changed")
	}
	for _, count := range []struct {
		name      string
		got, want *int64
	}{
		{"input", got.InputTokens, want.InputTokens},
		{"output", got.OutputTokens, want.OutputTokens},
		{"cache_read", got.CachedInputTokens, want.CachedInputTokens},
		{"cache_creation", got.CacheCreationInputTokens, want.CacheCreationInputTokens},
		{"thinking", got.ReasoningTokens, want.ReasoningTokens},
		{"total", got.TotalTokens, want.TotalTokens},
	} {
		if (count.got == nil) != (count.want == nil) || (count.got != nil && count.want != nil && *count.got != *count.want) {
			t.Errorf("native observed %s presence/value changed", count.name)
		}
	}
}
