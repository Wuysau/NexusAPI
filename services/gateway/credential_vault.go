package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"nexus/gateway/provider"
)

type VaultConfig struct {
	Address, TokenFile, CAFile, RegistryFile, TrustFile, FloorFile, RegistryID string
	Resources, Origins                                                         []string
}
type VaultCredentialResolver struct {
	cfg      VaultConfig
	vault    *http.Client
	outbound *http.Transport
	mu       sync.Mutex
	now      func() time.Time
}

func NewVaultCredentialResolver(cfg VaultConfig) (*VaultCredentialResolver, error) {
	u, err := url.Parse(cfg.Address)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.ForceQuery {
		return nil, errSecretPolicy
	}
	if cfg.TokenFile == "" || cfg.RegistryFile == "" || cfg.TrustFile == "" || cfg.FloorFile == "" || !registryIdentifier.MatchString(cfg.RegistryID) || len(cfg.Resources) == 0 || len(cfg.Origins) == 0 {
		return nil, errSecretPolicy
	}
	for _, o := range cfg.Origins {
		if _, err = approvedOrigin(o); err != nil {
			return nil, errSecretPolicy
		}
	}
	for _, resource := range cfg.Resources {
		parts := strings.Split(resource, "/")
		if len(parts) != 2 || !registryIdentifier.MatchString(parts[0]) || !registryIdentifier.MatchString(parts[1]) {
			return nil, errSecretPolicy
		}
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if cfg.CAFile != "" {
		ca, e := readBoundedFile(cfg.CAFile, 1<<20)
		if e != nil || !roots.AppendCertsFromPEM(ca) {
			return nil, errSecretPolicy
		}
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second, Proxy: nil}
	r := &VaultCredentialResolver{cfg: cfg, vault: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: denySecretRedirect}, now: time.Now}
	r.outbound = &http.Transport{Proxy: nil, DialContext: publicDialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 30 * time.Second, DisableKeepAlives: true, TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}
	if _, err = r.token(); err != nil {
		return nil, err
	}
	if _, err = r.load(); err != nil {
		return nil, err
	}
	return r, nil
}
func denySecretRedirect(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
func (r *VaultCredentialResolver) token() (string, error) {
	b, err := readBoundedFile(r.cfg.TokenFile, 8192)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if token == "" || strings.ContainsAny(token, " \r\n\t") {
		return "", errSecretPolicy
	}
	return token, nil
}
func (r *VaultCredentialResolver) load() (SecretRegistry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var trust map[string]string
	raw, err := readBoundedFile(r.cfg.TrustFile, 1<<20)
	if err != nil || strictJSON(raw, &trust) != nil || len(trust) == 0 {
		return SecretRegistry{}, errSecretPolicy
	}
	raw, err = readBoundedFile(r.cfg.RegistryFile, maxRegistrySize+4096)
	if err != nil {
		return SecretRegistry{}, err
	}
	p, digest, err := validateRegistry(raw, trust, r.cfg, r.now())
	if err != nil {
		return p, err
	}
	if err = acceptRegistryFloor(r.cfg.FloorFile, p, digest); err != nil {
		return p, err
	}
	return p, nil
}
func (r *VaultCredentialResolver) entry(ref CredentialRef) (RegistryEntry, error) {
	p, err := r.load()
	if err != nil {
		return RegistryEntry{}, err
	}
	return selectRegistryEntry(p, ref)
}
func selectRegistryEntry(p SecretRegistry, ref CredentialRef) (RegistryEntry, error) {
	if ref.CredentialVersion < 0 || ref.CredentialVersion > maxSafeInteger {
		return RegistryEntry{}, errSecretPolicy
	}
	var found *RegistryEntry
	for _, entry := range p.Entries {
		if entry.TenantID == ref.TenantID && entry.CredentialID == ref.CredentialID && entry.ProviderID == ref.ProviderID && (ref.CredentialVersion == 0 || entry.CredentialVersion == ref.CredentialVersion) {
			if found != nil {
				return RegistryEntry{}, errSecretPolicy
			}
			copyEntry := entry
			found = &copyEntry
		}
	}
	if found == nil {
		return RegistryEntry{}, errSecretPolicy
	}
	return *found, nil
}

// No plaintext cache: every resolution checks fresh registry/floors and the current Agent token.
func (r *VaultCredentialResolver) Resolve(ctx context.Context, ref CredentialRef) (provider.Credential, error) {
	e, err := r.entry(ref)
	if err != nil {
		return provider.Credential{}, err
	}
	token, err := r.token()
	if err != nil {
		return provider.Credential{}, err
	}
	request, _ := json.Marshal(map[string]string{"ciphertext": e.Vault.WrappedDEK, "context": e.ContextBase64})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.Address+"/v1/"+e.Vault.Mount+"/decrypt/"+e.Vault.Key, bytes.NewReader(request))
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("Content-Type", "application/json")
	response, err := r.vault.Do(req)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return provider.Credential{}, errSecretPolicy
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return provider.Credential{}, errSecretPolicy
	}
	var body struct {
		Data struct {
			Plaintext string `json:"plaintext"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return provider.Credential{}, errSecretPolicy
	}
	dek, err := strictBase64(body.Data.Plaintext, 128)
	if err != nil || len(dek) != 32 {
		return provider.Credential{}, errSecretPolicy
	}
	defer clear(dek)
	block, err := aes.NewCipher(dek)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	nonce, _ := strictBase64(e.Encrypted.NonceBase64, 32)
	ciphertext, _ := strictBase64(e.Encrypted.CiphertextBase64, 1<<20)
	tag, _ := strictBase64(e.Encrypted.TagBase64, 32)
	plaintext, err := aead.Open(nil, nonce, append(ciphertext, tag...), e.contextBytes())
	if err != nil || len(plaintext) == 0 {
		return provider.Credential{}, errSecretPolicy
	}
	defer clear(plaintext)
	// A Vault call must not extend an expired/revoked registry grant.
	current, err := r.entry(ref)
	if err != nil || entryBinding(current) != entryBinding(e) {
		return provider.Credential{}, errSecretPolicy
	}
	return provider.Credential{Ref: e.CredentialID, Secret: string(plaintext), AuthorizationBinding: entryBinding(e), AuthorizationExpiresAt: r.now().Add(30 * time.Second)}, nil
}
func (r *VaultCredentialResolver) Invalidate(_ CredentialRef) {}

// A client is scoped to one authenticated reference and the exact encrypted binding
// already resolved; mutable CP routing cannot broaden the scope after decryption.
func (r *VaultCredentialResolver) BoundClient(ref CredentialRef, c provider.Credential) (*http.Client, error) {
	if c.AuthorizationBinding == "" || !r.now().Before(c.AuthorizationExpiresAt) {
		return nil, errSecretPolicy
	}
	return &http.Client{Transport: &registryTransport{resolver: r, ref: ref, binding: c.AuthorizationBinding, expires: c.AuthorizationExpiresAt}, CheckRedirect: denySecretRedirect}, nil
}

type registryTransport struct {
	resolver *VaultCredentialResolver
	ref      CredentialRef
	binding  string
	expires  time.Time
}

func (t *registryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !t.resolver.now().Before(t.expires) {
		return nil, errSecretPolicy
	}
	current, err := t.resolver.load()
	if err != nil {
		return nil, errSecretPolicy
	}
	e, err := selectRegistryEntry(current, t.ref)
	if err != nil || entryBinding(e) != t.binding {
		return nil, errSecretPolicy
	}
	if req.URL == nil || req.URL.User != nil || req.URL.Fragment != "" || req.URL.Opaque != "" || req.Host != "" && req.Host != req.URL.Host {
		return nil, errSecretPolicy
	}
	origin, err := approvedOrigin(req.URL.Scheme + "://" + req.URL.Host)
	if err != nil || !contains(e.AllowedHTTPSOrigins, origin) {
		return nil, errSecretPolicy
	}
	// Never return URL-bearing transport errors: provider query auth can contain a credential.
	registryExpiry, err := time.Parse(time.RFC3339Nano, current.ExpiresAt)
	if err != nil {
		return nil, errSecretPolicy
	}
	deadline := t.expires
	if registryExpiry.Before(deadline) {
		deadline = registryExpiry
	}
	writeContext := context.WithValue(req.Context(), secretWriteAuthorization{}, func() error {
		entry, e := t.resolver.entry(t.ref)
		if e != nil || entryBinding(entry) != t.binding || !t.resolver.now().Before(t.expires) {
			return errSecretPolicy
		}
		return nil
	})
	request := req.Clone(context.WithValue(writeContext, secretWriteDeadline{}, deadline))
	response, err := t.resolver.outbound.RoundTrip(request)
	if err != nil {
		return nil, errSecretPolicy
	}
	return response, nil
}

type secretWriteDeadline struct{}
type secretWriteAuthorization struct{}

func guardSecretConnection(ctx context.Context, conn net.Conn) (net.Conn, error) {
	deadline, ok := ctx.Value(secretWriteDeadline{}).(time.Time)
	if !ok {
		_ = conn.Close()
		return nil, errSecretPolicy
	}
	authorize, ok := ctx.Value(secretWriteAuthorization{}).(func() error)
	if !ok {
		_ = conn.Close()
		return nil, errSecretPolicy
	}
	return &secretDeadlineConn{Conn: conn, deadline: deadline, authorize: authorize}, nil
}

type secretDeadlineConn struct {
	net.Conn
	deadline  time.Time
	authorize func() error
}

func (c *secretDeadlineConn) Write(b []byte) (int, error) {
	if !time.Now().Before(c.deadline) {
		return 0, errSecretPolicy
	}
	if c.authorize == nil || c.authorize() != nil {
		return 0, errSecretPolicy
	}
	return c.Conn.Write(b)
}

var forbiddenProviderNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("2002::/16"),
}

func publicProviderIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range forbiddenProviderNetworks {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
func publicDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errSecretPolicy
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, errSecretPolicy
	}
	for _, ip := range ips {
		if !publicProviderIP(ip) {
			return nil, errSecretPolicy
		}
	}
	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	for _, ip := range ips {
		conn, e := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if e == nil {
			return guardSecretConnection(ctx, conn)
		}
	}
	return nil, errSecretPolicy
}
