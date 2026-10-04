package provider

import (
	"fmt"
	"testing"
)

func TestGeminiSafetyFinishCompatibility(t *testing.T) {
	for _, tc := range []struct{ reason, finish, text string }{
		{"SAFETY", "content_filter", "private-gemini-safety-content"},
		{"SAFETY", "content_filter", ""},
		{"STOP", "stop", "ordinary"},
		{"MAX_TOKENS", "length", "partial"},
		{"RECITATION", "stop", "existing projection"},
		{"MALFORMED_RESPONSE", "stop", "existing projection"},
	} {
		t.Run(fmt.Sprintf("%s/text=%t", tc.reason, tc.text != ""), func(t *testing.T) {
			frame := fmt.Sprintf(`{"candidates":[{"content":{"parts":[{"text":%q}]},"finishReason":%q}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":0,"cachedContentTokenCount":null,"totalTokenCount":null}}`, tc.text, tc.reason)
			chunks := drain(t, testProtocolStream("gemini", "data: "+frame+"\n\n"))
			if len(chunks) != 2 || chunks[0].Text != tc.text || chunks[0].Done || !chunks[1].Done || chunks[0].Refusal != nil {
				t.Fatal("known finish changed content, invented refusal, or lost successful protocol completion")
			}
			checkObserved(t, chunks[1].Usage, ObservedUsage{InputTokens: observedInt(5), OutputTokens: observedInt(2), ReasoningTokens: observedInt(0)})
			if got := chunks[0].FinishReason; got != tc.finish {
				t.Errorf("finish projection = %q, want %q", got, tc.finish)
			}
		})
	}
}
