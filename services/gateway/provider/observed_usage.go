package provider

import (
	"encoding/json"
	"math"
)

// mergeObserved preserves earlier cumulative observations when a later stream
// frame omits them. A reported zero replaces the earlier value.
func mergeObserved(old, next *ObservedUsage) *ObservedUsage {
	if old == nil {
		return next
	}
	if next == nil {
		return old
	}
	out := *old
	for _, p := range [][2]**int64{{&out.InputTokens, &next.InputTokens}, {&out.OutputTokens, &next.OutputTokens}, {&out.CachedInputTokens, &next.CachedInputTokens}, {&out.ReasoningTokens, &next.ReasoningTokens}, {&out.TotalTokens, &next.TotalTokens}} {
		if *p[1] != nil {
			*p[0] = *p[1]
		}
	}
	return &out
}

// Sum only complete, nonnegative provider components. Missing is never zero.
func observedSum(values ...*int64) *int64 {
	var total int64
	for _, v := range values {
		if v == nil || *v < 0 || *v > math.MaxInt64-total {
			return nil
		}
		total += *v
	}
	return &total
}

func observeOpenAI(raw []byte) *ObservedUsage {
	var body struct {
		Usage *struct {
			Input         *int64 `json:"prompt_tokens"`
			Output        *int64 `json:"completion_tokens"`
			Total         *int64 `json:"total_tokens"`
			PromptDetails struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			OutputDetails struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Usage == nil {
		return nil
	}
	u := body.Usage
	return &ObservedUsage{InputTokens: u.Input, OutputTokens: u.Output, TotalTokens: u.Total, CachedInputTokens: u.PromptDetails.Cached, ReasoningTokens: u.OutputDetails.Reasoning}
}

type geminiObservedWire struct {
	Input      *int64 `json:"promptTokenCount"`
	Candidates *int64 `json:"candidatesTokenCount"`
	Cached     *int64 `json:"cachedContentTokenCount"`
	Thoughts   *int64 `json:"thoughtsTokenCount"`
	Total      *int64 `json:"totalTokenCount"`
}

func observeGemini(raw []byte, previous **geminiObservedWire) *ObservedUsage {
	var body struct {
		Usage *geminiObservedWire `json:"usageMetadata"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	if body.Usage != nil {
		if *previous == nil {
			*previous = &geminiObservedWire{}
		}
		u, next := *previous, body.Usage
		for _, p := range [][2]**int64{{&u.Input, &next.Input}, {&u.Candidates, &next.Candidates}, {&u.Cached, &next.Cached}, {&u.Thoughts, &next.Thoughts}, {&u.Total, &next.Total}} {
			if *p[1] != nil {
				*p[0] = *p[1]
			}
		}
	}
	if *previous == nil {
		return nil
	}
	u := *previous
	// Gemini total includes prompt + thoughts + response candidates. Canonical
	// output includes reasoning, unlike candidatesTokenCount alone.
	// https://ai.google.dev/api/generate-content#UsageMetadata
	return &ObservedUsage{InputTokens: u.Input, OutputTokens: observedSum(u.Candidates, u.Thoughts), CachedInputTokens: u.Cached, ReasoningTokens: u.Thoughts, TotalTokens: u.Total}
}

type anthropicObservedWire struct {
	Input         *int64 `json:"input_tokens"`
	Output        *int64 `json:"output_tokens"`
	CacheRead     *int64 `json:"cache_read_input_tokens"`
	CacheCreation *int64 `json:"cache_creation_input_tokens"`
	OutputDetails struct {
		Thinking *int64 `json:"thinking_tokens"`
	} `json:"output_tokens_details"`
}

func observeAnthropic(raw []byte, previous **anthropicObservedWire) *ObservedUsage {
	var body struct {
		Usage   *anthropicObservedWire `json:"usage"`
		Message *struct {
			Usage *anthropicObservedWire `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	next := body.Usage
	if body.Message != nil && body.Message.Usage != nil {
		next = body.Message.Usage
	}
	if next != nil {
		if *previous == nil {
			*previous = &anthropicObservedWire{}
		}
		u := *previous
		for _, p := range [][2]**int64{{&u.Input, &next.Input}, {&u.Output, &next.Output}, {&u.CacheRead, &next.CacheRead}, {&u.CacheCreation, &next.CacheCreation}, {&u.OutputDetails.Thinking, &next.OutputDetails.Thinking}} {
			if *p[1] != nil {
				*p[0] = *p[1]
			}
		}
	}
	if *previous == nil {
		return nil
	}
	u := *previous
	// Anthropic input_tokens excludes both cache buckets. Only a complete set
	// proves the canonical primary count. Thinking is an optional output subset.
	// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
	return &ObservedUsage{Semantics: "anthropic-inclusive-v1", CacheCreationInputTokens: u.CacheCreation, InputTokens: observedSum(u.Input, u.CacheRead, u.CacheCreation), OutputTokens: u.Output, CachedInputTokens: u.CacheRead, ReasoningTokens: u.OutputDetails.Thinking}
}
