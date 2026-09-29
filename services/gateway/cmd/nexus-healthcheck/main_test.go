package main

import (
	"context"
	"encoding/pem"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const healthyBody = `{"status":"ready","checks":{"snapshot":true,"database":true,"redis":true}}`

func serverEnvironment(t *testing.T, server *httptest.Server) map[string]string {
	t.Helper()
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"GATEWAY_ADDR": u.Host}
	if u.Scheme == "https" {
		env["GATEWAY_TLS_CERT"] = "configured-server-certificate.pem"
		env["GATEWAY_TLS_KEY"] = "configured-server-key.pem"
	}
	return env
}

func probe(env map[string]string) error {
	return run(context.Background(), func(key string) string { return env[key] })
}

func TestHTTPReadinessRequiresProductionDependencies(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		ready  bool
	}{
		{"healthy", 200, healthyBody, true},
		{"http_unavailable", 503, healthyBody, false},
		{"snapshot_unavailable", 200, `{"status":"ready","checks":{"snapshot":false,"database":true,"redis":true}}`, false},
		{"database_unavailable", 200, `{"status":"ready","checks":{"snapshot":true,"database":false,"redis":true}}`, false},
		{"redis_unavailable", 200, `{"status":"ready","checks":{"snapshot":true,"database":true,"redis":false}}`, false},
		{"status_unavailable", 200, strings.Replace(healthyBody, `"ready"`, `"not_ready"`, 1), false},
		{"missing_check", 200, `{"status":"ready","checks":{"snapshot":true,"database":true}}`, false},
		{"non_boolean_check", 200, strings.Replace(healthyBody, `"redis":true`, `"redis":"true"`, 1), false},
		{"malformed", 200, `{"status":`, false},
		{"extra_document", 200, healthyBody + `{}`, false},
		{"oversized", 200, healthyBody + strings.Repeat(" ", maxBodyBytes), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/readyz" {
					t.Errorf("unexpected readiness request: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			err := probe(serverEnvironment(t, server))
			if (err == nil) != test.ready {
				t.Fatalf("ready = %v, error = %v", test.ready, err)
			}
		})
	}
}

func TestProbeUsesOnlyLocalAddressAndDoesNotFollowRedirects(t *testing.T) {
	var redirectCalls atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectCalls.Add(1)
		_, _ = io.WriteString(w, healthyBody)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	env := serverEnvironment(t, server)
	_, port, _ := net.SplitHostPort(env["GATEWAY_ADDR"])
	// A bind hostname and proxy environment cannot redirect the probe away
	// from the local process. The HTTP redirect is also rejected.
	env["GATEWAY_ADDR"] = "gateway.example.invalid:" + port
	t.Setenv("HTTP_PROXY", target.URL)
	t.Setenv("HTTPS_PROXY", target.URL)
	if err := probe(env); err == nil {
		t.Fatal("redirect accepted as a healthy Gateway")
	}
	if redirectCalls.Load() != 0 {
		t.Fatal("probe followed redirect or used an environment proxy")
	}
	env = serverEnvironment(t, target)
	_, port, _ = net.SplitHostPort(env["GATEWAY_ADDR"])
	env["GATEWAY_ADDR"] = "192.0.2.10:" + port
	if err := probe(env); err != nil {
		t.Fatalf("configured nonlocal bind IP changed loopback destination: %v", err)
	}
}

func TestIPv6Readiness(t *testing.T) {
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback unavailable: %v", err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, healthyBody)
	}))
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	defer server.Close()
	env := serverEnvironment(t, server)
	_, port, _ := net.SplitHostPort(env["GATEWAY_ADDR"])
	env["GATEWAY_ADDR"] = "[::]:" + port
	if err := probe(env); err != nil {
		t.Fatal(err)
	}
}

func TestTLSReadinessVerifiesTrustAndServerIdentity(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, healthyBody)
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	defer server.Close()
	env := serverEnvironment(t, server)
	if err := probe(env); err == nil {
		t.Fatal("untrusted TLS server accepted")
	}
	caPath := filepath.Join(t.TempDir(), "readiness-ca.pem")
	certificate := server.Certificate()
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	env["GATEWAY_HEALTHCHECK_CA_FILE"] = caPath
	if err := probe(env); err != nil {
		t.Fatalf("trusted server with matching loopback IP rejected: %v", err)
	}
	if len(certificate.DNSNames) == 0 {
		t.Fatal("TLS fixture needs a DNS certificate identity")
	}
	env["GATEWAY_HEALTHCHECK_TLS_SERVER_NAME"] = certificate.DNSNames[0]
	if err := probe(env); err != nil {
		t.Fatalf("trusted server with configured DNS identity rejected: %v", err)
	}
	env["GATEWAY_HEALTHCHECK_TLS_SERVER_NAME"] = "wrong-name.example.invalid"
	if err := probe(env); err == nil {
		t.Fatal("wrong TLS server identity accepted")
	}
	delete(env, "GATEWAY_HEALTHCHECK_TLS_SERVER_NAME")
	env["GATEWAY_HEALTHCHECK_CA_FILE"] = filepath.Join(t.TempDir(), "missing.pem")
	if err := probe(env); err == nil {
		t.Fatal("missing private CA accepted")
	}
	if err := os.WriteFile(caPath, []byte("invalid PEM"), 0600); err != nil {
		t.Fatal(err)
	}
	env["GATEWAY_HEALTHCHECK_CA_FILE"] = caPath
	if err := probe(env); err == nil {
		t.Fatal("malformed private CA accepted")
	}
}

func TestProbeRejectsIncompleteConfiguration(t *testing.T) {
	for _, env := range []map[string]string{
		{"GATEWAY_ADDR": "http://127.0.0.1:8080"},
		{"GATEWAY_ADDR": ":invalid"},
		{"GATEWAY_ADDR": ":0"},
		{"GATEWAY_ADDR": ":65536"},
		{"GATEWAY_TLS_CERT": "certificate.pem"},
		{"GATEWAY_TLS_KEY": "key.pem"},
		{"GATEWAY_HEALTHCHECK_CA_FILE": "ca.pem"},
		{"GATEWAY_HEALTHCHECK_TLS_SERVER_NAME": "gateway.example.com"},
	} {
		if err := probe(env); err == nil {
			t.Fatalf("invalid configuration accepted: %v", env)
		}
	}
}

func TestProbeTimeoutBoundsResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	started := time.Now()
	if err := probe(serverEnvironment(t, server)); err == nil {
		t.Fatal("stalled response was accepted")
	}
	if elapsed := time.Since(started); elapsed < 2*time.Second || elapsed > 5*time.Second {
		t.Fatalf("probe timeout was not enforced: %s", elapsed)
	}
}

func TestProbeHonorsEarlierContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	env := serverEnvironment(t, server)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := run(ctx, func(key string) string { return env[key] }); err == nil {
		t.Fatal("cancelled probe accepted")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("caller cancellation was ignored: %s", elapsed)
	}
}
