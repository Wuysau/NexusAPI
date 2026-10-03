package provider

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func validationRequest() *CanonicalRequest {
	return &CanonicalRequest{Model: "custom-local-model:latest", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}
}

func TestGeminiBuildRejectsParametersItWouldDiscard(t *testing.T) {
	tests := []struct {
		name string
		set  func(*CanonicalRequest)
	}{
		{"tools", func(r *CanonicalRequest) {
			r.Tools = json.RawMessage(`[{"type":"function","function":{"name":"private_tool"}}]`)
		}},
		{"invalid_tools", func(r *CanonicalRequest) { r.Tools = json.RawMessage(`{}`) }},
		{"required_tool", func(r *CanonicalRequest) { r.ToolChoice = json.RawMessage(`"required"`) }},
		{"named_tool", func(r *CanonicalRequest) {
			r.ToolChoice = json.RawMessage(`{"type":"function","function":{"name":"private_tool"}}`)
		}},
		{"json_object", func(r *CanonicalRequest) { r.ResponseFormat = json.RawMessage(`{"type":"json_object"}`) }},
		{"json_schema", func(r *CanonicalRequest) {
			r.ResponseFormat = json.RawMessage(`{"type":"json_schema","json_schema":{"name":"private_schema"}}`)
		}},
		{"text_with_constraints", func(r *CanonicalRequest) {
			r.ResponseFormat = json.RawMessage(`{"type":"text","schema":{"private":true}}`)
		}},
		{"history_calls", func(r *CanonicalRequest) {
			r.Messages[0] = Message{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"private_call"}]`)}
		}},
		{"history_result", func(r *CanonicalRequest) { r.Messages[0].Role = "tool"; r.Messages[0].ToolCallID = "private_call" }},
		{"history_call_id", func(r *CanonicalRequest) { r.Messages[0].ToolCallID = "private_call" }},
		{"image", func(r *CanonicalRequest) {
			r.Messages[0].Content = json.RawMessage(`[{"type":"text","text":"hello"},{"type":"image_url","image_url":{"url":"https://private.invalid/image"}}]`)
		}},
		{"audio", func(r *CanonicalRequest) {
			r.Messages[0].Content = json.RawMessage(`[{"type":"input_audio","input_audio":{"data":"private_audio","format":"wav"}}]`)
		}},
		{"system_image", func(r *CanonicalRequest) {
			r.Messages = append([]Message{{Role: "system", Content: json.RawMessage(`[{"type":"image_url","image_url":{"url":"private_image"}}]`)}}, r.Messages...)
		}},
		{"unknown_part", func(r *CanonicalRequest) {
			r.Messages[0].Content = json.RawMessage(`[{"type":"private_part","text":"private_text"}]`)
		}},
		{"null_part", func(r *CanonicalRequest) { r.Messages[0].Content = json.RawMessage(`[null]`) }},
		{"object_content", func(r *CanonicalRequest) { r.Messages[0].Content = json.RawMessage(`{"text":"private_text"}`) }},
		{"invalid_text", func(r *CanonicalRequest) { r.Messages[0].Content = json.RawMessage(`[{"type":"text","text":123}]`) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := validationRequest()
			tt.set(req)
			call, err := NewGemini().BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
			if err == nil || call != nil {
				t.Fatalf("discarded request semantics were accepted: err=%v", err)
			}
			if strings.Contains(err.Error(), "private_") {
				t.Fatal("validation error disclosed request content or credentials")
			}
		})
	}
}

func TestAnthropicBuildRejectsResponseFormatsItWouldDiscard(t *testing.T) {
	for _, format := range []string{`{"type":"json_object"}`, `{"type":"json_schema","json_schema":{"name":"private_schema"}}`, `{"type":"text","schema":{}}`, `{}`, `true`, `[]`} {
		t.Run(format, func(t *testing.T) {
			req := validationRequest()
			req.ResponseFormat = json.RawMessage(format)
			call, err := NewAnthropic().BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
			if err == nil || call != nil {
				t.Fatalf("response_format was silently discarded: err=%v", err)
			}
			if strings.Contains(err.Error(), "private_") {
				t.Fatal("validation error disclosed request content or credentials")
			}
		})
	}
}

func TestTextOnlyAdapterNoOpParametersPreserveText(t *testing.T) {
	for _, adapter := range []Adapter{NewGemini(), NewAnthropic()} {
		for _, format := range []string{"", "null", `{"type":"text"}`} {
			t.Run(adapter.ID()+"/"+format, func(t *testing.T) {
				req := validationRequest()
				req.Tools = json.RawMessage(`[]`)
				req.ToolChoice = json.RawMessage(`"auto"`)
				req.ResponseFormat = json.RawMessage(format)
				req.Messages[0].Content = json.RawMessage(`[{"type":"text","text":"hello"},{"text":" world"}]`)
				call, err := adapter.BuildRequest(req, Credential{}, Endpoint{})
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(call.Body), "hello") || !strings.Contains(string(call.Body), "world") {
					t.Fatal("supported text was not preserved")
				}
			})
		}
	}
}

func TestOpenAICompatibleKeepsOptionalParametersForArbitraryModel(t *testing.T) {
	req := validationRequest()
	req.Tools = json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]`)
	req.ToolChoice = json.RawMessage(`{"type":"function","function":{"name":"lookup"}}`)
	req.ResponseFormat = json.RawMessage(`{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"object"}}}`)
	req.Messages[0].Content = json.RawMessage(`[{"type":"text","text":"hello"},{"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}}]`)
	call, err := NewOpenAICompatible("ollama", "http://127.0.0.1:11434/v1").BuildRequest(req, Credential{}, Endpoint{})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(call.Body, &body); err != nil {
		t.Fatal(err)
	}
	for field, original := range map[string]json.RawMessage{"tools": req.Tools, "tool_choice": req.ToolChoice, "response_format": req.ResponseFormat} {
		var want, got any
		if json.Unmarshal(original, &want) != nil || json.Unmarshal(body[field], &got) != nil || !reflect.DeepEqual(want, got) {
			t.Errorf("%s changed on upstream wire", field)
		}
	}
	var messages []Message
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) != 1 || string(messages[0].Content) != string(req.Messages[0].Content) {
		t.Fatal("multimodal message changed on upstream wire")
	}
}

func TestAdapterValidationReturnsTypedStaticFieldsWithoutMutatingRequest(t *testing.T) {
	tests := []struct {
		adapter Adapter
		param   string
		set     func(*CanonicalRequest)
	}{
		{NewGemini(), "tools", func(r *CanonicalRequest) { r.Tools = json.RawMessage(`[{"private_tool":true}]`) }},
		{NewGemini(), "tool_choice", func(r *CanonicalRequest) { r.ToolChoice = json.RawMessage(`"private_choice"`) }},
		{NewGemini(), "response_format", func(r *CanonicalRequest) { r.ResponseFormat = json.RawMessage(`{"type":"private_format"}`) }},
		{NewGemini(), "messages", func(r *CanonicalRequest) {
			r.Messages[0].Content = json.RawMessage(`[{"type":"image_url","image_url":"private_image"}]`)
		}},
		{NewAnthropic(), "response_format", func(r *CanonicalRequest) { r.ResponseFormat = json.RawMessage(`{"type":"private_format"}`) }},
	}
	for _, tt := range tests {
		t.Run(tt.adapter.ID()+"/"+tt.param, func(t *testing.T) {
			req := validationRequest()
			tt.set(req)
			before, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			var unsupported *UnsupportedParameterError
			err = tt.adapter.ValidateRequest(req)
			if !errors.As(err, &unsupported) || unsupported.Param != tt.param {
				t.Fatalf("expected unsupported %s, got %v", tt.param, err)
			}
			if strings.Contains(err.Error(), "private_") {
				t.Fatal("validation error contains request values")
			}
			after, err := json.Marshal(req)
			if err != nil || string(before) != string(after) {
				t.Fatal("validation mutated the canonical request")
			}
		})
	}
	if strings.Contains((&UnsupportedParameterError{Param: "private_value"}).Error(), "private_value") {
		t.Fatal("error text must remain static even when constructed with a private value")
	}
}

func TestAdapterValidationAllowsDefaultsAndRejectsNil(t *testing.T) {
	for _, adapter := range Builtin() {
		t.Run(adapter.ID(), func(t *testing.T) {
			if err := adapter.ValidateRequest(nil); err == nil {
				t.Fatal("nil canonical request accepted")
			}
			for _, empty := range []string{"", "null", " \n null \t"} {
				req := validationRequest()
				req.Tools, req.ToolChoice, req.ResponseFormat = json.RawMessage(empty), json.RawMessage(empty), json.RawMessage(empty)
				req.Messages[0].ToolCalls = json.RawMessage(empty)
				if err := adapter.ValidateRequest(req); err != nil {
					t.Errorf("default values rejected: %v", err)
				}
			}
		})
	}
	for _, choice := range []string{`"auto"`, `"none"`} {
		req := validationRequest()
		req.Tools = json.RawMessage(` [] `)
		req.ToolChoice = json.RawMessage(choice)
		req.ResponseFormat = json.RawMessage(` { "type" : "text" } `)
		req.Messages[0].ToolCalls = json.RawMessage(`[]`)
		if err := NewGemini().ValidateRequest(req); err != nil {
			t.Errorf("no-op tool choice rejected: %v", err)
		}
	}
}

func TestGeminiValidationRejectsEveryNonTextContentPart(t *testing.T) {
	for _, content := range []string{
		`[{"type":"text","text":"hello","image_url":{"url":"private_image"}}]`,
		`[{"type":"text"}]`, `[{"type":"text","text":null}]`, `[{}]`,
		`[{"type":null,"text":"hello"}]`, `["hello"]`, `true`, `123`,
	} {
		t.Run(content, func(t *testing.T) {
			req := validationRequest()
			req.Messages[0].Content = json.RawMessage(content)
			var unsupported *UnsupportedParameterError
			if err := NewGemini().ValidateRequest(req); !errors.As(err, &unsupported) || unsupported.Param != "messages" {
				t.Fatalf("unsupported content accepted: %v", err)
			}
		})
	}
}

func TestGeminiCapabilitiesMatchImplementedTranslation(t *testing.T) {
	for _, model := range []string{"gemini-2.5-flash", "custom-model"} {
		caps := NewGemini().Capabilities(model)
		if !caps.Text || !caps.Streaming || caps.Vision || caps.ToolCalling || caps.StructuredOutput {
			t.Fatalf("unsupported translation advertised for %s: %+v", model, caps)
		}
	}
}

func TestBuiltinRegistryReportsRequestValidationVersions(t *testing.T) {
	registry, err := NewBuiltinRegistry()
	if err != nil {
		t.Fatal(err)
	}
	versions := registry.Versions()
	want := map[string]string{"anthropic": "1.0.7", "gemini": "1.0.5", "openai": "1.0.5", "deepseek": "1.0.5", "qwen": "1.0.5"}
	if !reflect.DeepEqual(versions, want) {
		t.Fatalf("observable adapter versions = %v, want %v", versions, want)
	}
	for code, version := range versions {
		adapter, ok := registry.Get(code)
		if !ok || version == "" || adapter.Version() != version {
			t.Errorf("registry and adapter versions disagree for %s", code)
		}
	}
}
