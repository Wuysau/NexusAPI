package main

// Snapshot signing keyring.
//
// This mirrors src/lib/crypto.ts:buildKeyring exactly:
//
//   key = scrypt(passphrase, "nexusapi-upstream-key-salt", 32, {N: 16384, r: 8, p: 1})
//   SNAPSHOT_SIGNING_KEY_VERSION names the current version; a separately
//   configured previous signing key preserves an explicit rotation window.
//
// The gateway never uses this key to decrypt credentials: independent Vault
// identity and operator registry authority own that boundary. This key is only for HMAC
// verification of the signed snapshot bundle.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	KeyringSalt = "nexusapi-upstream-key-salt"

	// Development fallback, identical to the one in src/lib/crypto.ts. It is
	// only reachable in non-production: LoadEnv makes the real key mandatory in
	// production.
	developmentFallbackKey = "local-development-only-key-DO-NOT-USE-IN-PROD"

	// KeyringKDF params, identical to src/lib/crypto.ts.
	keyringN      = 1 << 14
	keyringR      = 8
	keyringP      = 1
	keyringKeyLen = 32

	// SigningAlgorithm is the prefix of the signing key id, e.g. "hmac-sha256:v1".
	SigningAlgorithm = "hmac-sha256"
)

// KeyringError distinguishes a caller/config problem from a signature failure.
type KeyringError struct{ Reason string }

func (e *KeyringError) Error() string { return "keyring: " + e.Reason }

type keyEntry struct {
	version int
	key     []byte
}

// Keyring is an immutable set of signing keys addressed by integer version.
type Keyring struct {
	current  keyEntry
	previous *keyEntry
}

// NewKeyring derives the current (and optional previous) key.
func NewKeyring(passphrase, previousPassphrase string, previousVersion int) (*Keyring, error) {
	if passphrase == "" && previousPassphrase == "" {
		return nil, errors.New("keyring: passphrase required")
	}
	kr := &Keyring{}
	if passphrase != "" {
		key, err := deriveKeyringKey(passphrase)
		if err != nil {
			return nil, err
		}
		kr.current = keyEntry{version: 1, key: key}
	}
	if previousPassphrase != "" {
		version := previousVersion
		if version == 0 {
			version = kr.current.version - 1
		}
		if version == kr.current.version {
			return nil, fmt.Errorf("keyring: previous key version %d collides with current", version)
		}
		key, err := deriveKeyringKey(previousPassphrase)
		if err != nil {
			return nil, err
		}
		kr.previous = &keyEntry{version: version, key: key}
	}
	return kr, nil
}

func deriveKeyringKey(passphrase string) ([]byte, error) {
	return ScryptKey([]byte(passphrase), []byte(KeyringSalt), keyringN, keyringR, keyringP, keyringKeyLen)
}

// CurrentVersion reports the version the control plane is expected to sign with.
func (k *Keyring) CurrentVersion() int { return k.current.version }

// CurrentKeyID is the observable key identifier, e.g. "hmac-sha256:v1".
func (k *Keyring) CurrentKeyID() string {
	return fmt.Sprintf("%s:v%d", SigningAlgorithm, k.current.version)
}

// keyForVersion returns the key for a version, or nil when unknown.
func (k *Keyring) keyForVersion(version int) []byte {
	if k.current.key != nil && k.current.version == version {
		return k.current.key
	}
	if k.previous != nil && k.previous.version == version {
		return k.previous.key
	}
	return nil
}

// parseKeyID extracts the version from an "hmac-sha256:v<N>" key id.
func parseKeyID(keyID string) (int, error) {
	parts := strings.Split(keyID, ":")
	if len(parts) != 2 || parts[0] != SigningAlgorithm {
		return 0, &KeyringError{Reason: "unknown_key_version"}
	}
	version, err := strconv.Atoi(strings.TrimPrefix(parts[1], "v"))
	if err != nil || version < 1 {
		return 0, &KeyringError{Reason: "unknown_key_version"}
	}
	return version, nil
}

// VerifyHMAC checks `signatureHex` (lowercase hex HMAC-SHA256 of canonical)
// against the key addressed by keyID. Constant time. Fail-closed: an unknown
// key version is an error, never a pass.
func (k *Keyring) VerifyHMAC(keyID, canonical, signatureHex string) error {
	version, err := parseKeyID(keyID)
	if err != nil {
		return err
	}
	key := k.keyForVersion(version)
	if key == nil {
		return &KeyringError{Reason: "unknown_key_version"}
	}
	want, err := hex.DecodeString(signatureHex)
	if err != nil || len(want) != sha256.Size {
		return &KeyringError{Reason: "signature_malformed"}
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(canonical))
	got := mac.Sum(nil)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return &KeyringError{Reason: "signature_mismatch"}
	}
	return nil
}

// SignHMAC is used by tests and by local tooling to produce a snapshot
// signature with the same construction as the control plane. The gateway's
// serving path never signs anything.
func (k *Keyring) SignHMAC(canonical string) (keyID, signatureHex string) {
	mac := hmac.New(sha256.New, k.current.key)
	mac.Write([]byte(canonical))
	return k.CurrentKeyID(), hex.EncodeToString(mac.Sum(nil))
}

// BuildKeyringFromEnv is the production entry point.
func BuildKeyringFromEnv(env *Env) (*Keyring, error) {
	passphrase := env.UpstreamEncryptionKey
	if env.Environment != "production" && passphrase == "" {
		passphrase = developmentFallbackKey
	}
	kr, err := NewKeyring(passphrase, "", 0)
	if err != nil {
		return nil, err
	}
	if env.SnapshotKeyVersion > 0 {
		kr.current.version = env.SnapshotKeyVersion
	}
	if env.PreviousKey != "" {
		if env.PreviousKeyVersion < 1 || env.PreviousKeyVersion >= kr.current.version {
			return nil, errors.New("keyring: previous version must precede current")
		}
		key, e := deriveKeyringKey(env.PreviousKey)
		if e != nil {
			return nil, e
		}
		kr.previous = &keyEntry{version: env.PreviousKeyVersion, key: key}
	}
	return kr, nil
}
