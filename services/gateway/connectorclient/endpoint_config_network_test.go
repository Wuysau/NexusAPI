package connectorclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnectorEndpointConfigurationRejectsComponents(t *testing.T) {
	for _, target := range []string{"control", "gateway", "upstream"} {
		for _, suffix := range []struct{ name, value string }{
			{"empty_query", "?"}, {"empty_fragment", "#"},
			{"query", "?fixture=1"}, {"fragment", "#fixture"},
		} {
			t.Run(target+"/"+suffix.name, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					http.NotFound(w, r)
				}))
				t.Cleanup(server.Close)
				cfg := configFixture()
				cfg.AllowHTTPDevelopment = true
				wantError := "remote URL must be an HTTPS origin"
				switch target {
				case "control":
					cfg.ControlURL = server.URL + suffix.value
				case "gateway":
					cfg.GatewayURL = server.URL + suffix.value
				case "upstream":
					cfg.UpstreamURL = server.URL + "/v1" + suffix.value
					wantError = "upstream must be an explicit private IP OpenAI /v1 endpoint"
				}
				client, err := New(cfg)
				if err == nil {
					t.Cleanup(client.remote.CloseIdleConnections)
					t.Cleanup(client.local.CloseIdleConnections)
					ctx, cancel := context.WithTimeout(context.Background(), time.Second)
					defer cancel()
					// Exercise the accepted old configuration through a real request,
					// making the failure's network side effect observable.
					switch target {
					case "control":
						_, _ = client.Pair(ctx, "nxpair_endpoint_fixture")
					case "gateway":
						_, _, _ = client.poll(ctx, networkLeaseToken)
					case "upstream":
						_, _ = client.discoverModels(ctx)
					}
				}
				if err == nil || client != nil || err.Error() != wantError || calls.Load() != 0 {
					t.Fatalf("URL component was not rejected with its static error before HTTP: calls=%d", calls.Load())
				}
			})
		}
	}
	for _, suffix := range []string{"?", "#"} {
		name := "localhost_empty_query"
		if suffix == "#" {
			name = "localhost_empty_fragment"
		}
		t.Run(name, func(t *testing.T) {
			cfg := configFixture()
			cfg.UpstreamURL = "http://localhost:1/v1" + suffix
			if client, err := New(cfg); err == nil || client != nil || err.Error() != "upstream must be an explicit private IP OpenAI /v1 endpoint" {
				t.Fatal("localhost spelling bypassed upstream component rejection")
			}
		})
	}
	for _, target := range []string{"control", "gateway"} {
		t.Run(target+"/multiple_root_slashes", func(t *testing.T) {
			cfg := configFixture()
			if target == "control" {
				cfg.ControlURL += "///"
			} else {
				cfg.GatewayURL += "///"
			}
			if client, err := New(cfg); err == nil || client != nil {
				t.Fatal("a remote path became an accepted origin")
			}
		})
	}
}

func TestConnectorEndpointConfigurationCanonicalLocalPaths(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		tls        bool
	}{
		{name: "canonical", path: "/v1"},
		{name: "literal_slashes", path: "/v1///"},
		{name: "escaped_slash", path: "/v1%2f"},
		{name: "escaped_and_literal_slashes", path: "/v1%2F/"},
		{name: "escaped_multiple_slashes", path: "/v1%2f%2f"},
		{name: "escaped_digit", path: "/v%31"},
		{name: "escaped_name", path: "/%76%31"},
		{name: "verified_https", path: "/v1%2f", tls: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const localKey = "endpoint-local-fixture-key"
			t.Setenv("NEXUS_CONNECTOR_ENDPOINT_TEST_KEY", localKey)
			var models, inference, unexpected atomic.Int32
			localHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.tls && (r.TLS == nil || r.ProtoMajor != 2) {
					t.Error("private HTTPS control did not negotiate verified HTTP/2")
				}
				if r.URL.RawQuery != "" || r.RequestURI != r.URL.Path || r.Header.Get("Authorization") != "Bearer "+localKey {
					t.Error("accepted local URL did not use a canonical fixed path with local-only authentication")
				}
				switch r.URL.Path {
				case "/v1/models":
					models.Add(1)
					if r.Method != http.MethodGet {
						t.Error("discovery changed its fixed GET")
					}
					_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"}]}`)
				case "/v1/chat/completions":
					inference.Add(1)
					var body struct {
						Model string `json:"model"`
					}
					if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&body) != nil || body.Model != "qwen2.5:7b" {
						t.Error("inference changed its fixed POST or configured model")
					}
					_, _ = io.WriteString(w, streamTimeoutPrefix)
				default:
					unexpected.Add(1)
					http.NotFound(w, r)
				}
			})
			cfg := configFixture()
			var local *httptest.Server
			if tc.tls {
				ca := newLocalTLSAuthority(t)
				local = localTLSServer(t, ca.leaf(t, "127.0.0.1", false), true, 0, &localTLSLogs{}, localHandler)
				cfg.CAFile = localTLSCAFile(t, ca)
			} else {
				local = httptest.NewServer(localHandler)
				t.Cleanup(local.Close)
			}
			cfg.UpstreamURL, cfg.APIKeyEnv = local.URL+tc.path, "NEXUS_CONNECTOR_ENDPOINT_TEST_KEY"
			sink := newStreamTimeoutSink()
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+networkLeaseToken || strings.Contains(r.Header.Get("Authorization"), localKey) {
					t.Error("local credential escaped into Gateway transport")
				}
				sink.serve(w, r)
			}))
			t.Cleanup(remote.Close)
			cfg.GatewayURL, cfg.AllowHTTPDevelopment = remote.URL, true
			client, err := New(cfg)
			if err != nil {
				t.Fatal("a previously allowed private /v1 spelling was rejected")
			}
			t.Cleanup(client.remote.CloseIdleConnections)
			t.Cleanup(client.local.CloseIdleConnections)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if ready, status := client.discoverModels(ctx); status != CheckOK || len(ready) != 1 || ready[0] != "qwen2.5:7b" {
				t.Error("accepted local URL did not discover its configured model")
			}
			streamTimeoutExecute(t, client, streamTimeoutJob(time.Now().Add(5*time.Second)))
			streamTimeoutCheckTerminal(t, streamTimeoutResult(t, sink), "end", "")
			if models.Load() != 1 || inference.Load() != 1 || unexpected.Load() != 0 {
				t.Fatal("accepted local URL missed a fixed path or repeated inference")
			}
		})
	}
}

func TestConnectorEndpointConfigurationPreservesRemoteIdentityOrigin(t *testing.T) {
	var pairs, polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RequestURI != r.URL.Path || r.URL.RawQuery != "" || r.Method != http.MethodPost {
			t.Error("accepted remote origin changed a fixed POST path")
		}
		switch r.URL.Path {
		case "/api/connector/pair":
			pairs.Add(1)
			_ = json.NewEncoder(w).Encode(Identity{ConnectorID: "connector", ConnectionID: "connection", TenantID: "tenant", Credential: "nxidentity_" + strings.Repeat("A", 43)})
		case "/connector/poll":
			polls.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Error("remote request escaped its fixed endpoint")
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cfg := configFixture()
	cfg.ControlURL, cfg.GatewayURL, cfg.AllowHTTPDevelopment = server.URL+"/", server.URL+"/", true
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.remote.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	identity, err := client.Pair(ctx, "nxpair_endpoint_fixture")
	if err != nil || identity.ControlURL != cfg.ControlURL {
		t.Fatal("remote normalization changed the identity's exact origin binding")
	}
	if _, empty, err := client.poll(ctx, networkLeaseToken); err != nil || !empty || pairs.Load() != 1 || polls.Load() != 1 {
		t.Fatal("normal origin did not pair and poll exactly once")
	}
}
