package main

import (
	"encoding/hex"
	"testing"
)

// RFC 7914 section 12 test vectors. These pin the Salsa20/8 core, BlockMix and
// ROMix independently of the TypeScript signer, so a scrypt bug cannot hide
// behind a matching mistake on the control-plane side.
func TestScryptRFC7914Vectors(t *testing.T) {
	cases := []struct {
		name     string
		password string
		salt     string
		N, r, p  int
		dkLen    int
		wantHex  string
	}{
		{
			name: "empty", password: "", salt: "", N: 16, r: 1, p: 1, dkLen: 64,
			wantHex: "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
				"fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
		},
		{
			name: "password/NaCl", password: "password", salt: "NaCl", N: 1024, r: 8, p: 16, dkLen: 64,
			wantHex: "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" +
				"2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
		},
		{
			name: "pleaseletmein", password: "pleaseletmein", salt: "SodiumChloride", N: 16384, r: 8, p: 1, dkLen: 64,
			wantHex: "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2" +
				"d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ScryptKey([]byte(tc.password), []byte(tc.salt), tc.N, tc.r, tc.p, tc.dkLen)
			if err != nil {
				t.Fatalf("ScryptKey: %v", err)
			}
			if hex.EncodeToString(got) != tc.wantHex {
				t.Fatalf("scrypt mismatch\n got %s\nwant %s", hex.EncodeToString(got), tc.wantHex)
			}
		})
	}
}

// The gateway's keyring parameters must reproduce Node's scryptSync byte for
// byte, or every snapshot signature check fails.
func TestScryptMatchesNodeKeyringDerivation(t *testing.T) {
	v := loadSigningVectors(t)
	got, err := ScryptKey([]byte(v.Passphrase), []byte(v.Salt), v.Scrypt.N, v.Scrypt.R, v.Scrypt.P, v.Scrypt.DkLen)
	if err != nil {
		t.Fatalf("ScryptKey: %v", err)
	}
	if hex.EncodeToString(got) != v.DerivedKeyHex {
		t.Fatalf("keyring derivation mismatch\n got %s\nwant %s", hex.EncodeToString(got), v.DerivedKeyHex)
	}
}
