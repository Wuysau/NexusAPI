package provider

import (
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func reasoningHistoryRequest(t *testing.T, messages string) *CanonicalRequest {
	t.Helper()
	req := &CanonicalRequest{Model: "custom-model:latest"}
	if err := json.Unmarshal([]byte(messages), &req.Messages); err != nil {
		t.Fatal(err)
	}
	return req
}

func reasoningHistoryBody(t *testing.T, adapter Adapter, req *CanonicalRequest, endpoint Endpoint) map[string]json.RawMessage {
	t.Helper()
	before, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	// RawMessage bytes also belong to the caller; preserve even their spacing.
	content, toolCalls := make([]string, len(req.Messages)), make([]string, len(req.Messages))
	for i, message := range req.Messages {
		content[i], toolCalls[i] = string(message.Content), string(message.ToolCalls)
	}
	if err := adapter.ValidateRequest(req); err != nil {
		t.Fatalf("compatible history failed validation: %v", err)
	}
	call, err := adapter.BuildRequest(req, Credential{Secret: "fixture-secret"}, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	after, err := json.Marshal(req)
	if err != nil || string(after) != string(before) {
		t.Fatal("building one provider request mutated canonical history")
	}
	for i, message := range req.Messages {
		if string(message.Content) != content[i] || string(message.ToolCalls) != toolCalls[i] {
			t.Fatalf("building one provider request changed raw message %d", i)
		}
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(call.Body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func assertReasoningHistoryMessages(t *testing.T, body map[string]json.RawMessage, original, reasoningField string) {
	t.Helper()
	var want, got []map[string]any
	if err := json.Unmarshal([]byte(original), &want); err != nil {
		t.Fatal(err)
	}
	for _, message := range want {
		if reasoning, exists := message["reasoning_content"]; exists {
			delete(message, "reasoning_content")
			if reasoning != nil {
				message[reasoningField] = reasoning
			}
		}
	}
	if err := json.Unmarshal(body["messages"], &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("message history changed on the upstream wire\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestReasoningHistoryCompatibleWireUsesExplicitProviderFacts(t *testing.T) {
	const messages = `[
		{"role":"system","content":"Keep the history intact."},
		{"role":"user","content":[ { "type":"text", "text":"hello" }, {"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}} ],"name":"fixture-user"},
		{"role":"assistant","content":null,"name":"fixture-assistant","reasoning_content":"Check \"A\" first.\n再调用工具。","tool_calls":[ {"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"value\"}"}} ]},
		{"role":"tool","content":"tool result","tool_call_id":"call_fixture","name":"lookup"},
		{"role":"assistant","content":"answer","reasoning_content":""},
		{"role":"assistant","content":"ordinary history"},
		{"role":"assistant","content":"nullable history","reasoning_content":null}
	]`
	for _, tc := range []struct {
		name, adapterID, providerCode, model, baseURL, field string
	}{
		{"openai", "openai", "", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"deepseek", "deepseek", "", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"qwen", "qwen", "", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"custom", "custom-compatible", "", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"ollama_registry_fallback", "ollama", "", "custom-model", "https://fixture.invalid/v1", "reasoning"},
		{"signed_ollama", "openai", "ollama", "custom-model", "https://connector.invalid/v1", "reasoning"},
		{"signed_ollama_over_other_registry", "deepseek", "ollama", "custom-model", "https://fixture.invalid/v1", "reasoning"},
		{"signed_openai_over_ollama_registry", "ollama", "openai", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"signed_deepseek_over_ollama_registry", "ollama", "deepseek", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"signed_qwen_over_ollama_registry", "ollama", "qwen", "custom-model", "https://fixture.invalid/v1", "reasoning_content"},
		{"signed_custom_over_ollama_registry", "ollama", "custom-provider", "ollama/deepseek-reasoner", "http://127.0.0.1:11434/v1", "reasoning_content"},
		{"model_is_not_provider", "openai", "", "ollama/deepseek-reasoner", "https://fixture.invalid/v1", "reasoning_content"},
		{"url_is_not_provider", "openai", "", "custom-model", "http://127.0.0.1:11434/v1", "reasoning_content"},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(tc.name+"/stream="+strconv.FormatBool(stream), func(t *testing.T) {
				req := reasoningHistoryRequest(t, messages)
				req.Model, req.Stream = tc.model, stream
				req.Tools = json.RawMessage(`[{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{"key":{"type":"string"}}}}}]`)
				req.ToolChoice = json.RawMessage(`{"type":"function","function":{"name":"lookup"}}`)
				req.ResponseFormat = json.RawMessage(`{"type":"json_schema","json_schema":{"name":"result","schema":{"type":"object"}}}`)
				body := reasoningHistoryBody(t, NewOpenAICompatible(tc.adapterID, "https://default.invalid/v1"), req, Endpoint{ProviderCode: tc.providerCode, Protocol: "openai", BaseURL: tc.baseURL})
				assertReasoningHistoryMessages(t, body, messages, tc.field)
				for field, raw := range map[string]json.RawMessage{"tools": req.Tools, "tool_choice": req.ToolChoice, "response_format": req.ResponseFormat} {
					var got, want any
					if json.Unmarshal(body[field], &got) != nil || json.Unmarshal(raw, &want) != nil || !reflect.DeepEqual(got, want) {
						t.Errorf("%s changed while preserving reasoning history", field)
					}
				}
				var model string
				if json.Unmarshal(body["model"], &model) != nil || model != req.Model || string(body["stream"]) != strconv.FormatBool(stream) {
					t.Fatal("model or stream changed while preserving reasoning history")
				}
				for _, flag := range []string{"think", "thinking", "enable_thinking", "reasoning", "reasoning_effort"} {
					if _, exists := body[flag]; exists {
						t.Errorf("history unexpectedly enabled top-level %s", flag)
					}
				}
				// Reuse this canonical request for another provider, as fallback does.
				reused := reasoningHistoryBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: "deepseek"})
				assertReasoningHistoryMessages(t, reused, messages, "reasoning_content")
			})
		}
	}
}

func TestReasoningHistoryMissingAndNullDoNotInventReasoning(t *testing.T) {
	for _, tc := range []struct{ name, messages string }{
		{"missing", `[{"role":"assistant","content":"answer"}]`},
		{"null", `[{"role":"assistant","content":"answer","reasoning_content":null}]`},
	} {
		for _, providerCode := range []string{"openai", "deepseek", "ollama", "custom-provider"} {
			t.Run(tc.name+"/"+providerCode, func(t *testing.T) {
				req := reasoningHistoryRequest(t, tc.messages)
				body := reasoningHistoryBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: providerCode})
				assertReasoningHistoryMessages(t, body, tc.messages, "reasoning_content")
			})
		}
	}
}

func TestReasoningHistoryDecodeRejectsNonStrings(t *testing.T) {
	for _, value := range []string{`123`, `false`, `[]`, `{}`, `["reason"]`, `{"text":"reason"}`} {
		t.Run(value, func(t *testing.T) {
			var message Message
			err := json.Unmarshal([]byte(`{"role":"assistant","content":"answer","reasoning_content":`+value+`}`), &message)
			var typeError *json.UnmarshalTypeError
			if !errors.As(err, &typeError) {
				t.Fatalf("reasoning_content must use standard string decoding, got %v", err)
			}
		})
	}
}

func TestReasoningHistoryDoesNotIntroduceReasoningInputAlias(t *testing.T) {
	const messages = `[{"role":"assistant","content":"answer","reasoning":"provider-only alias"}]`
	for _, providerCode := range []string{"openai", "ollama"} {
		t.Run(providerCode, func(t *testing.T) {
			req := reasoningHistoryRequest(t, messages)
			body := reasoningHistoryBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: providerCode})
			assertReasoningHistoryMessages(t, body, `[{"role":"assistant","content":"answer"}]`, "reasoning_content")
		})
	}
}

func TestReasoningHistoryNativeAdaptersRejectExplicitHistory(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		for _, role := range []string{"system", "developer", "user", "assistant", "tool"} {
			for _, reasoning := range []string{`"private_reasoning_history"`, `""`} {
				t.Run(adapter.ID()+"/"+role+"/"+reasoning, func(t *testing.T) {
					// Put the unsupported value after ordinary history so validation
					// cannot stop after checking only the first message.
					req := reasoningHistoryRequest(t, `[{"role":"user","content":"hello"},{"role":"`+role+`","content":"answer","reasoning_content":`+reasoning+`}]`)
					before, err := json.Marshal(req)
					if err != nil {
						t.Fatal(err)
					}
					validateErr := adapter.ValidateRequest(req)
					call, buildErr := adapter.BuildRequest(req, Credential{Secret: "private_credential"}, Endpoint{})
					if call != nil {
						t.Fatal("unsupported reasoning history produced an upstream request")
					}
					for phase, err := range map[string]error{"validate": validateErr, "build": buildErr} {
						var unsupported *UnsupportedParameterError
						if !errors.As(err, &unsupported) || unsupported.Param != "messages" {
							t.Errorf("%s must reject reasoning history with messages error, got %v", phase, err)
						} else if strings.Contains(err.Error(), "private_") {
							t.Errorf("%s leaked request content or credentials", phase)
						}
					}
					after, err := json.Marshal(req)
					if err != nil || string(before) != string(after) {
						t.Fatal("native history rejection mutated the canonical request")
					}
				})
			}
		}
	}
}

func TestReasoningHistoryNativeAdaptersPreserveOmittedAndNullCompatibility(t *testing.T) {
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		baseline := reasoningHistoryRequest(t, `[{"role":"user","content":"hello"},{"role":"assistant","content":"answer"}]`)
		want, err := adapter.BuildRequest(baseline, Credential{}, Endpoint{})
		if err != nil {
			t.Fatal(err)
		}
		for _, messages := range []string{
			`[{"role":"user","content":"hello"},{"role":"assistant","content":"answer"}]`,
			`[{"role":"user","content":"hello","reasoning_content":null},{"role":"assistant","content":"answer","reasoning_content":null}]`,
		} {
			t.Run(adapter.ID()+"/"+messages, func(t *testing.T) {
				req := reasoningHistoryRequest(t, messages)
				if err := adapter.ValidateRequest(req); err != nil {
					t.Fatalf("absent reasoning changed native validation: %v", err)
				}
				got, err := adapter.BuildRequest(req, Credential{}, Endpoint{})
				if err != nil || got == nil {
					t.Fatalf("absent reasoning changed native build: %v", err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("absent reasoning changed existing native request\ngot: %+v\nwant: %+v", got, want)
				}
			})
		}
	}
}
