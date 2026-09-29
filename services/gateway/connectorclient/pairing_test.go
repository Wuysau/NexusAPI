package connectorclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPairRequiresCompleteIdentityAndCanonicalCredential(t *testing.T) {
	valid := Identity{
		ConnectorID: "connector", ConnectionID: "connection", TenantID: "tenant",
		Credential: "nxidentity_" + strings.Repeat("A", 43), ControlURL: "https://untrusted-response-origin.invalid",
	}
	tests := []struct {
		name   string
		mutate func(*Identity)
		valid  bool
	}{
		{name: "complete", valid: true},
		{name: "missing connector", mutate: func(i *Identity) { i.ConnectorID = "" }},
		{name: "missing connection", mutate: func(i *Identity) { i.ConnectionID = "" }},
		{name: "missing tenant", mutate: func(i *Identity) { i.TenantID = " " }},
		{name: "wrong credential prefix", mutate: func(i *Identity) { i.Credential = "nxlease_" + strings.Repeat("A", 43) }},
		{name: "short credential", mutate: func(i *Identity) { i.Credential = "nxidentity_fixture" }},
		{name: "padded credential", mutate: func(i *Identity) { i.Credential += "=" }},
		{name: "noncanonical trailing bits", mutate: func(i *Identity) { i.Credential = "nxidentity_" + strings.Repeat("A", 42) + "B" }},
		{name: "invalid alphabet", mutate: func(i *Identity) { i.Credential = "nxidentity_" + strings.Repeat("A", 42) + "/" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			response := valid
			if tc.mutate != nil {
				tc.mutate(&response)
			}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != "/api/connector/pair" || r.Header.Get("Authorization") != "Bearer nxpair_fixture" {
					t.Error("pairing request changed its scope or credential")
				}
				_ = json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			config := configFixture()
			config.ControlURL, config.AllowHTTPDevelopment = server.URL, true
			client, err := New(config)
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.Pair(context.Background(), " nxpair_fixture\n")
			if calls.Load() != 1 {
				t.Fatalf("pair must make exactly one attempt: %d", calls.Load())
			}
			if !tc.valid {
				if err != errRemote || got != (Identity{}) {
					t.Fatalf("invalid identity receipt was not discarded: err = %v, empty = %v", err, got == (Identity{}))
				}
				return
			}
			response.ControlURL = config.ControlURL
			if err != nil || got != response {
				t.Fatalf("valid identity or locally bound control origin changed: %v", err)
			}
		})
	}
}
