package connectorclient

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type localTLSAuthority struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newLocalTLSAuthority(t *testing.T) localTLSAuthority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "connector-test-private-ca"},
		NotBefore: now.Add(-24 * time.Hour), NotAfter: now.Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return localTLSAuthority{cert: cert, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (ca localTLSAuthority) leaf(t *testing.T, ip string, expired bool) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "connector-test-origin"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IPAddresses: []net.IP{net.ParseIP(ip)},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if expired {
		template.NotBefore, template.NotAfter = now.Add(-3*time.Hour), now.Add(-2*time.Hour)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der, ca.cert.Raw}, PrivateKey: key}
}

func localTLSCAFile(t *testing.T, ca localTLSAuthority) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private-ca.pem")
	if err := os.WriteFile(path, ca.pem, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

type localTLSLogs struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *localTLSLogs) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(b)
}

func (l *localTLSLogs) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func localTLSServer(t *testing.T, cert tls.Certificate, h2 bool, maxVersion uint16, logs *localTLSLogs, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.EnableHTTP2 = h2
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12, MaxVersion: maxVersion}
	server.Config.ErrorLog = log.New(logs, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func TestConfiguredPrivateCAForRemoteAndLocalHTTPS(t *testing.T) {
	for _, tc := range []struct {
		name       string
		h2         bool
		maxVersion uint16
	}{
		{name: "http1_tls12", maxVersion: tls.VersionTLS12},
		{name: "http2", h2: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const localKey = "private-local-tls-api-key-fixture"
			t.Setenv("NEXUS_CONNECTOR_TLS_TEST_KEY", localKey)
			ca := newLocalTLSAuthority(t)
			logs := &localTLSLogs{}
			sink := newStreamTimeoutSink()
			var modelCalls, chatCalls, remoteCalls atomic.Int32
			var remotePrivate atomic.Bool
			local := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), tc.h2, tc.maxVersion, logs, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				wantProtocol := 1
				if tc.h2 {
					wantProtocol = 2
				}
				if r.ProtoMajor != wantProtocol {
					t.Errorf("local request protocol=%d, want %d", r.ProtoMajor, wantProtocol)
				}
				if tc.maxVersion != 0 && r.TLS.Version != tc.maxVersion {
					t.Error("local request did not use the required TLS version")
				}
				if r.Header.Get("Authorization") != "Bearer "+localKey {
					t.Error("local upstream authorization was lost")
				}
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
					modelCalls.Add(1)
					_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"},{"id":"unapproved-model"}]}`)
				case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
					chatCalls.Add(1)
					body, err := io.ReadAll(r.Body)
					var request struct {
						Model  string `json:"model"`
						Stream bool   `json:"stream"`
					}
					if err != nil || json.Unmarshal(body, &request) != nil || request.Model != "qwen2.5:7b" || !request.Stream {
						t.Error("fixed chat request was not preserved")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					w.Header().Set("X-Private-Upstream", localKey)
					_, _ = io.WriteString(w, streamTimeoutPrefix)
				default:
					t.Error("local request escaped the fixed endpoint boundary")
					http.NotFound(w, r)
				}
			}))
			remote := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), tc.h2, tc.maxVersion, logs, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				remoteCalls.Add(1)
				if strings.Contains(r.Header.Get("Authorization"), localKey) || strings.Contains(r.Header.Get("X-Private-Upstream"), localKey) {
					remotePrivate.Store(true)
				}
				if r.URL.Path == "/api/connector/pair" {
					body, err := io.ReadAll(r.Body)
					if err != nil || bytes.Contains(body, []byte(localKey)) {
						remotePrivate.Store(true)
					}
					if r.Header.Get("Authorization") != "Bearer nxpair_tls-fixture" {
						t.Error("remote pair credential was not preserved")
					}
					_ = json.NewEncoder(w).Encode(Identity{ConnectorID: "connector-tls", ConnectionID: "connection-tls", TenantID: "tenant-tls",
						Credential: "nxidentity_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))})
					return
				}
				if r.Header.Get("Authorization") != "Bearer "+networkLeaseToken {
					t.Error("remote job transport credential was not preserved")
				}
				sink.serve(w, r)
			}))
			cfg := configFixture()
			cfg.ControlURL, cfg.GatewayURL, cfg.UpstreamURL = remote.URL, remote.URL, local.URL+"/v1"
			cfg.CAFile, cfg.APIKeyEnv = localTLSCAFile(t, ca), "NEXUS_CONNECTOR_TLS_TEST_KEY"
			client, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(client.remote.CloseIdleConnections)
			t.Cleanup(client.local.CloseIdleConnections)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := client.Pair(ctx, "nxpair_tls-fixture"); err != nil {
				t.Fatal("configured CA did not establish remote trust")
			}
			if models := client.readyModels(ctx); len(models) != 1 || models[0] != "qwen2.5:7b" {
				t.Errorf("configured CA did not establish local model discovery: %v", models)
			}
			streamTimeoutExecute(t, client, streamTimeoutJob(time.Now().Add(5*time.Second)))
			capture := streamTimeoutResult(t, sink)
			var decoded bytes.Buffer
			for _, next := range capture.frames {
				decoded.Write(next.Data)
			}
			if remotePrivate.Load() || bytes.Contains(capture.raw, []byte(localKey)) || bytes.Contains(decoded.Bytes(), []byte(localKey)) || strings.Contains(logs.String(), localKey) {
				t.Error("local credential escaped into remote transport, result frames, or fixture logs")
			}
			if modelCalls.Load() != 1 || chatCalls.Load() != 1 || remoteCalls.Load() < 2 {
				t.Errorf("unexpected actual HTTP calls: models=%d chat=%d remote=%d", modelCalls.Load(), chatCalls.Load(), remoteCalls.Load())
			}
			streamTimeoutCheckTerminal(t, capture, "end", "")
		})
	}
}

func TestLocalHTTPSRejectsInvalidCertificates(t *testing.T) {
	for _, name := range []string{"no_ca", "unrelated_ca", "wrong_ip_san", "expired_leaf"} {
		t.Run(name, func(t *testing.T) {
			ca := newLocalTLSAuthority(t)
			configuredCA := ca
			if name == "unrelated_ca" {
				configuredCA = newLocalTLSAuthority(t)
			}
			ip := "127.0.0.1"
			if name == "wrong_ip_san" {
				ip = "192.0.2.1"
			}
			var calls atomic.Int32
			logs := &localTLSLogs{}
			server := localTLSServer(t, ca.leaf(t, ip, name == "expired_leaf"), false, 0, logs, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"}]}`)
			}))
			cfg := configFixture()
			cfg.UpstreamURL = server.URL + "/v1"
			if name != "no_ca" {
				cfg.CAFile = localTLSCAFile(t, configuredCA)
			}
			client, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(client.remote.CloseIdleConnections)
			t.Cleanup(client.local.CloseIdleConnections)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.UpstreamURL+"/models", nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := client.local.Do(request)
			if response != nil {
				_ = response.Body.Close()
			}
			if err == nil {
				t.Fatal("invalid local server certificate was accepted")
			}
			switch name {
			case "no_ca", "unrelated_ca":
				var authority x509.UnknownAuthorityError
				if !errors.As(err, &authority) {
					t.Errorf("expected unknown CA rejection, got %T: %v", err, err)
				}
			case "wrong_ip_san":
				var hostname x509.HostnameError
				if !errors.As(err, &hostname) || hostname.Host != "127.0.0.1" {
					t.Errorf("expected literal IP SAN rejection, got %T: %v", err, err)
				}
			case "expired_leaf":
				var invalid x509.CertificateInvalidError
				if !errors.As(err, &invalid) || invalid.Reason != x509.Expired {
					t.Errorf("expected certificate expiry rejection, got %T: %v", err, err)
				}
			}
			if models := client.readyModels(ctx); len(models) != 0 || calls.Load() != 0 {
				t.Errorf("invalid TLS identity reached HTTP handler or model readiness: models=%v calls=%d", models, calls.Load())
			}
		})
	}
}
