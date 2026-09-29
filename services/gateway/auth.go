package main

// Downstream key authentication.
//
// Keys are verified against the signed platform key directory carried in the
// snapshot (see SnapshotKey). No control-plane round trip, no database access —
// INVARIANT #8. Revocation is effective on the next snapshot swap, bounded by
// the refresh interval; the gateway reports its directory epoch and age so that
// window is observable.
//
// Fail-closed rules:
//   - no usable snapshot          → 503, never "allow"
//   - unknown hash                → 401
//   - revoked / disabled / expired→ 401 with a distinct code (no oracle beyond
//     what the contract requires)
//   - missing scope               → 403
//
// There is no environment variable, header or debug flag that disables
// authentication. The old `authorized()` default-open behaviour
// (src/lib/server.ts, finding C3) is intentionally not reproduced anywhere in
// this service.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
)

// APIKeyPrefix mirrors src/lib/auth/api-keys.ts.
const APIKeyPrefix = "sk-nx-"

// Key scope constants mirror src/lib/auth/api-keys.ts.
const (
	ScopeAll             = "*"
	ScopeModelsRead      = "models:read"
	ScopeChatWrite       = "chat:write"
	ScopeEmbeddingsWrite = "embeddings:write"
	ScopeImagesWrite     = "images:write"
	ScopeAudioWrite      = "audio:write"
	ScopeUsageRead       = "usage:read"
)

// Identity is the authenticated caller context. It contains no key material.
type Identity struct {
	TenantID       string
	OrganizationID string
	KeyID          string
	KeyFingerprint string
	Scopes         []string
	// Project attribution is resolved in the signed snapshot and frozen for the request.
	ProjectID         string
	ProjectName       string
	KeyKind           string
	PrincipalID       *string
	AttributionStatus string
	ConnectionID      string
	ExecutionMode     string
	// DirectoryEpoch is the snapshot revocation epoch the identity was checked
	// against (observability for the revocation window).
	DirectoryEpoch int64
}

// HasScope reports whether the identity may perform an operation.
func (i *Identity) HasScope(required string) bool {
	return scopeMatches(i.Scopes, required)
}

// scopeMatches mirrors src/lib/auth/api-keys.ts:scopeMatches — `*` grants
// everything and an empty requirement is always satisfied.
func scopeMatches(granted []string, required string) bool {
	if required == "" {
		return true
	}
	for _, scope := range granted {
		if scope == ScopeAll || scope == required {
			return true
		}
	}
	return false
}

// HashKey returns the hex sha256 of a presented key. Only this digest is ever
// compared, stored or logged.
func HashKey(presented string) string {
	sum := sha256.Sum256([]byte(presented))
	return hex.EncodeToString(sum[:])
}

// Authenticator resolves a presented key to an Identity.
type Authenticator struct {
	snapshots *SnapshotCache
	now       func() time.Time
}

func NewAuthenticator(snapshots *SnapshotCache) *Authenticator {
	return &Authenticator{snapshots: snapshots, now: time.Now}
}

// SetClock overrides the clock. Test-only.
func (a *Authenticator) SetClock(now func() time.Time) { a.now = now }

// Authenticate verifies a presented key and required scope.
//
// The platform snapshot (tenant scope "") carries the cross-tenant key
// directory. A missing or expired platform snapshot fails the request closed
// with a 503 rather than an auth error, so operators can distinguish "the
// control plane is unreachable" from "your key is bad".
func (a *Authenticator) Authenticate(ctx context.Context, presented, requiredScope string) (*Identity, error) {
	if !strings.HasPrefix(presented, APIKeyPrefix) || len(presented) < 24 {
		return nil, errInvalidAPIKey()
	}
	state, err := a.snapshots.Get(ctx, "")
	if err != nil {
		// The cache's stale/error contract is authoritative for the directory.
		return nil, errSnapshot(reasonOf(err))
	}
	if state == nil {
		return nil, errSnapshot(ReasonSnapshotUnavailable)
	}
	if !state.Fresh(a.now()) {
		// Expiry can occur after Get returns, even without a fetch error.
		return nil, errSnapshot(ReasonSnapshotExpired)
	}
	bundle := state.Verified.Bundle
	hash := HashKey(presented)
	key := bundle.KeyByHash(hash)
	if key == nil {
		return nil, errInvalidAPIKey()
	}
	// Defence in depth against index-timing leaks, mirroring verifyDownstreamKey.
	if subtle.ConstantTimeCompare([]byte(key.HashSHA256), []byte(hash)) != 1 {
		return nil, errInvalidAPIKey()
	}
	if err := validateSnapshotKey(key, a.now()); err != nil {
		return nil, err
	}
	if !scopeMatches(key.Scopes, requiredScope) {
		return nil, errScopeDenied(requiredScope)
	}
	return &Identity{
		TenantID:          key.TenantID,
		OrganizationID:    key.OrganizationID,
		KeyID:             key.KeyID,
		KeyFingerprint:    key.Fingerprint,
		Scopes:            key.Scopes,
		ProjectID:         key.ProjectID,
		ProjectName:       key.ProjectName,
		KeyKind:           key.KeyKind,
		PrincipalID:       cloneString(key.PrincipalID),
		AttributionStatus: key.AttributionStatus,
		ConnectionID:      key.ConnectionID,
		ExecutionMode:     key.ExecutionMode,
		DirectoryEpoch:    bundle.RevocationEpoch,
	}, nil
}

// validateSnapshotKey checks the signed key's own eligibility. Authentication
// separately requires a fresh directory, matching hash and operation scope.
// Background refresh can share these checks without granting any permission.
func validateSnapshotKey(key *SnapshotKey, now time.Time) *APIError {
	if key.RevokedAt != nil && *key.RevokedAt != "" {
		return errKeyRevoked()
	}
	if !key.Enabled {
		return errKeyDisabled()
	}
	if key.ExpiresAt != nil && *key.ExpiresAt != "" {
		expiresAt, err := time.Parse(time.RFC3339, *key.ExpiresAt)
		if err != nil || !now.Before(expiresAt) {
			return errKeyExpired()
		}
	}
	if key.TenantID == "" || key.OrganizationID == "" || key.KeyID == "" {
		// A key without a tenant cannot scope any data access.
		return errInvalidAPIKey()
	}
	return nil
}

// bearerToken extracts the presented key from the Authorization header. It
// accepts only the `Bearer` scheme so a stray header cannot be interpreted as a
// credential.
func bearerToken(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// reasonOf unwraps a snapshot failure reason for the public error mapping.
func reasonOf(err error) string {
	var se *SnapshotError
	if errors.As(err, &se) {
		return se.Reason
	}
	return ReasonSnapshotUnavailable
}
