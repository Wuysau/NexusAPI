package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nexus/gateway/provider"
)

type registryFixture struct {
	config  VaultConfig
	payload SecretRegistry
	private ed25519.PrivateKey
	vault   *httptest.Server
	calls   int
	dek     []byte
	t       *testing.T
}

func newRegistryFixture(t *testing.T) *registryFixture {
	t.Helper()
	dir := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := &registryFixture{t: t, private: priv, dek: make([]byte, 32)}
	f.vault = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls++
		if r.URL.Path != "/v1/transit/decrypt/tenant-key" || r.Header.Get("X-Vault-Token") != "synthetic-gateway-token" {
			w.WriteHeader(403)
			return
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["context"] != f.payload.Entries[0].ContextBase64 {
			w.WriteHeader(400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"plaintext": base64.StdEncoding.EncodeToString(f.dek)}})
	}))
	t.Cleanup(f.vault.Close)
	f.config = VaultConfig{Address: f.vault.URL, TokenFile: filepath.Join(dir, "token"), CAFile: filepath.Join(dir, "ca.pem"), RegistryFile: filepath.Join(dir, "registry.json"), TrustFile: filepath.Join(dir, "trust.json"), FloorFile: filepath.Join(dir, "floor.json"), RegistryID: "fixture", Resources: []string{"transit/tenant-key"}, Origins: []string{"https://api.example.com"}}
	mustWrite(t, f.config.TokenFile, []byte("synthetic-gateway-token"))
	mustWrite(t, f.config.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.vault.Certificate().Raw}))
	trust, _ := json.Marshal(map[string]string{"operator": base64.StdEncoding.EncodeToString(pub)})
	mustWrite(t, f.config.TrustFile, trust)
	floor := []byte(`{"registry_id":"fixture","registry_version":1,"revocation_epoch":0}`)
	mustWrite(t, f.config.FloorFile, floor)
	f.payload = SecretRegistry{Format: "nexus.secret-registry.payload.v1", RegistryID: "fixture", RegistryVersion: 1, RevocationEpoch: 0, IssuedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), ExpiresAt: time.Now().Add(50 * time.Second).UTC().Format(time.RFC3339Nano)}
	e := RegistryEntry{TenantID: "tenant", CredentialID: "credential", CredentialVersion: 1, ProviderID: "provider", AllowedHTTPSOrigins: []string{"https://api.example.com"}, Vault: RegistryVault{Mount: "transit", Key: "tenant-key", WrappedDEK: "vault:v1:ZmFrZQ=="}}
	aad := []byte(`["nexus.provider-credential.v1","tenant","credential",1,"provider"]`)
	e.ContextBase64 = base64.StdEncoding.EncodeToString(aad)
	block, _ := aes.NewCipher(f.dek)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	encrypted := aead.Seal(nil, nonce, []byte("synthetic-provider-canary"), aad)
	e.Encrypted = RegistryEncrypted{Algorithm: "AES-256-GCM", NonceBase64: base64.StdEncoding.EncodeToString(nonce), CiphertextBase64: base64.StdEncoding.EncodeToString(encrypted[:len(encrypted)-16]), TagBase64: base64.StdEncoding.EncodeToString(encrypted[len(encrypted)-16:])}
	f.payload.Entries = []RegistryEntry{e}
	f.write()
	return f
}
func mustWrite(t *testing.T, p string, b []byte) {
	t.Helper()
	if err := os.WriteFile(p, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func (f *registryFixture) write() { f.t.Helper(); raw, _ := json.Marshal(f.payload); f.writeRaw(raw) }
func (f *registryFixture) writeRaw(raw []byte) {
	f.t.Helper()
	outer, _ := json.Marshal(map[string]string{"format": "nexus.secret-registry.signed.v1", "signing_key_id": "operator", "payload_base64": base64.StdEncoding.EncodeToString(raw), "signature_base64": base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, raw))})
	mustWrite(f.t, f.config.RegistryFile, outer)
}

var fixtureRef = CredentialRef{TenantID: "tenant", CredentialID: "credential", ProviderID: "provider", Mode: "byok"}

func TestVaultRegistryRoundTripAndIdentity(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), fixtureRef)
	if err != nil || c.Secret != "synthetic-provider-canary" {
		t.Fatal("authorized unwrap failed", err)
	}
	wrong := fixtureRef
	wrong.TenantID = "other"
	if _, err = r.Resolve(context.Background(), wrong); err == nil {
		t.Fatal("cross tenant allowed")
	}
	if f.calls != 1 {
		t.Fatal("unauthorized request reached Vault")
	}
	mustWrite(t, f.config.TokenFile, []byte("other-principal"))
	if _, err = r.Resolve(context.Background(), fixtureRef); err == nil {
		t.Fatal("wrong token allowed")
	}
}
func TestRegistryRejectsAdversarialSignedPayloads(t *testing.T) {
	cases := map[string]func(*registryFixture){
		"expired": func(f *registryFixture) {
			f.payload.ExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
		},
		"future": func(f *registryFixture) {
			f.payload.IssuedAt = time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)
		},
		"long lease": func(f *registryFixture) {
			f.payload.ExpiresAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
		},
		"context":   func(f *registryFixture) { f.payload.Entries[0].ContextBase64 = "ZmFrZQ==" },
		"origin":    func(f *registryFixture) { f.payload.Entries[0].AllowedHTTPSOrigins = []string{"https://evil.example"} },
		"resource":  func(f *registryFixture) { f.payload.Entries[0].Vault.Key = "other-key" },
		"duplicate": func(f *registryFixture) { f.payload.Entries = append(f.payload.Entries, f.payload.Entries[0]) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newRegistryFixture(t)
			mutate(f)
			f.write()
			if _, err := NewVaultCredentialResolver(f.config); err == nil {
				t.Fatal("bad registry accepted")
			}
			if f.calls != 0 {
				t.Fatal("Vault reached before validation")
			}
		})
	}
}
func TestRegistryStrictJSONAndRawSignature(t *testing.T) {
	for _, raw := range []string{`{"format":"nexus.secret-registry.payload.v1","format":"nexus.secret-registry.payload.v1"}`, `{"bad":NaN}`, "{\"bad\":\"\xff\"}"} {
		t.Run(raw[:5], func(t *testing.T) {
			f := newRegistryFixture(t)
			f.writeRaw([]byte(raw))
			if _, err := NewVaultCredentialResolver(f.config); err == nil {
				t.Fatal("malformed signed payload accepted")
			}
		})
	}
	f := newRegistryFixture(t)
	b, _ := os.ReadFile(f.config.RegistryFile)
	var o map[string]string
	_ = json.Unmarshal(b, &o)
	raw, _ := base64.StdEncoding.DecodeString(o["payload_base64"])
	o["payload_base64"] = base64.StdEncoding.EncodeToString(append(raw, ' '))
	b, _ = json.Marshal(o)
	mustWrite(t, f.config.RegistryFile, b)
	if _, err := NewVaultCredentialResolver(f.config); err == nil {
		t.Fatal("raw bytes normalized")
	}
}
func TestRegistryDurableRevocationAndEquivocation(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(f.config.RegistryFile)
	f.payload.RegistryVersion = 2
	f.payload.RevocationEpoch = 1
	f.payload.Entries = []RegistryEntry{}
	f.write()
	if _, err = r.Resolve(context.Background(), fixtureRef); err == nil {
		t.Fatal("revoked credential allowed")
	}
	mustWrite(t, f.config.RegistryFile, old)
	if _, err = NewVaultCredentialResolver(f.config); err == nil {
		t.Fatal("restart downgraded floor")
	}
	f.payload.RegistryVersion = 2
	f.payload.RevocationEpoch = 1
	f.payload.ExpiresAt = time.Now().Add(40 * time.Second).UTC().Format(time.RFC3339Nano)
	f.write()
	if _, err = NewVaultCredentialResolver(f.config); err == nil {
		t.Fatal("sameversion equivocation allowed")
	}
}
func TestRegistryBoundClientRejectsDestinationAndRevocation(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	client, err := r.BoundClient(fixtureRef, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"http://api.example.com", "https://evil.example", "https://127.0.0.1", "https://api.example.com@evil.example"} {
		req, _ := http.NewRequest(http.MethodGet, target, nil)
		req.Header.Set("Authorization", "Bearer "+c.Secret)
		if _, err = client.Do(req); err == nil {
			t.Fatal("bad target allowed")
		}
		if strings.Contains(err.Error(), c.Secret) {
			t.Fatal("credential leaked")
		}
	}
	f.payload.RegistryVersion++
	f.payload.RevocationEpoch++
	f.payload.Entries = []RegistryEntry{}
	f.write()
	req, _ := http.NewRequest(http.MethodGet, "https://api.example.com", nil)
	if _, err = client.Do(req); err == nil {
		t.Fatal("warm grant survived revoke")
	}
}

func TestNodeSignedRegistryCrossLanguage(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/secret-registry-node.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Outer          json.RawMessage   `json:"outer"`
		Trust          map[string]string `json:"trust"`
		ValidationTime string            `json:"validation_time"`
		RegistryID     string            `json:"registry_id"`
	}
	if json.Unmarshal(raw, &vector) != nil {
		t.Fatal("malformed vector")
	}
	now, err := time.Parse(time.RFC3339, vector.ValidationTime)
	if err != nil {
		t.Fatal(err)
	}
	cfg := VaultConfig{RegistryID: vector.RegistryID, Resources: []string{"transit/nexus-provider-v1"}, Origins: []string{"https://api.example.com"}}
	if _, _, err = validateRegistry(vector.Outer, vector.Trust, cfg, now); err != nil {
		t.Fatal("Node signed bytes rejected", err)
	}
}
func TestProviderIPPolicyAndProductionClient(t *testing.T) {
	for _, value := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::a00:1"} {
		if publicProviderIP(netip.MustParseAddr(value)) {
			t.Fatal("unsafe address allowed", value)
		}
	}
	if !publicProviderIP(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("public address rejected")
	}
	p := &Proxy{env: &Env{Environment: "production"}, credentials: NewStaticCredentialResolver("synthetic")}
	if _, err := p.providerHTTPClient(fixtureRef, provider.Credential{}); err == nil {
		t.Fatal("production static plaintext resolver allowed")
	}
}

func TestProviderGrantCannotSurviveThirtySeconds(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	r.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	if _, err = r.BoundClient(fixtureRef, c); err == nil {
		t.Fatal("old plaintext grant survived")
	}
}

func TestBoundDispatchSendsOnlyApprovedOriginAndNeverFollowsRedirect(t *testing.T) {
	f := newRegistryFixture(t)
	resolver, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	c, err := resolver.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	called := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		if r.Header.Get("Authorization") != "Bearer "+c.Secret {
			t.Error("authorized header missing")
		}
		w.Header().Set("Location", "https://evil.example")
		w.WriteHeader(302)
	}))
	defer server.Close()
	// Test-only network fixture: production has no private-IP or TLS bypass setting.
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = server.Certificate().DNSNames[0]
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	resolver.outbound = transport
	client, err := resolver.BoundClient(fixtureRef, c)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://api.example.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal("approved request failed", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 302 || called != 1 {
		t.Fatal("redirect followed")
	}
	req, _ = http.NewRequest(http.MethodGet, "https://evil.example/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+c.Secret)
	if _, err = client.Do(req); err == nil || called != 1 {
		t.Fatal("origin policy bypassed")
	}
}
func TestExpiredConnectionCannotWriteCredential(t *testing.T) {
	local, remote := net.Pipe()
	defer func() { _ = local.Close(); _ = remote.Close() }()
	c := secretDeadlineConn{Conn: local, deadline: time.Now().Add(-time.Second)}
	if n, err := c.Write([]byte("synthetic")); err == nil || n != 0 {
		t.Fatal("expired connection wrote bytes")
	}
}

func TestRevocationDuringTLSHandshakePreventsAuthorizationWrite(t *testing.T) {
	f := newRegistryFixture(t)
	resolver, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := resolver.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	handshake := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var dispatched atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { dispatched.Add(1); w.WriteHeader(200) }))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
		once.Do(func() { close(handshake) })
		<-release
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	transport.TLSClientConfig.ServerName = server.Certificate().DNSNames[0]
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		conn, e := (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		if e != nil {
			return nil, e
		}
		return guardSecretConnection(ctx, conn)
	}
	resolver.outbound = transport
	client, err := resolver.BoundClient(fixtureRef, credential)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://api.example.com/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+credential.Secret)
	result := make(chan error, 1)
	go func() {
		response, e := client.Do(req)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- e
	}()
	select {
	case <-handshake:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("handshake did not begin")
	}
	f.payload.RegistryVersion++
	f.payload.RevocationEpoch++
	f.payload.Entries = []RegistryEntry{}
	f.write()
	close(release)
	select {
	case err = <-result:
	case <-time.After(3 * time.Second):
		t.Fatal("dispatch did not stop")
	}
	if err == nil || dispatched.Load() != 0 {
		t.Fatal("revoked credential crossed final write boundary")
	}
}

func TestExplicitCredentialVersionsSelectSignedOverlap(t *testing.T) {
	p := SecretRegistry{Entries: []RegistryEntry{{TenantID: "tenant", CredentialID: "credential", ProviderID: "provider", CredentialVersion: 1}, {TenantID: "tenant", CredentialID: "credential", ProviderID: "provider", CredentialVersion: 2}}}
	if _, err := selectRegistryEntry(p, fixtureRef); err == nil {
		t.Fatal("ambiguous unversioned reference accepted")
	}
	for _, version := range []int64{1, 2} {
		ref := fixtureRef
		ref.CredentialVersion = version
		e, err := selectRegistryEntry(p, ref)
		if err != nil || e.CredentialVersion != version {
			t.Fatal("explicit signed version not selected", version)
		}
	}
	ref := fixtureRef
	ref.CredentialVersion = 3
	if _, err := selectRegistryEntry(p, ref); err == nil {
		t.Fatal("unsigned version selected")
	}
}
