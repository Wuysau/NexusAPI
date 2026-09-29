package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
)

func anthropicPreflightSnapshot(req *CanonicalRequest) *CanonicalRequest {
	copy := *req
	copy.Tools, copy.ToolChoice = bytes.Clone(req.Tools), bytes.Clone(req.ToolChoice)
	copy.Messages = slices.Clone(req.Messages)
	for i := range copy.Messages {
		copy.Messages[i].Content = bytes.Clone(req.Messages[i].Content)
		copy.Messages[i].ToolCalls = bytes.Clone(req.Messages[i].ToolCalls)
	}
	return &copy
}

func assertAnthropicPreflightRejection(t *testing.T, req *CanonicalRequest, param string) {
	t.Helper()
	before := anthropicPreflightSnapshot(req)
	adapter := NewAnthropic()
	validateErr := adapter.ValidateRequest(req)
	call, buildErr := adapter.BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
	if call != nil {
		t.Error("rejected tool semantics produced an upstream request")
	}
	for phase, err := range map[string]error{"validate": validateErr, "build": buildErr} {
		var unsupported *UnsupportedParameterError
		if !errors.As(err, &unsupported) || unsupported.Param != param {
			t.Errorf("%s must return unsupported %s, got %v", phase, param, err)
		} else if err.Error() != "unsupported request parameter" {
			t.Errorf("%s disclosed request values: %v", phase, err)
		}
	}
	if !reflect.DeepEqual(before, req) {
		t.Fatal("tool preflight or rejected build mutated the canonical request")
	}
}

func TestAnthropicToolPreflightRejectsExistingDefinitionFailures(t *testing.T) {
	for _, tc := range []struct{ name, tools string }{
		{"malformed_json", `[{"private_tool":`},
		{"object", `{}`},
		{"number", `17`},
		{"boolean", `true`},
		{"string", `"private_tool"`},
		{"null_entry", `[null]`},
		{"missing_type", `[{"function":{"name":"private_tool"}}]`},
		{"unsupported_type", `[{"type":"private_tool","function":{"name":"lookup"}}]`},
		{"missing_function", `[{"type":"function"}]`},
		{"wrong_function_type", `[{"type":"function","function":[]}]`},
		{"empty_name", `[{"type":"function","function":{"name":""}}]`},
		{"wrong_name_type", `[{"type":"function","function":{"name":17}}]`},
		{"wrong_description_type", `[{"type":"function","function":{"name":"lookup","description":true}}]`},
		{"wrong_strict_type", `[{"type":"function","function":{"name":"lookup","strict":"private_strict"}}]`},
		{"invalid_later_definition", `[{"type":"function","function":{"name":"lookup"}},{"type":"function","function":{}}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.Tools = json.RawMessage(tc.tools)
			assertAnthropicPreflightRejection(t, req, "tools")
		})
	}
}

func TestAnthropicToolPreflightRejectsExistingChoiceFailures(t *testing.T) {
	for _, tc := range []struct{ name, choice string }{
		{"malformed_json", `{"private_choice":`},
		{"unsupported_string", `"private_choice"`},
		{"empty_string", `""`},
		{"array", `[]`},
		{"number", `17`},
		{"boolean", `true`},
		{"empty_object", `{}`},
		{"missing_type", `{"function":{"name":"lookup"}}`},
		{"unsupported_type", `{"type":"private_choice","function":{"name":"lookup"}}`},
		{"missing_function", `{"type":"function"}`},
		{"empty_name", `{"type":"function","function":{"name":""}}`},
		{"wrong_name_type", `{"type":"function","function":{"name":17}}`},
		{"wrong_function_type", `{"type":"function","function":"private_choice"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.ToolChoice = json.RawMessage(tc.choice)
			assertAnthropicPreflightRejection(t, req, "tool_choice")
		})
	}
}

func TestAnthropicToolPreflightRejectsExistingHistoryFailures(t *testing.T) {
	const validCall = `[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]`
	for _, tc := range []struct {
		name    string
		message Message
	}{
		{"tool_result_missing_id", Message{Role: "tool", Content: json.RawMessage(`"private_result"`)}},
		{"tool_result_invalid_json", Message{Role: "tool", ToolCallID: "call_fixture", Content: json.RawMessage(`{"private_result":`)}},
		{"user_tool_calls", Message{Role: "user", Content: json.RawMessage(`"private_text"`), ToolCalls: json.RawMessage(validCall)}},
		{"user_empty_tool_calls", Message{Role: "user", Content: json.RawMessage(`"private_text"`), ToolCalls: json.RawMessage(`[]`)}},
		{"malformed_calls", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"private_call":`)}},
		{"object_calls", Message{Role: "assistant", ToolCalls: json.RawMessage(`{}`)}},
		{"scalar_calls", Message{Role: "assistant", ToolCalls: json.RawMessage(`true`)}},
		{"null_call", Message{Role: "assistant", ToolCalls: json.RawMessage(`[null]`)}},
		{"invalid_assistant_object_content", Message{Role: "assistant", Content: json.RawMessage(`{"private_content":true}`), ToolCalls: json.RawMessage(validCall)}},
		{"invalid_assistant_number_content", Message{Role: "assistant", Content: json.RawMessage(`17`), ToolCalls: json.RawMessage(validCall)}},
		{"missing_call_type", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","function":{"name":"lookup","arguments":"{}"}}]`)}},
		{"unsupported_call_type", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","type":"private_call","function":{"name":"lookup","arguments":"{}"}}]`)}},
		{"missing_call_id", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"type":"function","function":{"name":"lookup","arguments":"{}"}}]`)}},
		{"missing_function_name", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","type":"function","function":{"arguments":"{}"}}]`)}},
		{"missing_arguments", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","type":"function","function":{"name":"lookup"}}]`)}},
		{"wrong_arguments_type", Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":{}}}]`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.Messages = append(req.Messages, tc.message)
			assertAnthropicPreflightRejection(t, req, "messages")
		})
	}
	for _, arguments := range []string{"", "private_invalid_json", "null", "[]", "17", "true", `"private_string"`} {
		t.Run("arguments_"+arguments, func(t *testing.T) {
			encoded, _ := json.Marshal(arguments)
			req := validationRequest()
			req.Messages = append(req.Messages, Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":` + string(encoded) + `}}]`)})
			assertAnthropicPreflightRejection(t, req, "messages")
		})
	}
}

func TestAnthropicToolPreflightRejectsNoConversationMessages(t *testing.T) {
	for _, tc := range []struct {
		name     string
		messages []Message
	}{
		{"nil", nil},
		{"empty", []Message{}},
		{"system_only", []Message{{Role: "system", Content: json.RawMessage(`"private_system"`)}}},
		{"developer_only", []Message{{Role: "developer", Content: json.RawMessage(`"private_developer"`)}}},
		{"mixed_instructions_only", []Message{{Role: "system", Content: json.RawMessage(`"private_system"`)}, {Role: "developer", Content: json.RawMessage(`"private_developer"`)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			req.Messages = tc.messages
			assertAnthropicPreflightRejection(t, req, "messages")
		})
	}
}

func TestAnthropicToolPreflightPreservesDefinitionDefaultsAndSchemaPassThrough(t *testing.T) {
	for _, tc := range []struct{ name, tools, choice, wantTools, wantChoice string }{
		{"omitted", "", "", "", ""},
		{"null", "null", "null", "null", "null"},
		{"padded_null", " \n null \t", " \n null \t", "null", "null"},
		{"empty", `[]`, "", `[]`, ""},
		{"default_parameters", `[{"type":"function","function":{"name":"lookup"}}]`, "", `[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]`, ""},
		{"null_parameters", `[{"type":"function","function":{"name":"lookup","parameters":null,"strict":null}}]`, "", `[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]`, ""},
		{"strict_true", `[{"type":"function","function":{"name":"lookup","strict":true}}]`, "", `[{"name":"lookup","input_schema":{"type":"object","properties":{}},"strict":true}]`, ""},
		{"strict_false", `[{"type":"function","function":{"name":"lookup","strict":false}}]`, "", `[{"name":"lookup","input_schema":{"type":"object","properties":{}},"strict":false}]`, ""},
		{"schema_passthrough", `[{"type":"function","function":{"name":"lookup","description":"retain me","parameters":{"type":17,"private_schema":[null,true]}}}]`, "", `[{"name":"lookup","description":"retain me","input_schema":{"type":17,"private_schema":[null,true]}}]`, ""},
		{"force_named", `[{"type":"function","function":{"name":"lookup"}}]`, `{"type":"function","function":{"name":"lookup"}}`, `[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]`, `{"type":"tool","name":"lookup"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := validationRequest()
			if tc.tools != "" {
				req.Tools = json.RawMessage(tc.tools)
			}
			if tc.choice != "" {
				req.ToolChoice = json.RawMessage(tc.choice)
			}
			var body map[string]json.RawMessage
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
				t.Fatal(err)
			}
			for field, want := range map[string]string{"tools": tc.wantTools, "tool_choice": tc.wantChoice} {
				if want == "" {
					if _, exists := body[field]; exists {
						t.Errorf("omitted %s was added", field)
					}
					continue
				}
				anthropicImageJSON(t, body[field], json.RawMessage(want))
			}
		})
	}
}

func TestAnthropicToolPreflightPreservesEmptyToolResultsAndCalls(t *testing.T) {
	for _, content := range []string{"", "null", " \n null \t", `""`} {
		t.Run("result_"+content, func(t *testing.T) {
			req := validationRequest()
			message := Message{Role: "tool", ToolCallID: "call_fixture"}
			if content != "" {
				message.Content = json.RawMessage(content)
			}
			req.Messages = append(req.Messages, message)
			var body struct{ Messages []anthropicMsg }
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
				t.Fatal(err)
			}
			anthropicImageJSON(t, body.Messages[1].Content, json.RawMessage(`[{"type":"tool_result","tool_use_id":"call_fixture","content":""}]`))
		})
	}
	for _, calls := range []string{"", "null", " \n null \t", `[]`} {
		t.Run("calls_"+calls, func(t *testing.T) {
			req := validationRequest()
			message := Message{Role: "assistant", Content: json.RawMessage(`"safe text"`)}
			if calls != "" {
				message.ToolCalls = json.RawMessage(calls)
			}
			req.Messages = append(req.Messages, message)
			var body struct{ Messages []anthropicMsg }
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
				t.Fatal(err)
			}
			want := json.RawMessage(`"safe text"`)
			if calls == "[]" {
				want = json.RawMessage(`[{"type":"text","text":"safe text"}]`)
			}
			anthropicImageJSON(t, body.Messages[1].Content, want)
		})
	}
}
