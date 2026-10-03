package connectorclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func configFixture() Config {
	return Config{ControlURL: "https://control.example.com", GatewayURL: "https://gateway.example.com", UpstreamURL: "http://127.0.0.1:11434/v1", Models: []string{"qwen2.5:7b"}}
}
func TestLocalTargetAndTLSBoundary(t *testing.T) {
	for _, target := range []string{"http://8.8.8.8/v1", "http://169.254.169.254/v1", "file:///etc/passwd", "http://example.com/v1", "http://127.0.0.1/v1?url=evil", "http://secret@127.0.0.1/v1", "http://0.0.0.0/v1", "http://[::]/v1", "http://127.0.0.1/other"} {
		t.Run(target, func(t *testing.T) {
			c := configFixture()
			c.UpstreamURL = target
			if c.Validate() == nil {
				t.Fatal("unsafe target accepted")
			}
		})
	}
	for _, target := range []string{"http://127.0.0.1:11434/v1", "http://192.168.1.4/v1", "https://10.10.1.2/v1", "http://[::1]:11434/v1"} {
		c := configFixture()
		c.UpstreamURL = target
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	for _, origin := range []string{"http://gateway.example.com", "https://secret@gateway.example.com", "https://gateway.example.com/path", "https://gateway.example.com?token=x"} {
		c := configFixture()
		c.GatewayURL = origin
		c.AllowHTTPDevelopment = true
		if c.Validate() == nil {
			t.Fatal("unsafe remote origin accepted")
		}
	}
	c := configFixture()
	c.GatewayURL = "http://127.0.0.1:8080"
	if c.Validate() == nil {
		t.Fatal("HTTP accepted without opt-in")
	}
	c.AllowHTTPDevelopment = true
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}
func TestServerIdentityVerificationAndRedirectRejection(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := w.Write([]byte(`{}`)); err != nil {
			t.Errorf("write identity fixture: %v", err)
		}
	}))
	defer server.Close()
	c := configFixture()
	c.ControlURL = server.URL
	c.GatewayURL = server.URL
	client, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Pair(context.Background(), "nxpair_fixture"); err == nil {
		t.Fatal("untrusted TLS server accepted")
	}
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	c = configFixture()
	c.UpstreamURL = redirect.URL + "/v1"
	client, err = New(c)
	if err != nil {
		t.Fatal(err)
	}
	if len(client.readyModels(context.Background())) != 0 || called {
		t.Fatal("local redirect followed")
	}
}
func TestJobIDsCannotInjectPaths(t *testing.T) {
	for _, id := range []string{"../secret", "req_../secret", "req_0000000000000000000000000000000/", ""} {
		if validJobID(id) {
			t.Fatal("invalid request path accepted")
		}
	}
}
