package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nexus/gateway/provider"
)

// These exercise the production resolver against a controlled TLS Vault wire
// boundary. They complement, but do not impersonate, the real AppRole suite.
func TestVaultRequestTimeoutAndExplicitRecovery(t *testing.T) {
	for _, stage := range []string{"response_headers", "response_body"} {
		t.Run(stage, func(t *testing.T) {
			f := newRegistryFixture(t)
			var stalled atomic.Bool
			var calls atomic.Int32
			f.vault.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				calls.Add(1)
				if req.Header.Get("X-Vault-Token") != "synthetic-gateway-token" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if stalled.Load() {
					if stage == "response_body" {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusOK)
						w.(http.Flusher).Flush()
					}
					select {
					case <-req.Context().Done():
					case <-time.After(2 * time.Second):
					}
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"plaintext": base64.StdEncoding.EncodeToString(f.dek)}})
			})
			r, err := NewVaultCredentialResolver(f.config)
			if err != nil {
				t.Fatal("resolver bootstrap failed", err)
			}
			// Prime TLS before measuring the request deadline, excluding cold TLS
			// setup from the deliberately stalled response boundary.
			if _, err = r.Resolve(context.Background(), fixtureRef); err != nil {
				t.Fatal("healthy warmup failed", err)
			}
			stalled.Store(true)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			started := time.Now()
			credential, err := r.Resolve(ctx, fixtureRef)
			if err == nil || credential.Secret != "" {
				t.Fatal("stalled Vault request returned a credential")
			}
			if elapsed := time.Since(started); elapsed > time.Second {
				t.Fatal("Vault request ignored caller deadline")
			}
			if strings.Contains(err.Error(), "synthetic-gateway-token") || strings.Contains(err.Error(), "synthetic-provider-canary") {
				t.Fatal("Vault failure leaked secret material")
			}
			if calls.Load() != 2 {
				t.Fatal("timeout silently retried Vault unwrap")
			}
			stalled.Store(false)
			credential, err = r.Resolve(context.Background(), fixtureRef)
			if err != nil || credential.Secret != "synthetic-provider-canary" || calls.Load() != 3 {
				t.Fatal("explicit recovery attempt failed")
			}
		})
	}
}

func TestVaultUnavailableRetryRevalidatesIdentityAndRegistry(t *testing.T) {
	f := newRegistryFixture(t)
	var available atomic.Bool
	var calls atomic.Int32
	f.vault.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		if !available.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if req.Header.Get("X-Vault-Token") != "synthetic-gateway-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"plaintext": base64.StdEncoding.EncodeToString(f.dek)}})
	})
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal("resolver bootstrap failed", err)
	}
	assertDenied := func(c provider.Credential, err error) {
		t.Helper()
		if err == nil || c.Secret != "" {
			t.Fatal("unavailable or revoked Vault identity returned a credential")
		}
	}
	assertDenied(r.Resolve(context.Background(), fixtureRef))
	if calls.Load() != 1 {
		t.Fatal("503 silently retried Vault unwrap")
	}
	available.Store(true)
	mustWrite(t, f.config.TokenFile, []byte("revoked-fixture-identity"))
	assertDenied(r.Resolve(context.Background(), fixtureRef))
	if calls.Load() != 2 {
		t.Fatal("recovery did not read current identity")
	}
	mustWrite(t, f.config.TokenFile, []byte("synthetic-gateway-token"))
	if c, err := r.Resolve(context.Background(), fixtureRef); err != nil || c.Secret != "synthetic-provider-canary" {
		t.Fatal("restored identity could not recover")
	}
	f.payload.RegistryVersion++
	f.payload.RevocationEpoch++
	f.payload.Entries = []RegistryEntry{}
	f.write()
	assertDenied(r.Resolve(context.Background(), fixtureRef))
	if calls.Load() != 3 {
		t.Fatal("revoked registry retry reached Vault")
	}
}
