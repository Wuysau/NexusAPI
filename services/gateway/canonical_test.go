package main

import (
	"math"
	"testing"
)

// The canonical encoder must reproduce JavaScript's JSON.stringify output
// exactly, including the escaping Go's encoding/json would otherwise differ on
// (<, >, & are NOT escaped by JavaScript).
func TestCanonicalJSONMatchesTypeScriptSigner(t *testing.T) {
	v := loadSigningVectors(t)
	got, err := CanonicalJSON(decodeJSONValue(t, v.Payload))
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if got != v.Canonical {
		t.Fatalf("canonical mismatch\n got %s\nwant %s", got, v.Canonical)
	}
}

func TestCanonicalJSONSortsKeysAndPreservesNumberLiterals(t *testing.T) {
	in := decodeJSONValue(t, []byte(`{"b":1,"a":{"d":2,"c":[3,{"z":0,"y":1}]},"n":1e+21}`))
	got, err := CanonicalJSON(in)
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `{"a":{"c":[3,{"y":1,"z":0}],"d":2},"b":1,"n":1e+21}`
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestCanonicalJSONRejectsNonCanonicalInput(t *testing.T) {
	if _, err := CanonicalJSON(map[string]any{"é": 1}); err == nil {
		t.Fatal("expected non-ASCII key to be rejected")
	}
	if _, err := CanonicalJSON(map[string]any{"k": math.NaN()}); err == nil {
		t.Fatal("expected NaN to be rejected")
	}
}
