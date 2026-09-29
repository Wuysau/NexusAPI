package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestVerifiedKeyIndexPreservesSignedDirectory(t *testing.T) {
	v := loadBundleVector(t)
	kr := vectorKeyring(t, v)
	var env snapshotEnvelope
	if err := json.Unmarshal(v.Envelope, &env); err != nil {
		t.Fatal(err)
	}
	var input GatewayBundle
	if err := json.Unmarshal(env.Bundle, &input); err != nil {
		t.Fatal(err)
	}
	// The first duplicate must remain authoritative, even if a later entry is
	// enabled or belongs to another tenant. Hash comparison stays exact.
	hash := strings.Repeat("ab", 32)
	input.Keys = []SnapshotKey{
		{HashSHA256: hash, KeyID: "first", TenantID: "tenant-a", Enabled: false},
		{HashSHA256: hash, KeyID: "duplicate", TenantID: "tenant-b", Enabled: true},
		{HashSHA256: strings.ToUpper(hash), KeyID: "uppercase"},
		{HashSHA256: "", KeyID: "empty"},
	}
	before, err := json.Marshal(&input)
	if err != nil {
		t.Fatal(err)
	}
	signed := signBundleForTest(t, kr, &input)
	verified, err := VerifySnapshotResponse(signed, kr, v.ExpectedTenant, testNow(t, v))
	if err != nil {
		t.Fatal(err)
	}
	bundle := verified.Bundle
	if bundle.keyIndex == nil || len(bundle.keyIndex) != 3 {
		t.Fatal("verified directory has no complete index")
	}
	for _, tc := range []struct {
		hash string
		pos  int
	}{{hash, 0}, {strings.ToUpper(hash), 2}, {"", 3}} {
		if got := bundle.KeyByHash(tc.hash); got != &bundle.Keys[tc.pos] {
			t.Errorf("lookup did not preserve directory position %d", tc.pos)
		}
	}
	if bundle.KeyByHash(strings.Repeat("c", 64)) != nil {
		t.Fatal("unknown hash resolved to a directory entry")
	}
	after, err := json.Marshal(bundle)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("derived index changed serialized bundle: %v", err)
	}
	canonical, err := CanonicalJSON(decodeWithNumbers(after))
	if err != nil || canonical != verified.Canonical {
		t.Fatalf("derived index changed signed canonical JSON: %v", err)
	}
	if err := kr.VerifyHMAC(verified.SigningKeyID, canonical, verified.Signature); err != nil {
		t.Fatalf("indexed bundle no longer verifies: %v", err)
	}
}

func TestVerifiedEmptyKeyDirectoryHasIndex(t *testing.T) {
	v := loadBundleVector(t)
	kr := vectorKeyring(t, v)
	verified, err := VerifySnapshotResponse(v.Envelope, kr, v.ExpectedTenant, testNow(t, v))
	if err != nil {
		t.Fatal(err)
	}
	for _, keys := range [][]SnapshotKey{nil, {}} {
		input := *verified.Bundle
		input.Keys = keys
		got, err := VerifySnapshotResponse(signBundleForTest(t, kr, &input), kr, v.ExpectedTenant, testNow(t, v))
		if err != nil {
			t.Fatal(err)
		}
		if got.Bundle.keyIndex == nil || len(got.Bundle.keyIndex) != 0 || got.Bundle.KeyByHash("") != nil {
			t.Fatal("empty verified directory must have an empty private index")
		}
	}
}

func TestManualKeyDirectoryLookupIsReadOnly(t *testing.T) {
	bundle := GatewayBundle{Keys: []SnapshotKey{
		{HashSHA256: "same", KeyID: "first"},
		{HashSHA256: "same", KeyID: "second"},
	}}
	if bundle.KeyByHash("same") != &bundle.Keys[0] || bundle.KeyByHash("missing") != nil {
		t.Fatal("unindexed directory lost first-match semantics")
	}
	if bundle.keyIndex != nil {
		t.Fatal("lookup mutated an unindexed directory")
	}
}
