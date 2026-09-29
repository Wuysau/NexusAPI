package provider

import (
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
)

// A JSON projection keeps the regression executable against the old adapter,
// where a missing canonical Refusal field is the behavior under test.
func canonicalRefusal(t *testing.T, chunk CanonicalChunk) *string {
	t.Helper()
	raw, err := json.Marshal(chunk)
	if err != nil {
		t.Fatal(err)
	}
	var projected struct{ Refusal *string }
	if err := json.Unmarshal(raw, &projected); err != nil {
		t.Fatal(err)
	}
	return projected.Refusal
}

func TestRefusalStreamPreservesEveryFragmentAndCompletion(t *testing.T) {
	body := "data: " + `{"choices":[{"delta":{"role":"assistant","refusal":null}}]}` + "\n\n" +
		"data: " + `{"choices":[{"delta":{"refusal":"I cannot "},"finish_reason":null}]}` + "\n\n" +
		"data: " + `{"choices":[{"delta":{"refusal":""},"finish_reason":null}]}` + "\n\n" +
		"data: " + `{"choices":[{"delta":{"refusal":"帮助。"},"finish_reason":null}]}` + "\n\n" +
		"data: " + `{"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n" +
		"data: " + `{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}` + "\n\ndata: [DONE]\n\n"
	s := &openAIStream{reader: NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))}
	for _, want := range []string{"I cannot ", "", "帮助。"} {
		chunk, err := s.Next()
		got := canonicalRefusal(t, chunk)
		if err != nil || got == nil || *got != want || chunk.Done || chunk.Text != "" || chunk.Reasoning != "" || chunk.ToolCallDelta != nil || chunk.FinishReason != "" {
			t.Fatalf("refusal fragment was dropped, merged, or reclassified: want=%q chunk=%+v err=%v", want, chunk, err)
		}
	}
	finish, err := s.Next()
	if err != nil || finish.FinishReason != "stop" || finish.Done || canonicalRefusal(t, finish) != nil {
		t.Fatalf("refusal changed normal finish: chunk=%+v err=%v", finish, err)
	}
	done, err := s.Next()
	if err != nil || !done.Done || done.Usage == nil || done.Usage.InputTokens != 7 || done.Usage.OutputTokens != 3 {
		t.Fatalf("refusal changed completion or usage: chunk=%+v err=%v", done, err)
	}
	checkObserved(t, done.Usage, ObservedUsage{InputTokens: observedInt(7), OutputTokens: observedInt(3), TotalTokens: observedInt(10)})
	if _, err := s.Next(); err != io.EOF {
		t.Fatalf("completed refusal stream did not end: %v", err)
	}
}

func TestRefusalMalformedStreamValuesReturnStaticErrorAndPriorUsage(t *testing.T) {
	for _, value := range []string{`17`, `true`, `{"private_refusal_marker":"value"}`, `["private_refusal_marker"]`} {
		t.Run(value, func(t *testing.T) {
			body := "data: " + `{"usage":{"prompt_tokens":7}}` + "\n\ndata: " +
				`{"choices":[{"delta":{"refusal":` + value + `,"content":"private_refusal_marker"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
			chunk, err := testProtocolStream("openai", body).Next()
			if err == nil || chunk.Done || chunk.Text != "" || canonicalRefusal(t, chunk) != nil || chunk.Usage == nil || chunk.Usage.InputTokens != 7 {
				t.Fatalf("malformed refusal became successful output or lost prior usage: chunk=%+v err=%v", chunk, err)
			}
			if err.Error() != "openai: malformed or failed stream chunk" || strings.Contains(err.Error(), "private_refusal_marker") {
				t.Fatalf("malformed refusal exposed provider data: %v", err)
			}
		})
	}
}

func TestRefusalParsePreservesCompanionFieldsAndPresence(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		want        *string
	}{
		{"missing", "", nil},
		{"null", `,"refusal":null`, nil},
		{"empty", `,"refusal":""`, refusalString("")},
		{"text", `,"refusal":"cannot comply"`, refusalString("cannot comply")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const toolCalls = `[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]`
			chunk, err := parseOpenAIChunk([]byte(`{"choices":[{"delta":{"content":"safe alternative","reasoning_content":"private reasoning","tool_calls":` + toolCalls + tc.field + `},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}`))
			if err != nil || !reflect.DeepEqual(canonicalRefusal(t, chunk), tc.want) || chunk.Text != "safe alternative" || chunk.Reasoning != "private reasoning" || string(chunk.ToolCallDelta) != toolCalls || chunk.FinishReason != "content_filter" || chunk.Done {
				t.Fatalf("refusal changed companion delta fields: chunk=%+v err=%v", chunk, err)
			}
			checkObserved(t, chunk.Usage, ObservedUsage{InputTokens: observedInt(9), OutputTokens: observedInt(4), TotalTokens: observedInt(13)})
		})
	}
}

func refusalString(value string) *string { return &value }

func TestRefusalHistoryCompatibleWireAndCanonicalIsolation(t *testing.T) {
	const history = `[
		{"role":"user","name":"fixture-user","content":[ { "type":"text", "text":"hello" }, {"type":"image_url","image_url":{"url":"https://fixture.invalid/image"}} ]},
		{"role":"assistant","name":"fixture-assistant","content":null,"refusal":"I cannot \"comply\".\n无法提供。","reasoning_content":"history reasoning","tool_calls":[ {"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}} ]},
		{"role":"tool","content":"result","tool_call_id":"call_fixture"},
		{"role":"assistant","content":"safe alternative","refusal":""},
		{"role":"assistant","content":"ordinary history"},
		{"role":"assistant","content":"nullable history","refusal":null}
	]`
	req := reasoningHistoryRequest(t, history)
	req.Model = "arbitrary-ollama/deepseek-reasoner"
	for _, code := range []string{"ollama", "openai", "deepseek", "qwen", "custom-compatible", "anthropic"} {
		t.Run(code, func(t *testing.T) {
			body := reasoningHistoryBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: code, Protocol: "openai"})
			var got, want []map[string]any
			if json.Unmarshal(body["messages"], &got) != nil || json.Unmarshal([]byte(history), &want) != nil {
				t.Fatal("invalid history fixture")
			}
			delete(want[5], "refusal")
			if code == "ollama" {
				want[1]["reasoning"] = want[1]["reasoning_content"]
				delete(want[1], "reasoning_content")
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("refusal or companion history changed on wire\ngot: %#v\nwant: %#v", got, want)
			}
		})
	}
}

func TestRefusalHistoryDecodeRejectsNonStrings(t *testing.T) {
	for _, value := range []string{`17`, `true`, `{}`, `[]`} {
		t.Run(value, func(t *testing.T) {
			var message Message
			err := json.Unmarshal([]byte(`{"role":"assistant","content":"safe alternative","refusal":`+value+`}`), &message)
			var typeError *json.UnmarshalTypeError
			if !errors.As(err, &typeError) {
				t.Fatalf("refusal must use standard string decoding, got %v", err)
			}
		})
	}
}

func TestRefusalHistoryNativeAdaptersRejectBeforeBuild(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		for _, role := range []string{"assistant", "system"} {
			for _, refusal := range []string{`"private_refusal_marker"`, `""`} {
				t.Run(adapter.ID()+"/"+role+"/"+refusal, func(t *testing.T) {
					req := reasoningHistoryRequest(t, `[{"role":"user","content":"hello"},{"role":"`+role+`","content":"safe alternative","refusal":`+refusal+`}]`)
					before, _ := json.Marshal(req)
					validateErr := adapter.ValidateRequest(req)
					call, buildErr := adapter.BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
					if call != nil {
						t.Fatal("unsupported refusal history produced an upstream request")
					}
					for phase, err := range map[string]error{"validate": validateErr, "build": buildErr} {
						var unsupported *UnsupportedParameterError
						if !errors.As(err, &unsupported) || unsupported.Param != "messages" {
							t.Errorf("%s must reject refusal history with messages error, got %v", phase, err)
						} else if strings.Contains(err.Error(), "private_") {
							t.Errorf("%s exposed request values", phase)
						}
					}
					after, _ := json.Marshal(req)
					if string(before) != string(after) {
						t.Fatal("native refusal rejection mutated canonical history")
					}
				})
			}
		}
	}
}

func TestRefusalHistoryNativeMissingAndNullPreserveCompatibility(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		t.Run(adapter.ID(), func(t *testing.T) {
			baseline := reasoningHistoryRequest(t, `[{"role":"user","content":"hello"},{"role":"assistant","content":"safe alternative"}]`)
			want, err := adapter.BuildRequest(baseline, Credential{}, Endpoint{})
			if err != nil {
				t.Fatal(err)
			}
			req := reasoningHistoryRequest(t, `[{"role":"user","content":"hello","refusal":null},{"role":"assistant","content":"safe alternative","refusal":null}]`)
			if err := adapter.ValidateRequest(req); err != nil {
				t.Fatalf("null refusal changed native validation: %v", err)
			}
			got, err := adapter.BuildRequest(req, Credential{}, Endpoint{})
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("missing or null refusal changed native request: err=%v", err)
			}
		})
	}
}
