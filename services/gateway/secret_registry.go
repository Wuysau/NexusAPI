package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var errSecretPolicy = errors.New("credential unavailable: secret policy rejected")
var registryIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var registryHost = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var wrappedDEKPattern = regexp.MustCompile(`^vault:v[1-9][0-9]*:[A-Za-z0-9+/]+=*$`)

const maxRegistrySize = 16 << 20
const maxSafeInteger = int64(9007199254740991)

type SecretRegistry struct {
	Format          string          `json:"format"`
	RegistryID      string          `json:"registry_id"`
	RegistryVersion int64           `json:"registry_version"`
	RevocationEpoch int64           `json:"revocation_epoch"`
	IssuedAt        string          `json:"issued_at"`
	ExpiresAt       string          `json:"expires_at"`
	Entries         []RegistryEntry `json:"entries"`
}
type RegistryEntry struct {
	TenantID            string            `json:"tenant_id"`
	CredentialID        string            `json:"credential_id"`
	CredentialVersion   int64             `json:"credential_version"`
	ProviderID          string            `json:"provider_id"`
	AllowedHTTPSOrigins []string          `json:"allowed_https_origins"`
	ContextBase64       string            `json:"context_base64"`
	Vault               RegistryVault     `json:"vault"`
	Encrypted           RegistryEncrypted `json:"encrypted"`
}
type RegistryVault struct {
	Mount      string `json:"mount"`
	Key        string `json:"key"`
	WrappedDEK string `json:"wrapped_dek"`
}
type RegistryEncrypted struct {
	Algorithm        string `json:"algorithm"`
	NonceBase64      string `json:"nonce_base64"`
	CiphertextBase64 string `json:"ciphertext_base64"`
	TagBase64        string `json:"tag_base64"`
}
type signedRegistry struct {
	Format          string `json:"format"`
	SigningKeyID    string `json:"signing_key_id"`
	PayloadBase64   string `json:"payload_base64"`
	SignatureBase64 string `json:"signature_base64"`
}
type registryFloor struct {
	RegistryID      string `json:"registry_id"`
	RegistryVersion int64  `json:"registry_version"`
	RevocationEpoch int64  `json:"revocation_epoch"`
	PayloadSHA256   string `json:"payload_sha256,omitempty"`
}

func readBoundedFile(name string, limit int64) ([]byte, error) {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errSecretPolicy
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, errSecretPolicy
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || len(b) == 0 || int64(len(b)) > limit {
		return nil, errSecretPolicy
	}
	return b, nil
}
func strictBase64(s string, limit int) ([]byte, error) {
	if len(s) == 0 || len(s) > limit {
		return nil, errSecretPolicy
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errSecretPolicy
	}
	return b, nil
}

// Token walk rejects duplicate keys before Go's otherwise last-key-wins decoder.
func strictJSON(raw []byte, dst any) error {
	if !utf8.Valid(raw) {
		return errSecretPolicy
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 32 {
			return errSecretPolicy
		}
		tok, err := d.Token()
		if err != nil || tok == nil {
			return errSecretPolicy
		}
		if delim, ok := tok.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, e := d.Token()
					s, ok := k.(string)
					if e != nil || !ok || seen[s] {
						return errSecretPolicy
					}
					seen[s] = true
					if e = value(depth + 1); e != nil {
						return e
					}
				}
				end, e := d.Token()
				if e != nil || end != json.Delim('}') {
					return errSecretPolicy
				}
			case '[':
				for d.More() {
					if e := value(depth + 1); e != nil {
						return e
					}
				}
				end, e := d.Token()
				if e != nil || end != json.Delim(']') {
					return errSecretPolicy
				}
			default:
				return errSecretPolicy
			}
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errSecretPolicy
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(dst) != nil {
		return errSecretPolicy
	}
	var generic any
	if json.Unmarshal(raw, &generic) != nil {
		return errSecretPolicy
	}
	return requiredJSON(generic, reflect.TypeOf(dst).Elem())
}
func requiredJSON(raw any, t reflect.Type) error {
	switch t.Kind() {
	case reflect.Struct:
		obj, ok := raw.(map[string]any)
		if !ok {
			return errSecretPolicy
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			tag := strings.Split(f.Tag.Get("json"), ",")
			v, present := obj[tag[0]]
			if !present {
				if len(tag) > 1 && tag[1] == "omitempty" {
					continue
				}
				return errSecretPolicy
			}
			if err := requiredJSON(v, f.Type); err != nil {
				return err
			}
		}
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			return nil
		}
		arr, ok := raw.([]any)
		if !ok {
			return errSecretPolicy
		}
		for _, v := range arr {
			if err := requiredJSON(v, t.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}
func approvedOrigin(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || !registryHost.MatchString(u.Hostname()) || net.ParseIP(u.Hostname()) != nil {
		return "", errSecretPolicy
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 || n == 443 || strconv.Itoa(n) != p {
			return "", errSecretPolicy
		}
	}
	if "https://"+u.Host != s {
		return "", errSecretPolicy
	}
	return s, nil
}
func (e RegistryEntry) contextBytes() []byte {
	b, _ := json.Marshal([]any{"nexus.provider-credential.v1", e.TenantID, e.CredentialID, e.CredentialVersion, e.ProviderID})
	return b
}
func entryBinding(e RegistryEntry) string {
	b, _ := json.Marshal(e)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func validateRegistry(raw []byte, trust map[string]string, cfg VaultConfig, now time.Time) (SecretRegistry, string, error) {
	var outer signedRegistry
	var p SecretRegistry
	if len(raw) > maxRegistrySize+4096 || strictJSON(raw, &outer) != nil || outer.Format != "nexus.secret-registry.signed.v1" || !registryIdentifier.MatchString(outer.SigningKeyID) {
		return p, "", errSecretPolicy
	}
	pub, err := strictBase64(trust[outer.SigningKeyID], 128)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return p, "", errSecretPolicy
	}
	payload, err := strictBase64(outer.PayloadBase64, maxRegistrySize)
	if err != nil || len(payload) > 12<<20 {
		return p, "", errSecretPolicy
	}
	signature, err := strictBase64(outer.SignatureBase64, 128)
	if err != nil || !ed25519.Verify(pub, payload, signature) {
		return p, "", errSecretPolicy
	}
	if strictJSON(payload, &p) != nil || p.Format != "nexus.secret-registry.payload.v1" || p.RegistryID != cfg.RegistryID || !registryIdentifier.MatchString(p.RegistryID) || p.RegistryVersion < 1 || p.RegistryVersion > maxSafeInteger || p.RevocationEpoch < 0 || p.RevocationEpoch > maxSafeInteger || len(p.Entries) > 10000 {
		return p, "", errSecretPolicy
	}
	issued, err := time.Parse(time.RFC3339Nano, p.IssuedAt)
	if err != nil {
		return p, "", errSecretPolicy
	}
	expires, err := time.Parse(time.RFC3339Nano, p.ExpiresAt)
	if err != nil || issued.After(now) || !now.Before(expires) || !expires.After(issued) || expires.Sub(issued) > 60*time.Second {
		return p, "", errSecretPolicy
	}
	seen := map[string]bool{}
	for _, e := range p.Entries {
		for _, id := range []string{e.TenantID, e.CredentialID, e.ProviderID, e.Vault.Mount, e.Vault.Key} {
			if !registryIdentifier.MatchString(id) {
				return p, "", errSecretPolicy
			}
		}
		if e.CredentialVersion < 1 || e.CredentialVersion > maxSafeInteger || !contains(cfg.Resources, e.Vault.Mount+"/"+e.Vault.Key) || len(e.AllowedHTTPSOrigins) < 1 || len(e.AllowedHTTPSOrigins) > 16 {
			return p, "", errSecretPolicy
		}
		identity := e.TenantID + "/" + e.CredentialID + "/" + strconv.FormatInt(e.CredentialVersion, 10)
		if seen[identity] {
			return p, "", errSecretPolicy
		}
		seen[identity] = true
		origins := map[string]bool{}
		for _, o := range e.AllowedHTTPSOrigins {
			if _, err = approvedOrigin(o); err != nil || len(o) > 300 || origins[o] || !contains(cfg.Origins, o) {
				return p, "", errSecretPolicy
			}
			origins[o] = true
		}
		contextBytes, err := strictBase64(e.ContextBase64, 1<<20)
		if err != nil || !bytes.Equal(contextBytes, e.contextBytes()) {
			return p, "", errSecretPolicy
		}
		if !wrappedDEKPattern.MatchString(e.Vault.WrappedDEK) || len(e.Vault.WrappedDEK) > 16384 {
			return p, "", errSecretPolicy
		}
		parts := strings.Split(e.Vault.WrappedDEK, ":")
		if _, err = strictBase64(parts[2], 16384); err != nil {
			return p, "", errSecretPolicy
		}
		nonce, err := strictBase64(e.Encrypted.NonceBase64, 32)
		if err != nil || len(nonce) != 12 {
			return p, "", errSecretPolicy
		}
		tag, err := strictBase64(e.Encrypted.TagBase64, 32)
		if err != nil || len(tag) != 16 {
			return p, "", errSecretPolicy
		}
		ciphertext, err := strictBase64(e.Encrypted.CiphertextBase64, 1<<20)
		if err != nil || len(ciphertext) == 0 || e.Encrypted.Algorithm != "AES-256-GCM" {
			return p, "", errSecretPolicy
		}
	}
	digest := sha256.Sum256(payload)
	return p, hex.EncodeToString(digest[:]), nil
}

// Preprovisioned floors are mandatory; a missing floor never means version zero.
// The lock directory fails closed after a crash until an operator verifies recovery.
func acceptRegistryFloor(file string, p SecretRegistry, digest string) error {
	lock := file + ".lock"
	if os.Mkdir(lock, 0700) != nil {
		return errSecretPolicy
	}
	defer func() { _ = os.Remove(lock) }()
	raw, err := readBoundedFile(file, 4096)
	var floor registryFloor
	if err != nil || strictJSON(raw, &floor) != nil || floor.RegistryID != p.RegistryID || floor.RegistryVersion < 1 || floor.RegistryVersion > p.RegistryVersion || floor.RevocationEpoch < 0 || floor.RevocationEpoch > p.RevocationEpoch {
		return errSecretPolicy
	}
	if floor.PayloadSHA256 != "" {
		b, e := hex.DecodeString(floor.PayloadSHA256)
		if e != nil || len(b) != 32 {
			return errSecretPolicy
		}
		if floor.RegistryVersion == p.RegistryVersion && (floor.RevocationEpoch != p.RevocationEpoch || floor.PayloadSHA256 != digest) {
			return errSecretPolicy
		}
	}
	if floor.RegistryVersion == p.RegistryVersion && floor.RevocationEpoch == p.RevocationEpoch && floor.PayloadSHA256 == digest {
		return nil
	}
	next := registryFloor{p.RegistryID, p.RegistryVersion, p.RevocationEpoch, digest}
	raw, _ = json.Marshal(next)
	f, err := os.CreateTemp(filepath.Dir(file), ".registry-floor-*")
	if err != nil {
		return errSecretPolicy
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil || os.Rename(name, file) != nil {
		return errSecretPolicy
	}
	if runtime.GOOS != "windows" {
		dir, e := os.Open(filepath.Dir(file))
		if e != nil {
			return errSecretPolicy
		}
		e = dir.Sync()
		_ = dir.Close()
		if e != nil {
			return errSecretPolicy
		}
	}
	return nil
}
