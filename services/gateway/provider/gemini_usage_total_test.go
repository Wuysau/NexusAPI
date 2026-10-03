package provider

import (
	"fmt"
	"strings"
	"testing"
)

func TestGeminiStreamRejectsMalformedTotalTokenCount(t *testing.T) {
	for _, tc := range []struct{ name, total string }{
		{"fractional", "25.5"},
		{"wrong type", `"private-invalid-gemini-total"`},
		{"int64 overflow", "9223372036854775808"},
	} {
		for _, observed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/priorObserved=%t", tc.name, observed), func(t *testing.T) {
				firstUsage := ""
				if observed {
					firstUsage = geminiTotalInitialUsage
				}
				later := fmt.Sprintf(`{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":%s}}`, tc.total)
				stream := geminiUsageTotalStream(firstUsage, later, true)
				if first, err := stream.Next(); err != nil || first.Text != "private-gemini-content" {
					t.Fatalf("valid first frame changed: %+v %v", first, err)
				}
				final, err := geminiUsageTotalTerminal(stream)
				if err == nil || final.Done {
					t.Errorf("malformed total survived a later partial frame: done=%t error=%v", final.Done, err)
				} else if err.Error() != "gemini: malformed stream chunk" {
					t.Errorf("provider details entered protocol error: %v", err)
				}
				if observed {
					checkObserved(t, final.Usage, geminiTotalInitialObserved())
				} else if final.Usage == nil || final.Usage.Observed != nil {
					t.Fatal("invalid usage invented observations before any reliable usage")
				}
			})
		}
	}
}

func TestGeminiMalformedTotalRetainsEvidenceBeforeDirectTerminal(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprintf("partial=%t", partial), func(t *testing.T) {
			firstUsage := geminiTotalInitialUsage
			want := geminiTotalInitialObserved()
			if partial {
				firstUsage = `{"promptTokenCount":5}`
				want = ObservedUsage{InputTokens: observedInt(5)}
			}
			stream := geminiUsageTotalStream(firstUsage, `{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"totalTokenCount":25.5}}`, false)
			if _, err := stream.Next(); err != nil {
				t.Fatal(err)
			}
			final, err := geminiUsageTotalTerminal(stream)
			if err == nil || final.Done {
				t.Errorf("malformed total before direct terminal completed: done=%t error=%v", final.Done, err)
			}
			checkObserved(t, final.Usage, want)
		})
	}
}

func TestGeminiStreamTotalTokenCountCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, later   string
		output, total int64
	}{
		{"updated integer", `{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":20,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":25}}`, 20, 25},
		{"negative integer", `{"usageMetadata":{"totalTokenCount":-1}}`, 2, -1},
		{"absent metadata", `{"candidates":[]}`, 2, 7},
		{"null metadata", `{"usageMetadata":null}`, 2, 7},
		{"absent total", `{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}`, 2, 7},
		{"null counters", `{"usageMetadata":{"promptTokenCount":null,"candidatesTokenCount":null,"thoughtsTokenCount":null,"cachedContentTokenCount":null,"totalTokenCount":null}}`, 2, 7},
		{"partial update", `{"usageMetadata":{"candidatesTokenCount":20,"totalTokenCount":25}}`, 20, 25},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := geminiUsageTotalStream(geminiTotalInitialUsage, tc.later, true)
			if _, err := stream.Next(); err != nil {
				t.Fatal(err)
			}
			final, err := geminiUsageTotalTerminal(stream)
			if err != nil || !final.Done {
				t.Fatalf("optional/integer usage changed: %+v %v", final, err)
			}
			checkObserved(t, final.Usage, ObservedUsage{InputTokens: observedInt(5), OutputTokens: observedInt(tc.output), TotalTokens: observedInt(tc.total), CachedInputTokens: observedInt(0), ReasoningTokens: observedInt(0)})
		})
	}
	for _, later := range []string{`{"candidates":[]}`, `{"usageMetadata":null}`} {
		stream := geminiUsageTotalStream("", later, false)
		if _, err := stream.Next(); err != nil {
			t.Fatal(err)
		}
		final, err := geminiUsageTotalTerminal(stream)
		if err != nil || !final.Done || final.Usage == nil || final.Usage.Observed != nil {
			t.Fatalf("absent initial usage invented observations: %+v %v", final, err)
		}
	}
}

const geminiTotalInitialUsage = `{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":0,"totalTokenCount":7}`

func geminiTotalInitialObserved() ObservedUsage {
	return ObservedUsage{InputTokens: observedInt(5), OutputTokens: observedInt(2), TotalTokens: observedInt(7), CachedInputTokens: observedInt(0), ReasoningTokens: observedInt(0)}
}

func geminiUsageTotalStream(firstUsage, later string, recovery bool) *geminiStream {
	first := `{"candidates":[{"content":{"parts":[{"text":"private-gemini-content"}]}}]`
	if firstUsage != "" {
		first += `,"usageMetadata":` + firstUsage
	}
	first += "}"
	last := `{"candidates":[{"finishReason":"STOP"}]}`
	if recovery {
		last = `{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5}}`
	}
	return &geminiStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader("data: " + first + "\n\ndata: " + later + "\n\ndata: " + last + "\n\n"))}
}

func geminiUsageTotalTerminal(stream *geminiStream) (CanonicalChunk, error) {
	for i := 0; i < 4; i++ {
		chunk, err := stream.Next()
		if err != nil || chunk.Done {
			return chunk, err
		}
	}
	return CanonicalChunk{}, fmt.Errorf("fixture had no terminal")
}
