package main

// The explicit desktop profile shares a host-private encrypted store with the
// local console. It does not provide the production Vault isolation boundary.
import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"nexus/gateway/provider"
)

const localCredentialFormat = "nexus.local-credential.v1"

var localCredentialUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type localCredentialEnvelope struct {
	Format            string `json:"format"`
	TenantID          string `json:"tenant_id"`
	CredentialID      string `json:"credential_id"`
	CredentialVersion int64  `json:"credential_version"`
	ProviderID        string `json:"provider_id"`
	BaseURL           string `json:"base_url"`
	Protocol          string `json:"protocol"`
	Model             string `json:"model"`
	Nonce             string `json:"nonce"`
	Tag               string `json:"tag"`
	Ciphertext        string `json:"ciphertext"`
	Fingerprint       string `json:"fingerprint"`
}

type LocalCredentialResolver struct {
	directory string
	outbound  *http.Transport
	pool      *credentialTransportPool
}

func NewLocalCredentialResolver(directory string) (*LocalCredentialResolver, error) {
	if strings.TrimSpace(directory) == "" {
		return nil, errSecretPolicy
	}
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, errSecretPolicy
	}
	key, err := readBoundedFile(filepath.Join(directory, "master.key"), 32)
	if err != nil || len(key) != 32 {
		return nil, errSecretPolicy
	}
	clear(key)
	return &LocalCredentialResolver{directory: directory, pool: newCredentialTransportPool(), outbound: &http.Transport{
		Proxy: nil, DialContext: localCredentialDialContext,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 30 * time.Second,
		DisableKeepAlives: true, TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{},
	}}, nil
}

func (r *LocalCredentialResolver) load(ref CredentialRef) (localCredentialEnvelope, string, error) {
	var e localCredentialEnvelope
	if ref.Mode != "byok" || ref.TenantID == "" || ref.ProviderID == "" || !localCredentialUUID.MatchString(ref.CredentialID) || ref.CredentialVersion < 1 || ref.CredentialVersion > maxSafeInteger {
		return e, "", errSecretPolicy
	}
	raw, err := readBoundedFile(filepath.Join(r.directory, fmt.Sprintf("%s.%d.json", ref.CredentialID, ref.CredentialVersion)), 64<<10)
	if err != nil || strictJSON(raw, &e) != nil {
		return e, "", errSecretPolicy
	}
	if e.Format != localCredentialFormat || e.TenantID != ref.TenantID || e.CredentialID != ref.CredentialID || e.CredentialVersion != ref.CredentialVersion || e.ProviderID != ref.ProviderID || e.BaseURL != ref.BaseURL || e.Protocol != ref.Protocol || e.Model != ref.Model || e.Model == "" || (e.Protocol != "openai" && e.Protocol != "anthropic") {
		return e, "", errSecretPolicy
	}
	if _, err := localCredentialURL(e.BaseURL); err != nil {
		return e, "", errSecretPolicy
	}
	for _, item := range []struct {
		value string
		size  int
	}{{e.Nonce, 12}, {e.Tag, 16}, {e.Fingerprint, 32}} {
		if _, err := localCredentialHex(item.value, item.size); err != nil {
			return e, "", errSecretPolicy
		}
	}
	if _, err := localCredentialHex(e.Ciphertext, 0); err != nil {
		return e, "", errSecretPolicy
	}
	binding := sha256.Sum256(raw)
	return e, hex.EncodeToString(binding[:]), nil
}

func localCredentialHex(value string, size int) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) == 0 || (size > 0 && len(decoded) != size) || hex.EncodeToString(decoded) != value {
		return nil, errSecretPolicy
	}
	return decoded, nil
}

// Match JSON.stringify's compact string encoding, including literal U+2028/29.
func (e localCredentialEnvelope) aad() []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]any{e.Format, e.TenantID, e.CredentialID, e.CredentialVersion, e.ProviderID, e.BaseURL, e.Protocol, e.Model})
	raw := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, raw[i], raw[i+1])
			i++
			continue
		}
		out = append(out, raw[i])
	}
	return out
}

func (r *LocalCredentialResolver) Resolve(ctx context.Context, ref CredentialRef) (provider.Credential, error) {
	if ctx.Err() != nil {
		return provider.Credential{}, errSecretPolicy
	}
	e, binding, err := r.load(ref)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	key, err := readBoundedFile(filepath.Join(r.directory, "master.key"), 32)
	if err != nil || len(key) != 32 {
		return provider.Credential{}, errSecretPolicy
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	nonce, _ := localCredentialHex(e.Nonce, 12)
	tag, _ := localCredentialHex(e.Tag, 16)
	ciphertext, _ := localCredentialHex(e.Ciphertext, 0)
	plaintext, err := aead.Open(nil, nonce, append(ciphertext, tag...), e.aad())
	if err != nil {
		return provider.Credential{}, errSecretPolicy
	}
	defer clear(plaintext)
	if len(plaintext) == 0 || !utf8.Valid(plaintext) || strings.ContainsAny(string(plaintext), "\r\n\x00") {
		return provider.Credential{}, errSecretPolicy
	}
	fingerprint := sha256.Sum256(plaintext)
	expected, _ := localCredentialHex(e.Fingerprint, 32)
	if subtle.ConstantTimeCompare(fingerprint[:], expected) != 1 {
		return provider.Credential{}, errSecretPolicy
	}
	return provider.Credential{Ref: e.CredentialID, Fingerprint: e.Fingerprint, Secret: string(plaintext), AuthorizationBinding: binding, AuthorizationExpiresAt: credentialGrantExpiry(time.Now())}, nil
}

func (r *LocalCredentialResolver) Invalidate(CredentialRef) {}

func (r *LocalCredentialResolver) Close() error {
	r.outbound.CloseIdleConnections()
	return r.pool.Close()
}

func (r *LocalCredentialResolver) BoundClient(ref CredentialRef, c provider.Credential) (*http.Client, error) {
	_, binding, err := r.load(ref)
	if err != nil || binding != c.AuthorizationBinding || !time.Now().Before(c.AuthorizationExpiresAt) {
		return nil, errSecretPolicy
	}
	return &http.Client{Transport: &localCredentialTransport{resolver: r, ref: ref, binding: binding, expires: c.AuthorizationExpiresAt}, CheckRedirect: denySecretRedirect}, nil
}

type localCredentialTransport struct {
	resolver *LocalCredentialResolver
	ref      CredentialRef
	binding  string
	expires  time.Time
}

func (t *localCredentialTransport) authorize() error {
	_, binding, err := t.resolver.load(t.ref)
	if err != nil || binding != t.binding || !time.Now().Before(t.expires) {
		return errSecretPolicy
	}
	return nil
}

func (t *localCredentialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.authorize() != nil || req.URL == nil || req.Host != "" && req.Host != req.URL.Host {
		return nil, errSecretPolicy
	}
	base, err := localCredentialURL(t.ref.BaseURL)
	if err != nil {
		return nil, errSecretPolicy
	}
	target, err := localCredentialURL(req.URL.String())
	if err != nil || target.Scheme != base.Scheme || !strings.EqualFold(target.Host, base.Host) {
		return nil, errSecretPolicy
	}
	prefix := strings.TrimRight(base.Path, "/")
	if target.Path != prefix && !strings.HasPrefix(target.Path, prefix+"/") {
		return nil, errSecretPolicy
	}
	ctx := context.WithValue(req.Context(), secretWriteDeadline{}, t.expires)
	ctx = context.WithValue(ctx, secretWriteAuthorization{}, t.authorize)
	key := credentialPoolKey{Reference: t.ref, Binding: t.binding, Deadline: t.expires, Target: target.Scheme + "://" + target.Host, Policy: "local-bound-v1"}
	response, err := t.resolver.pool.roundTrip(key, t.resolver.outbound, req.Clone(ctx))
	if err != nil {
		return nil, errSecretPolicy
	}
	return response, nil
}

func localCredentialPrivateIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsLoopback() || ip.Is4() && ip.IsPrivate()
}

func localCredentialURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || strings.ContainsAny(u.Path, "\\%\x00\r\n") {
		return nil, errSecretPolicy
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return nil, errSecretPolicy
		}
	}
	ip, ipErr := netip.ParseAddr(u.Hostname())
	if u.Scheme == "http" && (ipErr != nil || !localCredentialPrivateIP(ip)) {
		return nil, errSecretPolicy
	}
	if ipErr == nil && !localCredentialPrivateIP(ip) && !publicProviderIP(ip) {
		return nil, errSecretPolicy
	}
	return u, nil
}

func localCredentialDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errSecretPolicy
	}
	// Only explicit private/loopback literals may bypass the public DNS policy.
	if ip, err := netip.ParseAddr(host); err == nil && localCredentialPrivateIP(ip) {
		dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, errSecretPolicy
		}
		return guardSecretConnection(ctx, conn)
	}
	return publicDialContext(ctx, network, address)
}
