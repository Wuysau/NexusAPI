package main

import (
	"encoding/json"
	"testing"
)

func TestLocalUnpricedBYOK(t *testing.T) {
	for _, tc := range []struct {
		name, mode, env    string
		local, v2, allowed bool
	}{
		{"local-byok", "byok", "development", true, true, true},
		{"managed", "managed", "development", true, true, false},
		{"no-local-profile", "byok", "development", false, true, false},
		{"v1", "byok", "development", true, false, false},
		{"production", "byok", "production", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{EnableUsageV2: tc.v2, CredentialMode: tc.mode, NoPrice: true})
			h.proxy.env.Environment = tc.env
			if tc.local {
				h.proxy.env.LocalCredentialDir = t.TempDir()
			}
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			body := readAll(response)
			if !tc.allowed {
				if response.StatusCode == 200 {
					t.Fatal("unpriced request was allowed")
				}
				return
			}
			if response.StatusCode != 200 {
				t.Fatalf("status=%d %s", response.StatusCode, body)
			}
			records := h.store.Requests()
			if len(records) != 1 {
				t.Fatalf("records=%d", len(records))
			}
			record := records[0]
			if err := record.Validate(); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(record.EventV2)
			var e map[string]any
			_ = json.Unmarshal(raw, &e)
			if e["price_version_id"] != nil {
				t.Fatalf("fabricated price: %s", raw)
			}
			if record.EventV2.Usage.InputTokens == nil {
				t.Fatal("known provider usage lost")
			}
		})
	}
}
