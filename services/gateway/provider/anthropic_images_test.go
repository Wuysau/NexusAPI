package provider

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func anthropicImageJSON(t *testing.T, got, want json.RawMessage) {
	t.Helper()
	var actual, expected any
	if err := json.Unmarshal(got, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("Anthropic image content changed\ngot: %s\nwant: %s", got, want)
	}
}

func anthropicImageBuild(t *testing.T, request *CanonicalRequest) json.RawMessage {
	t.Helper()
	before, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	contents := make([]string, len(request.Messages))
	for i, message := range request.Messages {
		contents[i] = string(message.Content)
	}
	adapter := NewAnthropic()
	if err := adapter.ValidateRequest(request); err != nil {
		t.Fatalf("supported image rejected before build: %v", err)
	}
	first, err := adapter.BuildRequest(request, Credential{}, Endpoint{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := adapter.BuildRequest(request, Credential{}, Endpoint{})
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatal("building image history twice changed the upstream request")
	}
	after, err := json.Marshal(request)
	if err != nil || string(before) != string(after) {
		t.Fatal("image translation mutated the canonical request")
	}
	for i, message := range request.Messages {
		if contents[i] != string(message.Content) {
			t.Fatal("image translation changed canonical raw content bytes")
		}
	}
	return first.Body
}

func TestAnthropicImagesConvertSupportedSources(t *testing.T) {
	for _, source := range []struct{ name, url, native string }{
		{"https", "https://fixture.invalid/image.png?token=a%2Fb&name=a+b#part", `{"type":"url","url":"https://fixture.invalid/image.png?token=a%2Fb&name=a+b#part"}`},
		{"jpeg", "data:image/jpeg;base64,eA==", `{"type":"base64","media_type":"image/jpeg","data":"eA=="}`},
		{"png", "data:image/png;base64,eA==", `{"type":"base64","media_type":"image/png","data":"eA=="}`},
		{"gif", "data:image/gif;base64,eA==", `{"type":"base64","media_type":"image/gif","data":"eA=="}`},
		{"webp", "data:image/webp;base64,eA==", `{"type":"base64","media_type":"image/webp","data":"eA=="}`},
	} {
		for _, detail := range []string{"", `,"detail":null`, `,"detail":"auto"`} {
			t.Run(source.name+"/"+detail, func(t *testing.T) {
				url, _ := json.Marshal(source.url)
				req := &CanonicalRequest{Model: "arbitrary-model", Messages: []Message{{Role: "user", Content: json.RawMessage(`[{"type":"image_url","image_url":{"url":` + string(url) + detail + `}}]`)}}}
				var body struct{ Messages []anthropicMsg }
				if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
					t.Fatal(err)
				}
				if len(body.Messages) != 1 {
					t.Fatal("image translation changed message count")
				}
				anthropicImageJSON(t, body.Messages[0].Content, json.RawMessage(`[{"type":"image","source":`+source.native+`}]`))
			})
		}
	}
	if !NewAnthropic().Capabilities("arbitrary-model").Vision {
		t.Fatal("working image translation no longer advertises vision")
	}
}

func TestAnthropicImagesPreserveOrderAndNativeToolHistory(t *testing.T) {
	const original = `[
		{ "type":"text", "text":"before", "cache_control":{"type":"ephemeral"} },
		{"type":"image_url","image_url":{"url":"https://fixture.invalid/picture.png"}},
		{"type":"image","source":{"type":"file","file_id":"native-file"},"cache_control":{"type":"ephemeral"}},
		{"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}},
		{"type":"text","text":"after"}
	]`
	const converted = `[
		{"type":"text","text":"before","cache_control":{"type":"ephemeral"}},
		{"type":"image","source":{"type":"url","url":"https://fixture.invalid/picture.png"}},
		{"type":"image","source":{"type":"file","file_id":"native-file"},"cache_control":{"type":"ephemeral"}},
		{"type":"image","source":{"type":"base64","media_type":"image/png","data":"eA=="}},
		{"type":"text","text":"after"}
	]`
	for _, role := range []string{"user", "assistant", "tool", "assistant_with_tools"} {
		t.Run(role, func(t *testing.T) {
			message := Message{Role: role, Content: json.RawMessage(original)}
			want := json.RawMessage(converted)
			if role == "tool" {
				message.ToolCallID = "call_fixture"
				want = json.RawMessage(`[{"type":"tool_result","tool_use_id":"call_fixture","content":` + converted + `}]`)
			}
			if role == "assistant_with_tools" {
				message.Role = "assistant"
				message.ToolCalls = json.RawMessage(`[{"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"value\"}"}}]`)
				want = json.RawMessage(strings.TrimSuffix(strings.TrimSpace(converted), "]") + `,{"type":"tool_use","id":"call_fixture","name":"lookup","input":{"key":"value"}}]`)
			}
			req := &CanonicalRequest{Model: "custom-model", Messages: []Message{message}}
			var body struct{ Messages []anthropicMsg }
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Messages) != 1 {
				t.Fatal("image translation changed message count")
			}
			anthropicImageJSON(t, body.Messages[0].Content, want)
		})
	}
}

func TestAnthropicImagesRejectUnpreservablePartsBeforeBuild(t *testing.T) {
	parts := []struct{ name, part string }{
		{"missing_image_url", `{"type":"image_url"}`},
		{"null_image_url", `{"type":"image_url","image_url":null}`},
		{"string_image_url", `{"type":"image_url","image_url":"https://private.invalid/image"}`},
		{"array_image_url", `{"type":"image_url","image_url":[]}`},
		{"missing_url", `{"type":"image_url","image_url":{}}`},
		{"null_url", `{"type":"image_url","image_url":{"url":null}}`},
		{"number_url", `{"type":"image_url","image_url":{"url":7}}`},
		{"block_extra", `{"type":"image_url","image_url":{"url":"https://private.invalid/image"},"private_option":true}`},
		{"source_extra", `{"type":"image_url","image_url":{"url":"https://private.invalid/image","private_option":true}}`},
	}
	for _, detail := range []string{`"low"`, `"high"`, `""`, `17`, `true`, `{}`, `[]`} {
		parts = append(parts, struct{ name, part string }{"detail_" + detail, `{"type":"image_url","image_url":{"url":"https://private.invalid/image","detail":` + detail + `}}`})
	}
	for _, url := range []string{
		"", "http://private.invalid/image", "ftp://private.invalid/image", "file:///private-image", "/private-image", "//private.invalid/image",
		"https:private-image", "https:///private-image", "https://user:private-password@private.invalid/image", "https://:443/private-image", "https://[private/image", "https://private.invalid/private image",
		"data:image/svg+xml;base64,eA==", "data:application/pdf;base64,eA==", "data:image/png,eA==", "data:image/png;charset=utf-8;base64,eA==", "data:image/png;base64,", "data:image/png;base64,private!", "data:image/png;base64,eA", "data:image/png;base64,eB==", "data:image/png;base64,_w==", "data:image/png;base64,eA==\n",
	} {
		encoded, _ := json.Marshal(url)
		parts = append(parts, struct{ name, part string }{"url_" + url, `{"type":"image_url","image_url":{"url":` + string(encoded) + `}}`})
	}
	for _, tc := range parts {
		t.Run(tc.name, func(t *testing.T) {
			req := &CanonicalRequest{Model: "fixture", Messages: []Message{{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"private text"},` + tc.part + `]`)}}}
			assertAnthropicImageRejected(t, req)
		})
	}
}

func assertAnthropicImageRejected(t *testing.T, req *CanonicalRequest) {
	t.Helper()
	before, _ := json.Marshal(req)
	adapter := NewAnthropic()
	validationErr := adapter.ValidateRequest(req)
	call, buildErr := adapter.BuildRequest(req, Credential{Secret: "private_secret"}, Endpoint{})
	if call != nil {
		t.Error("unsupported image semantics produced an upstream request")
	}
	for phase, err := range map[string]error{"validate": validationErr, "build": buildErr} {
		var unsupported *UnsupportedParameterError
		if !errors.As(err, &unsupported) || unsupported.Param != "messages" {
			t.Errorf("%s must return unsupported messages, got %v", phase, err)
		} else if err.Error() != "unsupported request parameter" {
			t.Errorf("%s disclosed request values: %v", phase, err)
		}
	}
	after, _ := json.Marshal(req)
	if string(before) != string(after) {
		t.Fatal("image rejection mutated the canonical request")
	}
}

func TestAnthropicImagesRejectNonTextSystemAndDeveloperContent(t *testing.T) {
	for _, role := range []string{"system", "developer"} {
		for _, content := range []string{
			`[{"type":"image_url","image_url":{"url":"https://private.invalid/image"}}]`,
			`[{"type":"text","text":"keep"},{"type":"image","source":{"type":"url","url":"https://private.invalid/image"}}]`,
			`[{"type":"text","text":"keep","cache_control":{"type":"ephemeral"}}]`,
			`[{"text":"keep","private_option":true}]`, `[null]`, `{"text":"private text"}`,
		} {
			t.Run(role+"/"+content, func(t *testing.T) {
				req := &CanonicalRequest{Model: "fixture", Messages: []Message{{Role: role, Content: json.RawMessage(content)}, {Role: "user", Content: json.RawMessage(`"hello"`)}}}
				assertAnthropicImageRejected(t, req)
			})
		}
	}
}

func TestAnthropicImagesKeepExistingTextAndNativeContent(t *testing.T) {
	for _, content := range []string{`"hello"`, `null`, `[]`, `[{"type":"text","text":"hello"}]`, `[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"eA=="},"cache_control":{"type":"ephemeral"}}]`, `[{"type":"document","source":{"type":"file","file_id":"native-file"},"title":"keep me"}]`} {
		t.Run(content, func(t *testing.T) {
			req := &CanonicalRequest{Model: "fixture", Messages: []Message{{Role: "user", Content: json.RawMessage(content)}}}
			var body struct{ Messages []anthropicMsg }
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil {
				t.Fatal(err)
			}
			anthropicImageJSON(t, body.Messages[0].Content, json.RawMessage(content))
		})
	}
	for _, role := range []string{"system", "developer"} {
		t.Run(role, func(t *testing.T) {
			req := &CanonicalRequest{Model: "fixture", Messages: []Message{{Role: role, Content: json.RawMessage(`[{"text":"before"},{"type":"text","text":" after"}]`)}, {Role: "user", Content: json.RawMessage(`"hello"`)}}}
			var body struct{ System string }
			if err := json.Unmarshal(anthropicImageBuild(t, req), &body); err != nil || body.System != "before after" {
				t.Fatalf("valid text system content changed: %q %v", body.System, err)
			}
		})
	}
}
