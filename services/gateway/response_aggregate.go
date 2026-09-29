package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"nexus/gateway/provider"
)

const defaultMaxResponseBytes = 16 << 20

type toolDelta struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func parseToolDeltas(raw json.RawMessage) ([]toolDelta, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, errors.New("invalid upstream tool delta")
	}
	var deltas []toolDelta
	if len(raw) > defaultMaxResponseBytes || raw[0] != '[' || json.Unmarshal(raw, &deltas) != nil {
		return nil, errors.New("invalid upstream tool delta")
	}
	for _, d := range deltas {
		if d.Index < 0 || d.Index >= 1024 || (d.Type != "" && d.Type != "function") {
			return nil, errors.New("invalid upstream tool index or type")
		}
	}
	return deltas, nil
}

type aggregateTool struct{ id, name, arguments strings.Builder }

type responseAggregate struct {
	text, reasoning, refusal strings.Builder
	refusalSeen              bool
	tools                    map[int]*aggregateTool
	size, limit              int
}

func (a *responseAggregate) add(c provider.CanonicalChunk, deltas []toolDelta) error {
	size := len(c.Text) + len(c.Reasoning)
	if c.Refusal != nil {
		size += len(*c.Refusal)
	}
	for _, d := range deltas {
		size += len(d.ID) + len(d.Function.Name) + len(d.Function.Arguments) + len(d.Type)
	}
	if a.limit <= 0 {
		a.limit = defaultMaxResponseBytes
	}
	if size > a.limit-a.size {
		return errors.New("upstream response exceeds aggregation limit")
	}
	a.size += size
	a.text.WriteString(c.Text)
	a.reasoning.WriteString(c.Reasoning)
	if c.Refusal != nil {
		a.refusalSeen = true
		a.refusal.WriteString(*c.Refusal)
	}
	for _, d := range deltas {
		if a.tools == nil {
			a.tools = make(map[int]*aggregateTool)
		}
		t := a.tools[d.Index]
		if t == nil {
			t = &aggregateTool{}
			a.tools[d.Index] = t
		}
		t.id.WriteString(d.ID)
		t.name.WriteString(d.Function.Name)
		t.arguments.WriteString(d.Function.Arguments)
	}
	return nil
}
func (a *responseAggregate) message() map[string]any {
	m := map[string]any{"role": "assistant", "content": a.text.String()}
	if a.reasoning.Len() > 0 {
		m["reasoning_content"] = a.reasoning.String()
	}
	if a.refusalSeen {
		m["refusal"] = a.refusal.String()
		if a.text.Len() == 0 {
			m["content"] = nil
		}
	}
	if len(a.tools) > 0 {
		if a.text.Len() == 0 {
			m["content"] = nil
		}
		indexes := make([]int, 0, len(a.tools))
		for i := range a.tools {
			indexes = append(indexes, i)
		}
		sort.Ints(indexes)
		calls := make([]map[string]any, 0, len(indexes))
		for _, i := range indexes {
			t := a.tools[i]
			calls = append(calls, map[string]any{"id": t.id.String(), "type": "function", "function": map[string]string{"name": t.name.String(), "arguments": t.arguments.String()}})
		}
		m["tool_calls"] = calls
	}
	return m
}

// Missing provider counters stay null; totals are not fabricated from partial usage.
func chatUsage(u *provider.CanonicalUsage) map[string]any {
	if u.Observed != nil {
		o := u.Observed
		return map[string]any{"prompt_tokens": o.InputTokens, "completion_tokens": o.OutputTokens, "total_tokens": o.TotalTokens, "prompt_tokens_details": map[string]any{"cached_tokens": o.CachedInputTokens}, "completion_tokens_details": map[string]any{"reasoning_tokens": o.ReasoningTokens}}
	}
	return map[string]any{"prompt_tokens": u.InputTokens, "completion_tokens": u.OutputTokens, "total_tokens": u.InputTokens + u.OutputTokens}
}
