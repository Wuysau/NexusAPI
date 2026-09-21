package provider

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestAnthropicThinkingBreakdownRegression(t *testing.T) {
	for _, value := range []int64{0, 7} {
		body := fmt.Sprintf(`{"usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":20,"output_tokens_details":{"thinking_tokens":%d}}}`, value)
		usage := NewAnthropic().ParseUsage(&ProviderResult{Body: []byte(body)})
		checkObserved(t, usage, ObservedUsage{InputTokens: observedInt(100), CachedInputTokens: observedInt(0), OutputTokens: observedInt(20), ReasoningTokens: observedInt(value)})
		stream := &anthropicStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader(fmt.Sprintf("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20,\"output_tokens_details\":{\"thinking_tokens\":%d}}}\n\ndata: {\"type\":\"message_stop\"}\n\n", value)))}
		checkObserved(t, finalObservedUsage(t, stream.Next), *usage.Observed)
	}
}

func observedInt(v int64) *int64 { return &v }
func checkObserved(t *testing.T, usage *CanonicalUsage, want ObservedUsage) {
	t.Helper()
	if usage == nil || usage.Observed == nil {
		t.Fatal("provider observations lost")
	}
	got := usage.Observed
	for i, pair := range [][2]*int64{{got.InputTokens, want.InputTokens}, {got.OutputTokens, want.OutputTokens}, {got.CachedInputTokens, want.CachedInputTokens}, {got.ReasoningTokens, want.ReasoningTokens}, {got.TotalTokens, want.TotalTokens}} {
		if (pair[0] == nil) != (pair[1] == nil) || (pair[0] != nil && *pair[0] != *pair[1]) {
			t.Fatalf("count %d presence/value mismatch", i)
		}
	}
}
func TestObservedNonStreamUsagePresence(t *testing.T) {
	cases := []struct {
		name    string
		adapter Adapter
		body    string
		want    ObservedUsage
	}{
		{"openai explicit zero", NewOpenAICompatible("openai", ""), `{"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}`, ObservedUsage{InputTokens: observedInt(0), OutputTokens: observedInt(0), TotalTokens: observedInt(0)}},
		{"openai unknown subsets total", NewOpenAICompatible("openai", ""), `{"usage":{"prompt_tokens":4,"completion_tokens":2}}`, ObservedUsage{InputTokens: observedInt(4), OutputTokens: observedInt(2)}},
		{"openai total only", NewOpenAICompatible("openai", ""), `{"usage":{"total_tokens":6}}`, ObservedUsage{TotalTokens: observedInt(6)}},
		{"gemini missing thoughts", NewGemini(), `{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}`, ObservedUsage{InputTokens: observedInt(4), TotalTokens: observedInt(6)}},
		{"gemini normalized output", NewGemini(), `{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"thoughtsTokenCount":3,"cachedContentTokenCount":0,"totalTokenCount":9}}`, ObservedUsage{InputTokens: observedInt(4), OutputTokens: observedInt(5), ReasoningTokens: observedInt(3), CachedInputTokens: observedInt(0), TotalTokens: observedInt(9)}},
		{"gemini explicit zero", NewGemini(), `{"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"thoughtsTokenCount":0}}`, ObservedUsage{InputTokens: observedInt(0), OutputTokens: observedInt(0), ReasoningTokens: observedInt(0)}},
		{"anthropic missing cache creation", NewAnthropic(), `{"usage":{"input_tokens":4,"cache_read_input_tokens":2,"output_tokens":0}}`, ObservedUsage{CachedInputTokens: observedInt(2), OutputTokens: observedInt(0)}},
		{"anthropic normalized input", NewAnthropic(), `{"usage":{"input_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":1}}`, ObservedUsage{InputTokens: observedInt(9), CachedInputTokens: observedInt(2), OutputTokens: observedInt(1)}},
		{"anthropic explicit zero", NewAnthropic(), `{"usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}`, ObservedUsage{InputTokens: observedInt(0), CachedInputTokens: observedInt(0), OutputTokens: observedInt(0)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkObserved(t, tc.adapter.ParseUsage(&ProviderResult{Body: []byte(tc.body)}), tc.want)
		})
	}
	for _, a := range []Adapter{NewOpenAICompatible("openai", ""), NewGemini(), NewAnthropic()} {
		for _, body := range []string{`{}`, `{"id":"response"}`, `{"usage":null,"usageMetadata":null}`} {
			u := a.ParseUsage(&ProviderResult{Body: []byte(body)})
			if u != nil && u.Observed != nil {
				t.Fatal("absent usage manufactured observations")
			}
		}
	}
}
func finalObservedUsage(t *testing.T, next func() (CanonicalChunk, error)) *CanonicalUsage {
	t.Helper()
	for {
		c, err := next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		if c.Done {
			return c.Usage
		}
	}
}
func TestObservedStreamingPartialPresence(t *testing.T) {
	t.Run("openai", func(t *testing.T) {
		stream := &openAIStream{reader: NewSSEReader(strings.NewReader("data: {\"usage\":{\"prompt_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\ndata: {\"usage\":{\"completion_tokens\":0}}\n\ndata: [DONE]\n\n"))}
		checkObserved(t, finalObservedUsage(t, stream.Next), ObservedUsage{InputTokens: observedInt(4), CachedInputTokens: observedInt(0), OutputTokens: observedInt(0)})
	})
	t.Run("gemini", func(t *testing.T) {
		stream := &geminiStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader("data: {\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":2}}\n\ndata: {\"usageMetadata\":{\"thoughtsTokenCount\":3,\"totalTokenCount\":9}}\n\n"))}
		checkObserved(t, finalObservedUsage(t, stream.Next), ObservedUsage{InputTokens: observedInt(4), OutputTokens: observedInt(5), ReasoningTokens: observedInt(3), TotalTokens: observedInt(9)})
	})
	t.Run("anthropic", func(t *testing.T) {
		stream := &anthropicStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4,\"cache_read_input_tokens\":2,\"cache_creation_input_tokens\":3}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":0}}\n\ndata: {\"type\":\"message_stop\"}\n\n"))}
		checkObserved(t, finalObservedUsage(t, stream.Next), ObservedUsage{InputTokens: observedInt(9), CachedInputTokens: observedInt(2), OutputTokens: observedInt(0)})
	})
}
func TestObservedUsagePreservesLegacyMissingDecision(t *testing.T) {
	for _, a := range []Adapter{NewOpenAICompatible("openai", ""), NewGemini(), NewAnthropic()} {
		u := a.ParseUsage(&ProviderResult{Body: []byte(`{"usage":{"input_tokens":0,"prompt_tokens":0,"output_tokens":0,"completion_tokens":0},"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0,"thoughtsTokenCount":0}}`)})
		if u == nil || !u.LegacyMissing || u.Observed == nil {
			t.Fatal("new observations must retain legacy estimate decision")
		}
	}
	openai := NewOpenAICompatible("openai", "").ParseUsage(&ProviderResult{Body: []byte(`{"id":"existing","usage":{"prompt_tokens":0,"completion_tokens":0}}`)})
	if openai.LegacyMissing {
		t.Fatal("existing zero-with-id v1 behavior changed")
	}
}

func TestObservedStreamingAbsentUsage(t *testing.T) {
	streams := []func() (CanonicalChunk, error){
		(&openAIStream{reader: NewSSEReader(strings.NewReader("data: [DONE]\n\n"))}).Next,
		(&geminiStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader(""))}).Next,
		(&anthropicStream{usage: &CanonicalUsage{}, reader: NewSSEReader(strings.NewReader("data: {\"type\":\"message_stop\"}\n\n"))}).Next,
	}
	for _, next := range streams {
		u := finalObservedUsage(t, next)
		if u != nil && u.Observed != nil {
			t.Fatal("absent stream usage manufactured observations")
		}
	}
}
