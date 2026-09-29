package provider

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func assertNativeHistoryRejected(t *testing.T, adapter Adapter, req *CanonicalRequest) {
	t.Helper()
	before := anthropicPreflightSnapshot(req)
	validateErr := adapter.ValidateRequest(req)
	call, buildErr := adapter.BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
	if call != nil {
		t.Error("unsupported history produced an upstream request")
	}
	for phase, err := range map[string]error{"validate": validateErr, "build": buildErr} {
		var unsupported *UnsupportedParameterError
		if !errors.As(err, &unsupported) || unsupported.Param != "messages" {
			t.Errorf("%s must return unsupported messages, got %v", phase, err)
		} else if err.Error() != "unsupported request parameter" {
			t.Errorf("%s must return a static error, got %v", phase, err)
		}
	}
	if !reflect.DeepEqual(before, req) {
		t.Fatal("validation or rejected build changed the canonical history")
	}
}

func buildNativeHistory(t *testing.T, adapter Adapter, req *CanonicalRequest, endpoint Endpoint) []byte {
	t.Helper()
	before := anthropicPreflightSnapshot(req)
	if err := adapter.ValidateRequest(req); err != nil {
		t.Fatalf("valid history rejected by preflight: %v", err)
	}
	call, err := adapter.BuildRequest(req, Credential{Secret: "fixture-secret"}, endpoint)
	if err != nil {
		t.Fatalf("valid history rejected by build: %v", err)
	}
	if !reflect.DeepEqual(before, req) {
		t.Fatal("validation or build changed the canonical history")
	}
	return call.Body
}

func nativeHistoryMessages(t *testing.T, raw string) []Message {
	t.Helper()
	var messages []Message
	if err := json.Unmarshal([]byte(raw), &messages); err != nil {
		t.Fatal(err)
	}
	return messages
}

func TestNativeHistoryRejectsParticipantNames(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		for _, role := range []string{"system", "developer", "user", "assistant"} {
			t.Run(adapter.ID()+"/"+role, func(t *testing.T) {
				req := validationRequest()
				req.Messages = append(req.Messages, Message{Role: role, Name: "private_participant", Content: json.RawMessage(` "private message" `)})
				assertNativeHistoryRejected(t, adapter, req)
			})
		}
		// Whitespace is nonempty participant data, not an absent optional field.
		t.Run(adapter.ID()+"/whitespace_name", func(t *testing.T) {
			req := validationRequest()
			req.Messages[0].Name = " "
			assertNativeHistoryRejected(t, adapter, req)
		})
	}
	t.Run("anthropic/tool_result", func(t *testing.T) {
		req := validationRequest()
		req.Messages = nativeHistoryMessages(t, `[
			{"role":"user","content":"look up the value"},
			{"role":"assistant","content":null,"tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
			{"role":"tool","content":"private result","tool_call_id":"call_fixture","name":"private_participant"}
		]`)
		assertNativeHistoryRejected(t, NewAnthropic(), req)
	})
}

func TestNativeHistoryPreservesAbsentParticipantNames(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		for _, tc := range []struct{ name, field string }{
			{"omitted", ""}, {"null", `,"name":null`}, {"empty", `,"name":""`},
		} {
			t.Run(adapter.ID()+"/"+tc.name, func(t *testing.T) {
				req := validationRequest()
				req.Messages = nil
				for _, role := range []string{"system", "developer", "user", "assistant"} {
					messages := nativeHistoryMessages(t, `[{"role":"`+role+`","content":"`+role+` text"`+tc.field+`}]`)
					if messages[0].Name != "" {
						t.Fatal("absent participant name did not decode to the existing zero value")
					}
					req.Messages = append(req.Messages, messages[0])
				}
				raw := buildNativeHistory(t, adapter, req, Endpoint{})
				if adapter.ID() == "anthropic" {
					var body anthropicBody
					if err := json.Unmarshal(raw, &body); err != nil {
						t.Fatal(err)
					}
					want := []anthropicMsg{{Role: "user", Content: json.RawMessage(`"user text"`)}, {Role: "assistant", Content: json.RawMessage(`"assistant text"`)}}
					if body.System != "system text\ndeveloper text" || !reflect.DeepEqual(body.Messages, want) {
						t.Fatal("default names changed system text or conversation order")
					}
				} else {
					var body geminiBody
					if err := json.Unmarshal(raw, &body); err != nil {
						t.Fatal(err)
					}
					want := []geminiContent{{Role: "user", Parts: []geminiPart{{Text: "user text"}}}, {Role: "model", Parts: []geminiPart{{Text: "assistant text"}}}}
					wantSystem := &geminiContent{Parts: []geminiPart{{Text: "system text\ndeveloper text"}}}
					if !reflect.DeepEqual(body.SystemInstruction, wantSystem) || !reflect.DeepEqual(body.Contents, want) {
						t.Fatal("default names changed system text or conversation order")
					}
				}
			})
		}
	}
	t.Run("anthropic/unnamed_tool_result", func(t *testing.T) {
		req := validationRequest()
		req.Messages = append(req.Messages, nativeHistoryMessages(t, `[
			{"role":"assistant","content":null,"tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
			{"role":"tool","content":"result","tool_call_id":"call_fixture","name":""}
		]`)...)
		var body anthropicBody
		if err := json.Unmarshal(buildNativeHistory(t, NewAnthropic(), req, Endpoint{}), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Messages) != 3 || body.Messages[2].Role != "user" {
			t.Fatal("empty participant name changed the existing tool result translation")
		}
		anthropicImageJSON(t, body.Messages[2].Content, json.RawMessage(`[{"type":"tool_result","tool_use_id":"call_fixture","content":"result"}]`))
	})
}

func TestNativeHistoryNamesRemainCompatible(t *testing.T) {
	for _, code := range []string{"openai", "ollama"} {
		t.Run(code, func(t *testing.T) {
			req := validationRequest()
			req.Messages = nativeHistoryMessages(t, `[
				{"role":"system","content":"instructions","name":"system_author"},
				{"role":"developer","content":"developer instructions","name":"developer_author"},
				{"role":"user","content":"question","name":"user_author"},
				{"role":"assistant","content":null,"name":"assistant_author","tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
				{"role":"tool","content":"result","tool_call_id":"call_fixture","name":"tool_author"}
			]`)
			var body struct{ Messages []Message }
			raw := buildNativeHistory(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: code})
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(body.Messages, req.Messages) {
				t.Fatal("compatible wire dropped or changed participant names or history")
			}
		})
	}
}

func TestNativeHistoryGeminiRejectsEmptyConversationBeforeBuild(t *testing.T) {
	for _, tc := range []struct{ name, messages string }{
		{"nil", `null`}, {"empty", `[]`},
		{"system_only", `[{"role":"system","content":"private instructions"}]`},
		{"developer_only", `[{"role":"developer","content":"private instructions"}]`},
		{"instructions_only", `[{"role":"system","content":"private instructions"},{"role":"developer","content":"private instructions"}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.Messages = nativeHistoryMessages(t, tc.messages)
			assertNativeHistoryRejected(t, NewGemini(), req)
		})
	}
}

func TestNativeHistoryGeminiPreservesConversationControls(t *testing.T) {
	for _, tc := range []struct {
		name     string
		messages string
		contents []geminiContent
		system   *geminiContent
	}{
		{"user_only", `[{"role":"user","content":"question"}]`, []geminiContent{{Role: "user", Parts: []geminiPart{{Text: "question"}}}}, nil},
		{"assistant_only", `[{"role":"assistant","content":"answer"}]`, []geminiContent{{Role: "model", Parts: []geminiPart{{Text: "answer"}}}}, nil},
		{"system_user", `[{"role":"system","content":"instructions"},{"role":"user","content":"question"}]`, []geminiContent{{Role: "user", Parts: []geminiPart{{Text: "question"}}}}, &geminiContent{Parts: []geminiPart{{Text: "instructions"}}}},
		{"developer_assistant", `[{"role":"developer","content":"instructions"},{"role":"assistant","content":"answer"}]`, []geminiContent{{Role: "model", Parts: []geminiPart{{Text: "answer"}}}}, &geminiContent{Parts: []geminiPart{{Text: "instructions"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.Messages = nativeHistoryMessages(t, tc.messages)
			var body geminiBody
			if err := json.Unmarshal(buildNativeHistory(t, NewGemini(), req, Endpoint{}), &body); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(body.Contents, tc.contents) || !reflect.DeepEqual(body.SystemInstruction, tc.system) {
				t.Fatal("preflight changed an existing valid Gemini conversation")
			}
		})
	}
}
