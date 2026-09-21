package main

// Upstream credential resolution.
//
// Production uses credential_vault.go with an independent operator registry.
// The HTTP implementation below remains only for explicit development/tests;
// production main/config never selects the historical plaintext endpoint.
// Credentials must never be logged, persisted or returned to a client.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"nexus/gateway/provider"
)

// ErrCredentialUnavailable marks a credential that could not be resolved.
var ErrCredentialUnavailable = errors.New("credential unavailable")

// CredentialResolver resolves a snapshot credential reference to a usable
// secret.
type CredentialResolver interface {
	Resolve(ctx context.Context, ref CredentialRef) (provider.Credential, error)
	Invalidate(ref CredentialRef)
}

// CredentialRef identifies the secret to fetch. TenantID is required for BYOK
// credentials; the control plane scopes the lookup by it so a cross-tenant id
// resolves to "not found".
type CredentialRef struct {
	TenantID          string
	CredentialID      string
	CredentialVersion int64
	ProviderID        string
	Mode              string // managed | byok
	// Local encrypted grants additionally bind routing facts from the snapshot.
	BaseURL  string
	Protocol string
	Model    string
}

// ── HTTP implementation ───────────────────────────────────────────────

type HTTPCredentialResolver struct {
	BaseURL string
	Token   string
	Client  *http.Client
	TTL     time.Duration

	mu    sync.Mutex
	cache map[string]cachedCredential
}

type cachedCredential struct {
	credential provider.Credential
	expiresAt  time.Time
}

func NewHTTPCredentialResolver(baseURL, token string, client *http.Client) *HTTPCredentialResolver {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &HTTPCredentialResolver{
		BaseURL: baseURL,
		Token:   token,
		Client:  client,
		TTL:     60 * time.Second,
		cache:   make(map[string]cachedCredential),
	}
}

func (h *HTTPCredentialResolver) cacheKey(ref CredentialRef) string {
	return ref.TenantID + "|" + ref.CredentialID + "|" + ref.Mode
}

func (h *HTTPCredentialResolver) Resolve(ctx context.Context, ref CredentialRef) (provider.Credential, error) {
	key := h.cacheKey(ref)
	h.mu.Lock()
	if entry, ok := h.cache[key]; ok && time.Now().Before(entry.expiresAt) {
		h.mu.Unlock()
		return entry.credential, nil
	}
	h.mu.Unlock()

	payload, _ := json.Marshal(map[string]string{
		"tenant_id":     ref.TenantID,
		"credential_id": ref.CredentialID,
		"provider_id":   ref.ProviderID,
		"mode":          ref.Mode,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/api/internal/gateway/credential", bytes.NewReader(payload))
	if err != nil {
		return provider.Credential{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+h.Token)
	resp, err := h.Client.Do(req)
	if err != nil {
		return provider.Credential{}, fmt.Errorf("%w: %v", ErrCredentialUnavailable, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return provider.Credential{}, fmt.Errorf("%w: http %d", ErrCredentialUnavailable, resp.StatusCode)
	}
	var body struct {
		Secret       string `json:"secret"`
		Fingerprint  string `json:"fingerprint"`
		CredentialID string `json:"credential_id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Secret == "" {
		return provider.Credential{}, fmt.Errorf("%w: malformed response", ErrCredentialUnavailable)
	}

	credential := provider.Credential{Ref: body.CredentialID, Fingerprint: body.Fingerprint, Secret: body.Secret}
	h.mu.Lock()
	h.cache[key] = cachedCredential{credential: credential, expiresAt: time.Now().Add(h.TTL)}
	// Bound the cache: credentials are per-tenant and few, but a hostile tenant
	// must not be able to grow this without limit.
	if len(h.cache) > 4096 {
		now := time.Now()
		for k, v := range h.cache {
			if now.After(v.expiresAt) {
				delete(h.cache, k)
			}
		}
	}
	h.mu.Unlock()
	return credential, nil
}

// Invalidate drops a cached secret, e.g. after an upstream auth failure.
func (h *HTTPCredentialResolver) Invalidate(ref CredentialRef) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.cache, h.cacheKey(ref))
}

// ── Static implementation (tests / single-credential deployments) ────

// StaticCredentialResolver returns one credential for every reference. Used by
// tests and by single-channel development setups.
type StaticCredentialResolver struct {
	Credential provider.Credential
	Err        error
	Calls      int
	mu         sync.Mutex
}

func NewStaticCredentialResolver(secret string) *StaticCredentialResolver {
	return &StaticCredentialResolver{Credential: provider.Credential{Ref: "static", Fingerprint: "static", Secret: secret}}
}

func (s *StaticCredentialResolver) Resolve(context.Context, CredentialRef) (provider.Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Calls++
	if s.Err != nil {
		return provider.Credential{}, s.Err
	}
	return s.Credential, nil
}

func (s *StaticCredentialResolver) Invalidate(CredentialRef) {}
