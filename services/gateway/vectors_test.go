package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type signingVectors struct {
	Note                  string          `json:"note"`
	Passphrase            string          `json:"passphrase"`
	Salt                  string          `json:"salt"`
	Scrypt                scryptParams    `json:"scrypt"`
	DerivedKeyHex         string          `json:"derivedKeyHex"`
	PreviousPassphrase    string          `json:"previousPassphrase"`
	PreviousDerivedKeyHex string          `json:"previousDerivedKeyHex"`
	Canonical             string          `json:"canonical"`
	Payload               json.RawMessage `json:"payload"`
	SignatureHex          string          `json:"signatureHex"`
}

type scryptParams struct {
	N     int `json:"N"`
	R     int `json:"r"`
	P     int `json:"p"`
	DkLen int `json:"dkLen"`
}

// loadSigningVectors reads testdata/signing-vectors.json, which was produced by
// the real TypeScript signer (Node crypto.scryptSync + canonicalJson from
// src/lib/catalog/snapshot.ts). Verifying against it proves cross-language
// agreement instead of self-consistency.
func loadSigningVectors(t *testing.T) signingVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "signing-vectors.json"))
	if err != nil {
		t.Fatalf("read signing vectors: %v", err)
	}
	var v signingVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode signing vectors: %v", err)
	}
	return v
}

// decodeJSONValue decodes JSON the way the gateway decodes control-plane
// responses: json.Number for every numeric literal.
func decodeJSONValue(t *testing.T, raw []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	return value
}
