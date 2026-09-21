package provider

import (
	"encoding/json"
	"testing"
)

func TestExplicitAnthropicProtocolUsesSDKBasePath(t *testing.T) {
	for _, tc := range []struct{ base, protocol, want string }{
		{"http://192.168.50.10/dmx/anthropic", "anthropic", "http://192.168.50.10/dmx/anthropic/v1/messages"},
		{"http://127.0.0.1/v1", "anthropic", "http://127.0.0.1/v1/messages"},
		{"http://127.0.0.1/v1/", "anthropic", "http://127.0.0.1/v1/messages"},
		{"https://api.example.com/custom", "", "https://api.example.com/custom/messages"},
	} {
		call, err := NewAnthropic().BuildRequest(&CanonicalRequest{Model: "aliyun/qwen3.8-flash", Messages: []Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}, Credential{Secret: "synthetic-fixture"}, Endpoint{BaseURL: tc.base, Protocol: tc.protocol})
		if err != nil || call.URL != tc.want {
			t.Fatalf("base=%s want=%s err=%v", tc.base, tc.want, err)
		}
	}
}
