package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSnapshotEnvelopeRequiresOneCompleteJSONDocument(t *testing.T) {
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"second object", append(append([]byte(nil), v.Envelope...), []byte(` {"tail-sensitive-marker":true}`)...)},
		{"second signed envelope", append(append([]byte(nil), v.Envelope...), v.Envelope...)},
		{"second null value", append(append([]byte(nil), v.Envelope...), []byte(" null")...)},
		{"trailing junk", append(append([]byte(nil), v.Envelope...), []byte(" tail-sensitive-marker")...)},
		{"truncated envelope", v.Envelope[:len(v.Envelope)-1]},
		{"malformed envelope", []byte(`{"bundle":`)},
		{"array envelope", []byte(`[]`)},
		{"empty input", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verified, err := VerifySnapshotResponse(tc.body, keyring, v.ExpectedTenant, testNow(t, v))
			var snapshotErr *SnapshotError
			if verified != nil || !errors.As(err, &snapshotErr) || snapshotErr.Reason != ReasonSnapshotRejected {
				t.Fatalf("invalid complete envelope was accepted: verified=%t err=%v", verified != nil, err)
			}
			if strings.Contains(err.Error(), "tail-sensitive-marker") {
				t.Fatal("rejected response content appeared in the error")
			}
		})
	}
}

func TestSnapshotEnvelopeRetainsWhitespaceAndAdditiveFieldCompatibility(t *testing.T) {
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(v.Envelope, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["future_metadata"] = json.RawMessage(`{"nested":{"bundle":"ignored"},"items":[1,true,null]}`)
	extended, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"surrounding JSON whitespace", append(append([]byte(" \n\t\r"), v.Envelope...), []byte(" \r\n\t")...)},
		{"unknown envelope field", extended},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verified, err := VerifySnapshotResponse(tc.body, keyring, v.ExpectedTenant, testNow(t, v))
			if err != nil || verified.Canonical != v.Canonical || verified.Signature != v.Signature {
				t.Fatalf("compatible envelope changed signed bundle verification: %v", err)
			}
		})
	}
}

func TestSnapshotEnvelopePreservesSignedNumericLiterals(t *testing.T) {
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	var envelope snapshotEnvelope
	if err := json.Unmarshal(v.Envelope, &envelope); err != nil {
		t.Fatal(err)
	}
	payload := decodeWithNumbers(envelope.Bundle).(map[string]any)
	// The raw signed bundle must not round its integers through float64 or
	// reformat number spellings while decoding the surrounding envelope.
	payload["sequence_number"] = json.Number("9007199254740993")
	payload["snapshot"].(map[string]any)["sequence_number"] = json.Number("9007199254740993")
	payload["future_numbers"] = []any{json.Number("1e+21"), json.Number("0.000001"), json.Number("-0")}
	canonical, err := CanonicalJSON(payload)
	if err != nil {
		t.Fatal(err)
	}
	keyID, signature := keyring.SignHMAC(canonical)
	raw, err := json.Marshal(map[string]any{"bundle": payload, "signing_key_id": keyID, "signature": signature})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := VerifySnapshotResponse(raw, keyring, v.ExpectedTenant, testNow(t, v))
	if err != nil || verified.Canonical != canonical || verified.Bundle.SequenceNumber != 9007199254740993 || verified.Bundle.Snapshot.SequenceNumber != 9007199254740993 {
		t.Fatalf("envelope decoding changed signed numeric values or spellings: %v", err)
	}
}

func TestSnapshotInvalidEnvelopeTailPreservesGenerationAndPermissions(t *testing.T) {
	for _, tail := range []string{` {"tail-sensitive-marker":true}`, " tail-sensitive-marker"} {
		t.Run(tail, func(t *testing.T) {
			clock := &testClock{now: time.Now().UTC().Truncate(time.Second)}
			h := newHarness(t, harnessOptions{Clock: clock.Now})
			h.snapshots.cfg.MaxAge = 10 * time.Second
			h.proxy.authn.SetClock(clock.Now)
			initialIdentity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
			if err != nil {
				t.Fatal(err)
			}
			initial := h.snapshots.entryFor("").state.Load()
			initialExpiry, initialFetched := initial.EffectiveExpiry, initial.FetchedAt
			initialKey := initial.Verified.Bundle.KeyByHash(HashKey(testAPIKey))
			if initial.Verified.Bundle.keyIndex == nil || initialKey == nil {
				t.Fatal("fixture did not publish an indexed key directory")
			}
			addedKey := APIKeyPrefix + "tail-rejected-fixture-key-000000000000"
			candidate := authIndexCandidate(t, h, func(bundle *GatewayBundle) {
				bundle.Keys[0].Scopes = []string{ScopeModelsRead}
				added := bundle.Keys[0]
				added.KeyID, added.HashSHA256, added.Scopes = "tail-rejected-key", HashKey(addedKey), []string{ScopeAll}
				bundle.Keys = append(bundle.Keys, added)
			})
			h.source.mu.Lock()
			h.source.bundles[""] = append(candidate, []byte(tail)...)
			h.source.mu.Unlock()
			clock.Advance(time.Second)
			h.snapshots.WarmAll(context.Background())
			retained, err := h.snapshots.Get(context.Background(), "")
			if err != nil || retained != initial || retained.EffectiveExpiry != initialExpiry || retained.FetchedAt != initialFetched {
				t.Fatal("malformed transport replaced or extended the accepted directory")
			}
			if retained.Verified.Bundle.KeyByHash(HashKey(testAPIKey)) != initialKey || retained.Verified.Bundle.KeyByHash(HashKey(addedKey)) != nil {
				t.Fatal("rejected refresh changed the private key index")
			}
			identity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
			if err != nil || identity.KeyID != initialIdentity.KeyID || identity.ProjectID != initialIdentity.ProjectID {
				t.Fatalf("malformed transport changed still-valid authorization: %v", err)
			}
			requireAuthIndexError(t, h.proxy.authn, addedKey, ScopeChatWrite, CodeInvalidAPIKey)
			clock.Advance(10 * time.Second)
			h.snapshots.WarmAll(context.Background())
			retained, err = h.snapshots.Get(context.Background(), "")
			if retained != initial || reasonOf(err) != ReasonSnapshotExpired || retained.Fresh(clock.Now()) || retained.EffectiveExpiry != initialExpiry || retained.FetchedAt != initialFetched {
				t.Fatal("repeated malformed responses revived or discarded the expired generation")
			}
			if identity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite); identity != nil || err == nil {
				t.Fatal("expired retained permissions still authenticated a new request")
			}
		})
	}
}
