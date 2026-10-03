package provider

import (
	"fmt"
	"strings"
	"testing"
)

func TestOpenAIStreamRejectsMalformedTotalTokens(t *testing.T) {
	for _, tc := range []struct{ name, total string }{
		{"fractional", "25.5"},
		{"wrong type", `"private-invalid-total"`},
		{"int64 overflow", "9223372036854775808"},
	} {
		for _, partial := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/partial=%t", tc.name, partial), func(t *testing.T) {
				firstUsage := `{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}`
				want := ObservedUsage{InputTokens: observedInt(5), OutputTokens: observedInt(2), TotalTokens: observedInt(7), CachedInputTokens: observedInt(0), ReasoningTokens: observedInt(0)}
				if partial {
					firstUsage = `{"prompt_tokens":5}`
					want = ObservedUsage{InputTokens: observedInt(5)}
				}
				later := fmt.Sprintf(`{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":20,"total_tokens":%s,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}`, tc.total)
				stream := totalValidationStream(firstUsage, later)
				first, err := stream.Next()
				if err != nil || first.Text != "private-usage-content" {
					t.Fatalf("valid first frame: %+v %v", first, err)
				}
				final, err := stream.Next()
				checkObserved(t, final.Usage, want)
				if err == nil || final.Done {
					t.Fatalf("malformed total completed with stale observations: done=%t error=%v", final.Done, err)
				}
				if err.Error() != "openai: malformed or failed stream chunk" {
					t.Fatalf("provider details entered protocol error: %v", err)
				}
			})
		}
	}
}

func TestOpenAIStreamTotalTokensCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, later          string
		input, output, total int64
	}{
		{"updated integer", `{"usage":{"prompt_tokens":5,"completion_tokens":20,"total_tokens":25}}`, 5, 20, 25},
		{"absent usage", `{"choices":[]}`, 5, 2, 7},
		{"null usage", `{"usage":null}`, 5, 2, 7},
		{"empty usage", `{"usage":{}}`, 5, 2, 7},
		{"absent total", `{"usage":{"prompt_tokens":5,"completion_tokens":2}}`, 5, 2, 7},
		{"null counters", `{"usage":{"prompt_tokens":null,"completion_tokens":null,"total_tokens":null,"prompt_tokens_details":{"cached_tokens":null},"completion_tokens_details":{"reasoning_tokens":null}}}`, 5, 2, 7},
		{"partial update", `{"usage":{"completion_tokens":20,"total_tokens":25}}`, 5, 20, 25},
		{"observed zero", `{"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`, 0, 0, 0},
		// Negative integers remain decoded observations for Gateway's existing
		// semantic validation; this repair changes malformed field types only.
		{"negative integer", `{"usage":{"total_tokens":-1}}`, 5, 2, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := totalValidationStream(`{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}`, tc.later)
			if _, err := stream.Next(); err != nil {
				t.Fatal(err)
			}
			final, err := stream.Next()
			if err != nil || !final.Done {
				t.Fatalf("optional/integer usage changed: %+v %v", final, err)
			}
			checkObserved(t, final.Usage, ObservedUsage{InputTokens: observedInt(tc.input), OutputTokens: observedInt(tc.output), TotalTokens: observedInt(tc.total), CachedInputTokens: observedInt(0), ReasoningTokens: observedInt(0)})
		})
	}
	for _, frame := range []string{`{"choices":[]}`, `{"usage":null}`} {
		stream := &openAIStream{reader: NewSSEReader(strings.NewReader("data: " + frame + "\n\ndata: [DONE]\n\n"))}
		final, err := stream.Next()
		if err != nil || !final.Done || final.Usage != nil {
			t.Fatalf("absent initial usage invented counts: %+v %v", final, err)
		}
	}
}

func totalValidationStream(firstUsage, later string) *openAIStream {
	wire := "data: " + `{"choices":[{"delta":{"content":"private-usage-content"}}],"usage":` + firstUsage + "}\n\ndata: " + later + "\n\ndata: [DONE]\n\n"
	return &openAIStream{reader: NewSSEReader(strings.NewReader(wire))}
}
