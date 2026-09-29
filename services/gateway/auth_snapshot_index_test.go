package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// Changes are made to a newly decoded document, then signed. Readers retain
// their original generation while WarmAll verifies and publishes the candidate.
func authIndexCandidate(t *testing.T, h *testHarness, change func(*GatewayBundle)) []byte {
	t.Helper()
	h.source.mu.Lock()
	raw := append([]byte(nil), h.source.bundles[""]...)
	h.source.mu.Unlock()
	var envelope snapshotEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	var bundle GatewayBundle
	if err := json.Unmarshal(envelope.Bundle, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.SequenceNumber++
	bundle.Snapshot.SequenceNumber++
	bundle.RevocationEpoch++
	change(&bundle)
	return signBundleForTest(t, h.keyring, &bundle)
}

func authIndexPublish(h *testHarness, body []byte) {
	h.source.mu.Lock()
	h.source.bundles[""] = body
	h.source.mu.Unlock()
	h.snapshots.WarmAll(context.Background())
}

func requireAuthIndexError(t *testing.T, auth *Authenticator, key, scope, code string) {
	t.Helper()
	identity, err := auth.Authenticate(context.Background(), key, scope)
	var apiErr *APIError
	if identity != nil || !errors.As(err, &apiErr) || apiErr.Code != code {
		t.Fatalf("authentication result = %v, want %s", err, code)
	}
}

func TestIndexedAuthenticationTracksSignedKeyStateChanges(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*SnapshotKey)
	}{
		{"revoked", CodeKeyRevoked, func(key *SnapshotKey) { key.RevokedAt = nullableString(time.Now().UTC().Format(time.RFC3339)) }},
		{"disabled", CodeKeyDisabled, func(key *SnapshotKey) { key.Enabled = false }},
		{"scope_removed", CodeScopeDenied, func(key *SnapshotKey) { key.Scopes = []string{ScopeModelsRead} }},
		{"expired", CodeKeyExpired, func(key *SnapshotKey) {
			key.ExpiresAt = nullableString(time.Now().Add(-time.Minute).UTC().Format(time.RFC3339))
		}},
		{"project_changed", "", func(key *SnapshotKey) { key.ProjectID, key.ProjectName = "project-next", "Next Project" }},
		{"tenant_changed", "", func(key *SnapshotKey) {
			key.TenantID, key.OrganizationID, key.ProjectID = "tenant-next", "org-next", "project-next"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{})
			previousIdentity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
			if err != nil {
				t.Fatal(err)
			}
			previous := h.snapshots.entryFor("").state.Load()
			previousKey := previous.Verified.Bundle.KeyByHash(HashKey(testAPIKey))
			oldJSON, _ := json.Marshal(previousIdentity)
			candidate := authIndexCandidate(t, h, func(bundle *GatewayBundle) { tc.change(&bundle.Keys[0]) })
			authIndexPublish(h, candidate)
			current := h.snapshots.entryFor("").state.Load()
			if current == previous || current.Verified.Bundle.KeyByHash(HashKey(testAPIKey)) == previousKey {
				t.Fatal("fresh directory did not replace its key lookup generation")
			}
			if tc.code != "" {
				requireAuthIndexError(t, h.proxy.authn, testAPIKey, ScopeChatWrite, tc.code)
				if tc.name == "scope_removed" {
					if _, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeModelsRead); err != nil {
						t.Fatal("remaining scope was lost during refresh")
					}
				}
			} else {
				identity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
				if err != nil || identity.ProjectID != "project-next" || identity.DirectoryEpoch != current.Verified.Bundle.RevocationEpoch {
					t.Fatalf("fresh identity metadata was not observed: %v", err)
				}
				if tc.name == "project_changed" && identity.ProjectName != "Next Project" {
					t.Fatal("project name remained cached")
				}
				if tc.name == "tenant_changed" && (identity.TenantID != "tenant-next" || identity.OrganizationID != "org-next") {
					t.Fatal("prior tenant or organization remained cached")
				}
			}
			if key := previous.Verified.Bundle.KeyByHash(HashKey(testAPIKey)); key != previousKey || !key.Enabled || key.RevokedAt != nil || key.ExpiresAt != nil || key.ProjectID != "project-test" || key.TenantID != testTenantID || !scopeMatches(key.Scopes, ScopeChatWrite) {
				t.Fatal("refresh mutated the prior signed key generation")
			}
			if unchanged, _ := json.Marshal(previousIdentity); string(unchanged) != string(oldJSON) {
				t.Fatal("refresh reinterpreted an already authenticated request")
			}
		})
	}
}

func TestIndexedAuthenticationTracksAddedRemovedAndReorderedHashes(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	if _, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite); err != nil {
		t.Fatal(err)
	}
	addedKey := APIKeyPrefix + "added-fixture-key-00000000000000000000"
	requireAuthIndexError(t, h.proxy.authn, addedKey, ScopeChatWrite, CodeInvalidAPIKey)
	added := authIndexCandidate(t, h, func(bundle *GatewayBundle) {
		key := bundle.Keys[0]
		key.HashSHA256, key.KeyID, key.ProjectID = HashKey(addedKey), "key-added", "project-added"
		// Moving the old key to index one catches an index reused across generations.
		bundle.Keys = append([]SnapshotKey{key}, bundle.Keys...)
	})
	authIndexPublish(h, added)
	for _, tc := range []struct{ presented, keyID string }{{testAPIKey, testKeyID}, {addedKey, "key-added"}} {
		identity, err := h.proxy.authn.Authenticate(context.Background(), tc.presented, ScopeChatWrite)
		if err != nil || identity.KeyID != tc.keyID {
			t.Fatalf("reordered directory resolved the wrong key: %v", err)
		}
	}
	removed := authIndexCandidate(t, h, func(bundle *GatewayBundle) { bundle.Keys = bundle.Keys[:1] })
	authIndexPublish(h, removed)
	requireAuthIndexError(t, h.proxy.authn, testAPIKey, ScopeChatWrite, CodeInvalidAPIKey)
	if identity, err := h.proxy.authn.Authenticate(context.Background(), addedKey, ScopeChatWrite); err != nil || identity.KeyID != "key-added" {
		t.Fatal("removing one key disturbed the remaining key")
	}
	empty := authIndexCandidate(t, h, func(bundle *GatewayBundle) { bundle.Keys = nil })
	authIndexPublish(h, empty)
	requireAuthIndexError(t, h.proxy.authn, addedKey, ScopeChatWrite, CodeInvalidAPIKey)
}

func TestRejectedKeyDirectoryCannotReplaceVerifiedLookup(t *testing.T) {
	for _, rejection := range []string{"tampered", "expired"} {
		t.Run(rejection, func(t *testing.T) {
			h := newHarness(t, harnessOptions{})
			if _, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite); err != nil {
				t.Fatal(err)
			}
			previous := h.snapshots.entryFor("").state.Load()
			previousKey := previous.Verified.Bundle.KeyByHash(HashKey(testAPIKey))
			untrustedKey := APIKeyPrefix + "untrusted-fixture-000000000000000000"
			candidate := authIndexCandidate(t, h, func(bundle *GatewayBundle) {
				bundle.Keys[0].HashSHA256 = HashKey(untrustedKey)
				if rejection == "expired" {
					bundle.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
				}
			})
			if rejection == "tampered" {
				var envelope snapshotEnvelope
				if err := json.Unmarshal(candidate, &envelope); err != nil {
					t.Fatal(err)
				}
				envelope.Signature = "invalid-signature"
				candidate, _ = json.Marshal(envelope)
			}
			authIndexPublish(h, candidate)
			if retained := h.snapshots.entryFor("").state.Load(); retained != previous || retained.Verified.Bundle.KeyByHash(HashKey(testAPIKey)) != previousKey {
				t.Fatal("rejected directory replaced an accepted key index")
			}
			if _, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite); err != nil {
				t.Fatal("rejected refresh disturbed a still-fresh key directory")
			}
			requireAuthIndexError(t, h.proxy.authn, untrustedKey, ScopeChatWrite, CodeInvalidAPIKey)
		})
	}
}

func TestConcurrentAuthenticationSeesOneSignedGeneration(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	initial, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeModelsRead)
	if err != nil {
		t.Fatal(err)
	}
	h.source.mu.Lock()
	original := append([]byte(nil), h.source.bundles[""]...)
	h.source.mu.Unlock()
	replacement := authIndexCandidate(t, h, func(bundle *GatewayBundle) {
		target := bundle.Keys[0]
		target.TenantID, target.OrganizationID, target.ProjectID, target.ProjectName = "tenant-next", "org-next", "project-next", "Next"
		target.Scopes = []string{ScopeModelsRead}
		other := bundle.Keys[0]
		other.HashSHA256, other.KeyID = HashKey(APIKeyPrefix+"unrelated-fixture-key-000000000000"), "key-unrelated"
		bundle.Keys = []SnapshotKey{other, target}
	})
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	failures := make(chan error, 16)
	observedReplacement := make(chan struct{}, 1)
	defer func() { cancel(); workers.Wait() }()
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for ctx.Err() == nil {
				identity, err := h.proxy.authn.Authenticate(ctx, testAPIKey, ScopeModelsRead)
				if ctx.Err() != nil {
					return
				}
				if err != nil {
					failures <- fmt.Errorf("fresh directory authentication failed: %w", err)
					return
				}
				valid := identity.KeyID == testKeyID
				switch identity.DirectoryEpoch {
				case initial.DirectoryEpoch:
					valid = valid && identity.TenantID == testTenantID && identity.OrganizationID == testOrgID && identity.ProjectID == "project-test" && identity.ProjectName == "Project Test" && identity.HasScope(ScopeChatWrite)
				case initial.DirectoryEpoch + 1:
					valid = valid && identity.TenantID == "tenant-next" && identity.OrganizationID == "org-next" && identity.ProjectID == "project-next" && identity.ProjectName == "Next" && !identity.HasScope(ScopeChatWrite)
					select {
					case observedReplacement <- struct{}{}:
					default:
					}
				default:
					valid = false
				}
				if !valid {
					failures <- errors.New("authentication mixed fields from different signed generations")
					return
				}
			}
		}()
	}
	authIndexPublish(h, replacement)
	select {
	case <-observedReplacement:
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(3 * time.Second):
		t.Fatal("concurrent readers did not observe the published generation")
	}
	for i := 0; i < 20; i++ {
		authIndexPublish(h, original)
		authIndexPublish(h, replacement)
	}
	cancel()
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if final, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeModelsRead); err != nil || final.ProjectID != "project-next" || final.DirectoryEpoch != initial.DirectoryEpoch+1 {
		t.Fatal("final request did not observe the final published directory")
	}
}
