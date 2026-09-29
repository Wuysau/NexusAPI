package provider

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
)

func completionLimitRequest(effective, modern *int) *CanonicalRequest {
	return &CanonicalRequest{
		Model: "custom-model:latest", Stream: true,
		Messages:            []Message{{Role: "user", Content: json.RawMessage(`"hello"`)}},
		MaxTokens:           effective,
		MaxCompletionTokens: modern,
	}
}

func completionLimitBody(t *testing.T, adapter Adapter, req *CanonicalRequest, endpoint Endpoint) map[string]json.RawMessage {
	t.Helper()
	before, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	call, err := adapter.BuildRequest(req, Credential{Secret: "fixture-secret"}, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	after, err := json.Marshal(req)
	if err != nil || string(before) != string(after) {
		t.Fatal("building one provider request mutated the canonical request")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(call.Body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func assertCompletionLimitFields(t *testing.T, body map[string]json.RawMessage, field string, value int) {
	t.Helper()
	for _, candidate := range []string{"max_tokens", "max_completion_tokens"} {
		raw, exists := body[candidate]
		if candidate == field {
			if !exists || string(raw) != strconv.Itoa(value) {
				t.Errorf("%s = %s, want %d", candidate, raw, value)
			}
		} else if exists {
			t.Errorf("unexpected %s on upstream wire", candidate)
		}
	}
}

func TestOpenAICompletionLimitPreservesSelectedField(t *testing.T) {
	cap := 17
	for _, adapterID := range []string{"openai", "qwen", "custom-compatible"} {
		for _, tc := range []struct {
			name      string
			effective *int
			modern    *int
			field     string
		}{
			{"omitted", nil, nil, ""},
			{"legacy", &cap, nil, "max_tokens"},
			{"modern", &cap, &cap, "max_completion_tokens"},
		} {
			t.Run(adapterID+"/"+tc.name, func(t *testing.T) {
				req := completionLimitRequest(tc.effective, tc.modern)
				body := completionLimitBody(t, NewOpenAICompatible(adapterID, "https://fixture.invalid/v1"), req, Endpoint{})
				assertCompletionLimitFields(t, body, tc.field, cap)
				var model string
				if json.Unmarshal(body["model"], &model) != nil || model != req.Model {
					t.Fatal("model identifier changed while choosing the token field")
				}
			})
		}
	}
}

func TestOpenAICompletionLimitUsesExplicitProviderFacts(t *testing.T) {
	cap := 23
	for _, tc := range []struct {
		name, adapterID, providerCode, model, baseURL, field string
	}{
		{"ollama_registry", "ollama", "", "custom-model", "https://fixture.invalid/v1", "max_tokens"},
		{"deepseek_registry", "deepseek", "", "custom-model", "https://fixture.invalid/v1", "max_tokens"},
		{"ollama_protocol", "openai", "ollama", "o1", "https://connector.invalid/v1", "max_tokens"},
		{"deepseek_protocol", "openai", "deepseek", "custom-model", "https://fixture.invalid/v1", "max_tokens"},
		{"explicit_openai_over_registry", "deepseek", "openai", "custom-model", "https://fixture.invalid/v1", "max_completion_tokens"},
		{"explicit_qwen_over_registry", "ollama", "qwen", "custom-model", "https://fixture.invalid/v1", "max_completion_tokens"},
		{"custom_provider_over_registry", "deepseek", "custom-provider", "deepseek-reasoner", "https://fixture.invalid/v1", "max_completion_tokens"},
		{"model_name_is_not_provider", "openai", "", "ollama/deepseek-reasoner", "https://fixture.invalid/v1", "max_completion_tokens"},
		{"local_url_is_not_provider", "openai", "", "custom-model", "http://127.0.0.1:11434/v1", "max_completion_tokens"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := completionLimitRequest(&cap, &cap)
			req.Model = tc.model
			body := completionLimitBody(t, NewOpenAICompatible(tc.adapterID, tc.baseURL), req, Endpoint{ProviderCode: tc.providerCode, Protocol: "openai"})
			assertCompletionLimitFields(t, body, tc.field, cap)
		})
	}
	// The field is selected from explicit caller input. Modern-looking model
	// names alone must not rewrite legacy requests.
	req := completionLimitRequest(&cap, nil)
	req.Model = "o1"
	body := completionLimitBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{})
	assertCompletionLimitFields(t, body, "max_tokens", cap)
}

func TestLegacyCompatibleCompletionLimitDefaultsStayUnchanged(t *testing.T) {
	cap := 29
	for _, providerCode := range []string{"ollama", "deepseek"} {
		for _, explicit := range []bool{false, true} {
			t.Run(providerCode+"/explicit="+strconv.FormatBool(explicit), func(t *testing.T) {
				req := completionLimitRequest(nil, nil)
				field := ""
				if explicit {
					req.MaxTokens = &cap
					field = "max_tokens"
				}
				body := completionLimitBody(t, NewOpenAICompatible("openai", "https://fixture.invalid/v1"), req, Endpoint{ProviderCode: providerCode})
				assertCompletionLimitFields(t, body, field, cap)
			})
		}
	}
}

func TestNativeAdaptersKeepEffectiveCompletionLimit(t *testing.T) {
	cap := 31
	for _, adapter := range []Adapter{NewAnthropic(), NewGemini()} {
		for _, modern := range []bool{false, true} {
			t.Run(adapter.ID()+"/modern="+strconv.FormatBool(modern), func(t *testing.T) {
				req := completionLimitRequest(&cap, nil)
				if modern {
					req.MaxCompletionTokens = &cap
				}
				body := completionLimitBody(t, adapter, req, Endpoint{ProviderCode: adapter.ID()})
				if _, exists := body["max_completion_tokens"]; exists {
					t.Fatal("OpenAI-specific parameter leaked into the native provider request")
				}
				if adapter.ID() == "anthropic" {
					assertCompletionLimitFields(t, body, "max_tokens", cap)
				} else {
					var generation map[string]json.RawMessage
					if json.Unmarshal(body["generationConfig"], &generation) != nil || string(generation["maxOutputTokens"]) != strconv.Itoa(cap) {
						t.Fatal("Gemini lost the effective output limit")
					}
					assertCompletionLimitFields(t, body, "", cap)
				}
			})
		}
	}
	// Native omission policies are part of their existing wire contract.
	request := completionLimitRequest(nil, nil)
	anthropic := completionLimitBody(t, NewAnthropic(), request, Endpoint{})
	assertCompletionLimitFields(t, anthropic, "max_tokens", defaultAnthropicMaxTokens)
	gemini := completionLimitBody(t, NewGemini(), request, Endpoint{})
	if _, exists := gemini["generationConfig"]; exists {
		t.Fatal("omitted output limit created a Gemini generation constraint")
	}
}

func TestCompletionLimitAdapterVersionIsObservable(t *testing.T) {
	registry, err := NewBuiltinRegistry()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"openai": "1.0.2", "deepseek": "1.0.2", "qwen": "1.0.2", "anthropic": "1.0.2", "gemini": "1.0.2"}
	if got := registry.Versions(); !reflect.DeepEqual(got, want) {
		t.Fatalf("adapter versions = %v, want %v", got, want)
	}
}
