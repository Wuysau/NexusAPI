package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"nexus/gateway/provider"
)

const localTestSecret = "synthetic-local-credential-fixture"

func localCredentialFixture(t *testing.T, baseURL string) (string, CredentialRef, map[string]any) {
	t.Helper()
	dir := t.TempDir()
	key := bytes.Repeat([]byte{42}, 32)
	if err := os.WriteFile(filepath.Join(dir, "master.key"), key, 0600); err != nil {
		t.Fatal(err)
	}
	ref := CredentialRef{TenantID: "tenant-local", CredentialID: "6d1ac926-d0d2-4f23-b698-bcbf09ded1b6", CredentialVersion: 1, ProviderID: "provider-qwen", Mode: "byok", BaseURL: baseURL, Protocol: "anthropic", Model: "aliyun/qwen3.8-flash"}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := bytes.Repeat([]byte{7}, 12)
	var aad bytes.Buffer
	encoder := json.NewEncoder(&aad)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]any{"nexus.local-credential.v1", ref.TenantID, ref.CredentialID, ref.CredentialVersion, ref.ProviderID, ref.BaseURL, ref.Protocol, ref.Model}); err != nil {
		t.Fatal(err)
	}
	sealed := aead.Seal(nil, nonce, []byte(localTestSecret), bytes.TrimSuffix(aad.Bytes(), []byte("\n")))
	fingerprint := sha256.Sum256([]byte(localTestSecret))
	envelope := map[string]any{"format": "nexus.local-credential.v1", "tenant_id": ref.TenantID, "credential_id": ref.CredentialID, "credential_version": ref.CredentialVersion, "provider_id": ref.ProviderID, "base_url": ref.BaseURL, "protocol": ref.Protocol, "model": ref.Model, "nonce": hex.EncodeToString(nonce), "tag": hex.EncodeToString(sealed[len(sealed)-16:]), "ciphertext": hex.EncodeToString(sealed[:len(sealed)-16]), "fingerprint": hex.EncodeToString(fingerprint[:])}
	writeLocalFixture(t, dir, ref, envelope)
	return dir, ref, envelope
}

func writeLocalFixture(t *testing.T, dir string, ref CredentialRef, envelope map[string]any) {
	t.Helper()
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s.%d.json", ref.CredentialID, ref.CredentialVersion)), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLocalCredentialEnvelopeAndBindings(t *testing.T) {
	dir, ref, _ := localCredentialFixture(t, "http://192.168.50.10/dmx/anthropic")
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), ref)
	if err != nil || c.Secret != localTestSecret || c.Ref != ref.CredentialID || len(c.Fingerprint) != 64 {
		t.Fatal("local credential roundtrip failed", err)
	}
	for _, field := range []string{"tenant", "id", "version", "provider", "mode", "endpoint", "protocol", "model"} {
		t.Run(field, func(t *testing.T) {
			bad := ref
			switch field {
			case "tenant":
				bad.TenantID = "another-tenant"
			case "id":
				bad.CredentialID = "../master"
			case "version":
				bad.CredentialVersion = 0
			case "provider":
				bad.ProviderID = "another-provider"
			case "mode":
				bad.Mode = "managed"
			case "endpoint":
				bad.BaseURL += "/elsewhere"
			case "protocol":
				bad.Protocol = "openai"
			case "model":
				bad.Model = "another-model"
			}
			got, err := r.Resolve(context.Background(), bad)
			if err == nil || got.Secret != "" {
				t.Fatal("credential escaped its binding")
			}
			if strings.Contains(err.Error(), localTestSecret) {
				t.Fatal("secret in error")
			}
		})
	}
}

func TestLocalCredentialConsumesTypeScriptVector(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "local-credential-vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		MasterKey string                  `json:"master_key_hex"`
		Secret    string                  `json:"secret"`
		Envelope  localCredentialEnvelope `json:"envelope"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(vector.MasterKey)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "master.key"), key, 0600); err != nil {
		t.Fatal(err)
	}
	e := vector.Envelope
	encoded, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s.%d.json", e.CredentialID, e.CredentialVersion)), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), CredentialRef{TenantID: e.TenantID, CredentialID: e.CredentialID, CredentialVersion: e.CredentialVersion, ProviderID: e.ProviderID, Mode: "byok", BaseURL: e.BaseURL, Protocol: e.Protocol, Model: e.Model})
	if err != nil || c.Secret != vector.Secret {
		t.Fatal("TypeScript envelope failed Go decryption", err)
	}
}

func TestLocalCredentialRequiresExistingRandomMasterKey(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewLocalCredentialResolver(dir); err == nil {
		t.Fatal("missing master key accepted")
	}
	if err := os.WriteFile(filepath.Join(dir, "master.key"), []byte("invalid-length"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewLocalCredentialResolver(dir); err == nil {
		t.Fatal("invalid master key accepted")
	}
}

func TestLocalCredentialTampering(t *testing.T) {
	for _, field := range []string{"format", "tenant_id", "credential_id", "credential_version", "provider_id", "base_url", "protocol", "model", "nonce", "tag", "ciphertext", "fingerprint"} {
		t.Run(field, func(t *testing.T) {
			dir, ref, envelope := localCredentialFixture(t, "https://api.example.com/v1")
			r, err := NewLocalCredentialResolver(dir)
			if err != nil {
				t.Fatal(err)
			}
			if field == "credential_version" {
				envelope[field] = 2
			} else {
				envelope[field] = "tampered"
			}
			writeLocalFixture(t, dir, ref, envelope)
			if c, err := r.Resolve(context.Background(), ref); err == nil || c.Secret != "" {
				t.Fatal("tampered envelope decrypted")
			}
		})
	}
}

func TestLocalCredentialEndpointPolicy(t *testing.T) {
	for _, tc := range []struct {
		endpoint string
		valid    bool
	}{
		{"http://192.168.50.10/dmx/anthropic", true}, {"http://127.0.0.1:8080/v1", true}, {"http://[::1]:8080/v1", true}, {"http://192.168.1.2", true}, {"https://api.example.com/v1", true},
		{"http://api.example.com", false}, {"http://localhost", false}, {"http://8.8.8.8", false}, {"http://169.254.169.254/latest", false}, {"https://169.254.169.254", false}, {"http://100.100.100.200", false}, {"http://[fe80::1]", false}, {"http://[fd00::1]", false}, {"https://user:pass@api.example.com", false}, {"https://api.example.com?secret=x", false}, {"https://api.example.com#x", false}, {"https://api.example.com/v1/../v2", false}, {"https://api.example.com/v1/%2e%2e/v2", false},
	} {
		t.Run(tc.endpoint, func(t *testing.T) {
			dir, ref, _ := localCredentialFixture(t, tc.endpoint)
			r, err := NewLocalCredentialResolver(dir)
			if err != nil {
				t.Fatal(err)
			}
			_, err = r.Resolve(context.Background(), ref)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestLocalCredentialClientBindsDestinationAndRejectsRedirect(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/base/redirect" {
			http.Redirect(w, r, "/base/leak", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	dir, ref, envelope := localCredentialFixture(t, srv.URL+"/base")
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{credentials: r, env: &Env{Environment: "development"}}
	client, err := proxy.providerHTTPClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	proxy.env.Environment = "production"
	if _, err := proxy.providerHTTPClient(ref, c); err == nil {
		t.Fatal("production proxy accepted local credentials")
	}
	for _, suffix := range []string{"/base/messages", "/base/redirect"} {
		resp, err := client.Get(srv.URL + suffix)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if suffix == "/base/redirect" && resp.StatusCode != http.StatusFound {
			t.Fatal("redirect followed")
		}
	}
	for _, target := range []string{srv.URL + "/other", srv.URL + "/base-other", srv.URL + "/base/../other", srv.URL + "/base/%2e%2e/other", srv.URL + "/base/%252e%252e/other", "http://127.0.0.1:1/base/messages"} {
		if resp, err := client.Get(target); err == nil {
			_ = resp.Body.Close()
			t.Fatal("accepted unbound destination", target)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected destination request")
	}
	envelope["fingerprint"] = strings.Repeat("0", 64)
	writeLocalFixture(t, dir, ref, envelope)
	if resp, err := client.Get(srv.URL + "/base/messages"); err == nil {
		_ = resp.Body.Close()
		t.Fatal("changed envelope retained authorization")
	}
}

func TestLocalCredentialConfigIsExplicitAndNeverProduction(t *testing.T) {
	for _, environment := range []string{"development", "test", "production"} {
		env, err := LoadEnv(func(k string) string {
			if k == "GATEWAY_ENV" {
				return environment
			}
			if k == "NEXUS_LOCAL_CREDENTIAL_DIR" {
				return t.TempDir()
			}
			return ""
		})
		if environment == "production" {
			if err == nil || !strings.Contains(err.Error(), "NEXUS_LOCAL_CREDENTIAL_DIR") {
				t.Fatal("production local profile did not fail explicitly", err)
			}
			continue
		}
		if err != nil || env.LocalCredentialDir == "" {
			t.Fatal("local profile missing", err)
		}
	}
	env, err := LoadEnv(func(string) string { return "" })
	if err != nil || env.LocalCredentialDir != "" {
		t.Fatal("implicit local profile")
	}
}

func TestChannelProtocolSelectsAdapterWithoutChangingVendor(t *testing.T) {
	registry, err := provider.NewBuiltinRegistry()
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(registry, NewBreaker(BreakerConfig{}), DefaultScoreWeights())
	bundle := &GatewayBundle{Channels: []SnapshotChannel{{ID: "local", Provider: "qwen", ProviderID: "provider-qwen", Protocol: "anthropic", BaseURL: "http://192.168.50.10/dmx/anthropic", Models: []string{"aliyun/qwen3.8-flash"}, CredentialMode: "byok", CredentialRef: "fixture", Enabled: true}}}
	candidates, err := router.Select(bundle, RouteRequest{ResolvedModel: "aliyun/qwen3.8-flash", RequiredCapabilities: []string{"text"}})
	if err != nil || len(candidates) != 1 || candidates[0].Adapter.ID() != "anthropic" || candidates[0].Channel.Provider != "qwen" {
		t.Fatal("protocol and vendor were conflated", err)
	}
	bundle.Channels[0].Protocol = ""
	candidates, err = router.Select(bundle, RouteRequest{ResolvedModel: "aliyun/qwen3.8-flash"})
	if err != nil || candidates[0].Adapter.ID() != "qwen" {
		t.Fatal("legacy adapter selection changed", err)
	}
	bundle.Channels[0].Protocol = "invalid"
	if _, err = router.Select(bundle, RouteRequest{ResolvedModel: "aliyun/qwen3.8-flash"}); err == nil {
		t.Fatal("invalid protocol silently fell back")
	}
}
