package provider

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

type countingSSEReader struct {
	io.Reader
	read int
}

func (r *countingSSEReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.read += n
	return n, err
}

func TestSSERejectsOversizedInputDuringRead(t *testing.T) {
	for _, prefix := range []string{"data: ", ":", "unknown: "} {
		t.Run(prefix, func(t *testing.T) {
			r := &countingSSEReader{Reader: strings.NewReader(prefix + strings.Repeat("x", 4*maxSSEEventBytes))}
			_, err := NewSSEReader(r).Next()
			if err == nil || err == io.EOF {
				t.Fatalf("oversized line accepted: %v", err)
			}
			if r.read > maxSSEEventBytes+32*1024 {
				t.Fatalf("read %d bytes before rejecting oversized line", r.read)
			}
		})
	}
}

func TestSSECountsCommentsAndUnknownFieldsWithinEvent(t *testing.T) {
	for _, line := range []string{":" + strings.Repeat("x", 1022) + "\n", "unknown: " + strings.Repeat("x", 1014) + "\n"} {
		_, err := NewSSEReader(strings.NewReader(strings.Repeat(line, 1025) + "data: accepted\n\n")).Next()
		if err == nil || err == io.EOF {
			t.Fatalf("oversized event accepted: %v", err)
		}
	}
}

func TestSSEResetsBudgetAfterCommentOnlyEvent(t *testing.T) {
	body := strings.Repeat(":"+strings.Repeat("x", 1022)+"\n", 600) + "\n"
	event, err := NewSSEReader(strings.NewReader(body + body + "data: 你\r\ndata: 好\r\n\r\n")).Next()
	if err != nil || string(event.Data) != "你\n好" {
		t.Fatalf("event=%+v err=%v", event, err)
	}
}

func testProtocolStream(kind, body string) Stream {
	r := NewSSEReader(strings.NewReader(body))
	switch kind {
	case "openai":
		return &openAIStream{reader: r}
	case "anthropic":
		return &anthropicStream{reader: r, usage: &CanonicalUsage{}}
	default:
		return &geminiStream{reader: r, usage: &CanonicalUsage{}}
	}
}

func TestProviderEOFRequiresProtocolCompletion(t *testing.T) {
	cases := []struct{ kind, body string }{
		{"openai", `{"choices":[{"delta":{"content":"partial"}}]}`},
		{"openai", `{"usage":{"prompt_tokens":5}}`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`},
		{"anthropic", `{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}`},
		{"gemini", `{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}`},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`},
		{"gemini", `{"candidates":[{"finishReason":"FINISH_REASON_UNSPECIFIED"}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.kind+tc.body, func(t *testing.T) {
			s := testProtocolStream(tc.kind, "data: "+tc.body+"\n\n")
			for i := 0; i < 4; i++ {
				c, err := s.Next()
				if c.Done {
					t.Fatal("truncated stream reported success")
				}
				if err != nil {
					if !errors.Is(err, ErrStreamTruncated) {
						t.Fatalf("want truncation, got %v", err)
					}
					return
				}
			}
			t.Fatal("stream never terminated")
		})
	}
}

func TestProviderTruncationPreservesObservedUsage(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{
		{"openai", `{"usage":{"prompt_tokens":5}}`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			c, err := testProtocolStream(tc.kind, "data: "+tc.body+"\n\n").Next()
			if !errors.Is(err, ErrStreamTruncated) || c.Usage == nil || c.Usage.InputTokens != 5 {
				t.Fatalf("usage=%+v err=%v", c.Usage, err)
			}
		})
	}
}

func TestOpenAIStreamErrorEnvelopeCannotBecomeSuccess(t *testing.T) {
	s := testProtocolStream("openai", "data: "+`{"error":{"type":"server_error","message":"private upstream detail"}}`+"\n\ndata: [DONE]\n\n")
	c, err := s.Next()
	if err == nil || c.Done {
		t.Fatalf("error envelope became success: %+v %v", c, err)
	}
	if strings.Contains(err.Error(), "private upstream detail") {
		t.Fatal("upstream error details leaked")
	}
}

func TestAnthropicToolRequestRoundTrip(t *testing.T) {
	r, err := NewAnthropic().BuildRequest(&CanonicalRequest{
		Model: "claude", Tools: json.RawMessage(`[{"type":"function","function":{"name":"lookup","description":"Find city","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]`),
		ToolChoice: json.RawMessage(`{"type":"function","function":{"name":"lookup"}}`),
		Messages: []Message{
			{Role: "user", Content: json.RawMessage(`"look up Beijing"`)},
			{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"city\":\"北京\"}"}}]`)},
			{Role: "tool", ToolCallID: "call_1", Content: json.RawMessage(`"sunny"`)},
		},
	}, Credential{}, Endpoint{})
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Tools []struct {
			Name        string          `json:"name"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
		ToolChoice struct{ Type, Name string } `json:"tool_choice"`
		Messages   []anthropicMsg              `json:"messages"`
	}
	if err := json.Unmarshal(r.Body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Tools) != 1 || got.Tools[0].Name != "lookup" || !strings.Contains(string(got.Tools[0].InputSchema), "city") {
		t.Fatalf("wrong tools: %s", r.Body)
	}
	if got.ToolChoice.Type != "tool" || got.ToolChoice.Name != "lookup" {
		t.Fatalf("wrong choice: %s", r.Body)
	}
	var call []struct {
		Type, ID, Name string
		Input          struct{ City string }
	}
	if err := json.Unmarshal(got.Messages[1].Content, &call); err != nil || len(call) != 1 || call[0].Type != "tool_use" || call[0].ID != "call_1" || call[0].Name != "lookup" || call[0].Input.City != "北京" {
		t.Fatalf("wrong assistant call: %s", r.Body)
	}
	var result []struct {
		Type      string
		ToolUseID string `json:"tool_use_id"`
		Content   string
	}
	if err := json.Unmarshal(got.Messages[2].Content, &result); err != nil || len(result) != 1 || result[0].Type != "tool_result" || result[0].ToolUseID != "call_1" || result[0].Content != "sunny" || got.Messages[2].Role != "user" {
		t.Fatalf("wrong tool result: %s", r.Body)
	}
}

func TestAnthropicToolChoiceStrings(t *testing.T) {
	for _, tc := range []struct{ choice, want string }{{`"auto"`, "auto"}, {`"required"`, "any"}, {`"none"`, "none"}} {
		r, err := NewAnthropic().BuildRequest(&CanonicalRequest{Model: "claude", Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}, ToolChoice: json.RawMessage(tc.choice)}, Credential{}, Endpoint{})
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			ToolChoice struct{ Type string } `json:"tool_choice"`
		}
		if err := json.Unmarshal(r.Body, &got); err != nil || got.ToolChoice.Type != tc.want {
			t.Fatalf("choice %s body=%s err=%v", tc.choice, r.Body, err)
		}
	}
}

func TestProviderMalformedEventsPreserveUsage(t *testing.T) {
	for _, tc := range []struct{ kind, usage, malformed string }{
		{"openai", `{"usage":{"prompt_tokens":5}}`, `{broken`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`, `{broken`},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`, `{broken`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`, `{"type":"error"}`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`, `{"type":"error","error":{"type":"overloaded_error"}}`},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`, `{"error":{"status":"INTERNAL"}}`},
	} {
		t.Run(tc.kind+tc.malformed, func(t *testing.T) {
			c, err := testProtocolStream(tc.kind, "data: "+tc.usage+"\n\ndata: "+tc.malformed+"\n\n").Next()
			if err == nil || c.Done || c.Usage == nil || c.Usage.InputTokens != 5 {
				t.Fatalf("usage=%+v done=%v err=%v", c.Usage, c.Done, err)
			}
		})
	}
}

func TestProviderValidTerminalAllowsCompletion(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{
		{"openai", `[DONE]`}, {"openai", `{"choices":[{"delta":{},"finish_reason":"stop"}]}`},
		{"anthropic", `{"type":"message_stop"}`}, {"gemini", `{"candidates":[{"finishReason":"STOP"}]}`},
	} {
		t.Run(tc.kind+tc.body, func(t *testing.T) {
			chunks := drain(t, testProtocolStream(tc.kind, "data: "+tc.body+"\n\n"))
			if len(chunks) == 0 || !chunks[len(chunks)-1].Done {
				t.Fatal("missing successful completion")
			}
		})
	}
}

func TestUnknownFinishReasonIsNotSuccessful(t *testing.T) {
	for _, tc := range []struct{ kind, body string }{
		{"openai", `{"choices":[{"delta":{},"finish_reason":"not_a_finish"}]}`},
		{"gemini", `{"candidates":[{"finishReason":"NOT_A_FINISH"}]}`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			s := testProtocolStream(tc.kind, "data: "+tc.body+"\n\n")
			for i := 0; i < 3; i++ {
				c, err := s.Next()
				if c.Done {
					t.Fatal("invalid finish accepted")
				}
				if err != nil && err != io.EOF {
					return
				}
			}
			t.Fatal("invalid finish did not fail")
		})
	}
}

func TestAnthropicToolDeltasAreCanonicalArrays(t *testing.T) {
	s := testProtocolStream("anthropic", "data: "+`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup"}}`+"\n\ndata: "+`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`+"\n\ndata: "+`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"北京\"}"}}`+"\n\ndata: "+`{"type":"message_stop"}`+"\n\n")
	var args strings.Builder
	for i := 0; i < 3; i++ {
		c, err := s.Next()
		if err != nil {
			t.Fatal(err)
		}
		var calls []struct {
			Index    int    `json:"index"`
			ID       string `json:"id"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		}
		if err := json.Unmarshal(c.ToolCallDelta, &calls); err != nil {
			t.Fatalf("invalid canonical array %s: %v", c.ToolCallDelta, err)
		}
		if len(calls) != 1 || calls[0].Index != 0 {
			t.Fatalf("tool index mapping: %+v", calls)
		}
		if i == 0 && (calls[0].ID != "tool-1" || calls[0].Function.Name != "lookup") {
			t.Fatal("tool identity lost")
		}
		args.WriteString(calls[0].Function.Arguments)
	}
	if args.String() != `{"city":"北京"}` {
		t.Fatalf("arguments=%q", args.String())
	}
}
