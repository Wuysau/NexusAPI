package main

// scrypt (RFC 7914) implemented against the standard library only.
//
// The gateway verifies snapshots with the same keyring the control plane signs
// them with (src/lib/crypto.ts:deriveKey), which derives a 32-byte key via
// scryptSync(passphrase, "nexusapi-upstream-key-salt", 32, {N: 16384, r: 8, p: 1}).
// Reproducing that in Go requires scrypt, and the gateway's dependency budget is
// stdlib + chi/redis/pgx/otel, so it is implemented here rather than pulling in
// golang.org/x/crypto.
//
// Correctness is not taken on faith: scrypt_test.go checks fixed RFC 7914
// vectors and snapshot_test.go checks a signature produced by the real
// TypeScript signer.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/bits"
)

// ScryptKey derives a key of keyLen bytes. Parameters mirror Node's scryptSync.
func ScryptKey(password, salt []byte, N, r, p, keyLen int) ([]byte, error) {
	if N <= 1 || N&(N-1) != 0 {
		return nil, errors.New("scrypt: N must be > 1 and a power of 2")
	}
	if r <= 0 || p <= 0 {
		return nil, errors.New("scrypt: r and p must be positive")
	}
	if uint64(r)*uint64(p) >= 1<<30 {
		return nil, errors.New("scrypt: parameters too large")
	}
	blockSize := 128 * r
	b := pbkdf2SHA256(password, salt, 1, p*blockSize)

	// Working memory is reused across the p lanes: N*blockSize bytes for V and
	// 2*blockSize for XY. For the keyring parameters this is 16 MiB, freed as
	// soon as the key is derived (the caller caches only the 32-byte result).
	v := make([]uint32, N*32*r)
	xy := make([]uint32, 64*r)
	for i := 0; i < p; i++ {
		smix(b[i*blockSize:(i+1)*blockSize], r, N, v, xy)
	}
	return pbkdf2SHA256(password, b, 1, keyLen), nil
}

// pbkdf2SHA256 is PBKDF2-HMAC-SHA256 specialised for c == 1, which is all
// scrypt ever needs. With one iteration T_i = U_1 = HMAC(P, S || INT(i)).
func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	hashLen := sha256.Size
	numBlocks := (keyLen + hashLen - 1) / hashLen
	out := make([]byte, 0, numBlocks*hashLen)
	mac := hmac.New(sha256.New, password)
	var counter [4]byte
	for block := 1; block <= numBlocks; block++ {
		binary.BigEndian.PutUint32(counter[:], uint32(block))
		mac.Reset()
		mac.Write(salt)
		mac.Write(counter[:])
		u := mac.Sum(nil)
		// iterations == 1 for scrypt; loop kept general and cheap.
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iterations; i++ {
			mac.Reset()
			mac.Write(u)
			u = mac.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func smix(b []byte, r, N int, v, xy []uint32) {
	var tmp [16]uint32
	words := 32 * r
	x := xy[:words]
	y := xy[words : 2*words]

	j := 0
	for i := 0; i < words; i++ {
		x[i] = binary.LittleEndian.Uint32(b[j:])
		j += 4
	}
	for i := 0; i < N; i += 2 {
		copy(v[i*words:(i+1)*words], x)
		blockMix(&tmp, x, y, r)
		copy(v[(i+1)*words:(i+2)*words], y)
		blockMix(&tmp, y, x, r)
	}
	for i := 0; i < N; i += 2 {
		k := int(integerify(x, r) & uint64(N-1))
		blockXOR(x, v[k*words:(k+1)*words])
		blockMix(&tmp, x, y, r)
		k = int(integerify(y, r) & uint64(N-1))
		blockXOR(y, v[k*words:(k+1)*words])
		blockMix(&tmp, y, x, r)
	}
	j = 0
	for _, w := range x {
		binary.LittleEndian.PutUint32(b[j:], w)
		j += 4
	}
}

func blockXOR(dst, src []uint32) {
	for i, v := range src {
		dst[i] ^= v
	}
}

// integerify interprets the last 64-byte block as a little-endian integer.
// Only the low 32 bits are meaningful for the N values scrypt uses (< 2^32).
func integerify(b []uint32, r int) uint64 {
	j := (2*r - 1) * 16
	return uint64(b[j]) | uint64(b[j+1])<<32
}

// blockMix implements B' = BlockMix_{Salsa20/8,r}(B): chain Salsa20/8 over the
// 2r 64-byte blocks of `in`, then emit the even-indexed results first and the
// odd-indexed results second.
func blockMix(tmp *[16]uint32, in, out []uint32, r int) {
	copy(tmp[:], in[(2*r-1)*16:])
	for k := 0; k < r; k++ {
		salsaXOR(tmp, in[(2*k)*16:], out[k*16:])
		salsaXOR(tmp, in[(2*k+1)*16:], out[(r+k)*16:])
	}
}

// salsaXOR computes tmp = Salsa20/8(tmp XOR in) and writes the 64-byte result
// to out (as 8 uint32 words). tmp carries the chaining state between calls.
func salsaXOR(tmp *[16]uint32, in, out []uint32) {
	w0 := tmp[0] ^ in[0]
	w1 := tmp[1] ^ in[1]
	w2 := tmp[2] ^ in[2]
	w3 := tmp[3] ^ in[3]
	w4 := tmp[4] ^ in[4]
	w5 := tmp[5] ^ in[5]
	w6 := tmp[6] ^ in[6]
	w7 := tmp[7] ^ in[7]
	w8 := tmp[8] ^ in[8]
	w9 := tmp[9] ^ in[9]
	w10 := tmp[10] ^ in[10]
	w11 := tmp[11] ^ in[11]
	w12 := tmp[12] ^ in[12]
	w13 := tmp[13] ^ in[13]
	w14 := tmp[14] ^ in[14]
	w15 := tmp[15] ^ in[15]

	x0, x1, x2, x3 := w0, w1, w2, w3
	x4, x5, x6, x7 := w4, w5, w6, w7
	x8, x9, x10, x11 := w8, w9, w10, w11
	x12, x13, x14, x15 := w12, w13, w14, w15

	for i := 0; i < 8; i += 2 {
		x4 ^= bits.RotateLeft32(x0+x12, 7)
		x8 ^= bits.RotateLeft32(x4+x0, 9)
		x12 ^= bits.RotateLeft32(x8+x4, 13)
		x0 ^= bits.RotateLeft32(x12+x8, 18)
		x9 ^= bits.RotateLeft32(x5+x1, 7)
		x13 ^= bits.RotateLeft32(x9+x5, 9)
		x1 ^= bits.RotateLeft32(x13+x9, 13)
		x5 ^= bits.RotateLeft32(x1+x13, 18)
		x14 ^= bits.RotateLeft32(x10+x6, 7)
		x2 ^= bits.RotateLeft32(x14+x10, 9)
		x6 ^= bits.RotateLeft32(x2+x14, 13)
		x10 ^= bits.RotateLeft32(x6+x2, 18)
		x3 ^= bits.RotateLeft32(x15+x11, 7)
		x7 ^= bits.RotateLeft32(x3+x15, 9)
		x11 ^= bits.RotateLeft32(x7+x3, 13)
		x15 ^= bits.RotateLeft32(x11+x7, 18)

		x1 ^= bits.RotateLeft32(x0+x3, 7)
		x2 ^= bits.RotateLeft32(x1+x0, 9)
		x3 ^= bits.RotateLeft32(x2+x1, 13)
		x0 ^= bits.RotateLeft32(x3+x2, 18)
		x6 ^= bits.RotateLeft32(x5+x4, 7)
		x7 ^= bits.RotateLeft32(x6+x5, 9)
		x4 ^= bits.RotateLeft32(x7+x6, 13)
		x5 ^= bits.RotateLeft32(x4+x7, 18)
		x11 ^= bits.RotateLeft32(x10+x9, 7)
		x8 ^= bits.RotateLeft32(x11+x10, 9)
		x9 ^= bits.RotateLeft32(x8+x11, 13)
		x10 ^= bits.RotateLeft32(x9+x8, 18)
		x12 ^= bits.RotateLeft32(x15+x14, 7)
		x13 ^= bits.RotateLeft32(x12+x15, 9)
		x14 ^= bits.RotateLeft32(x13+x12, 13)
		x15 ^= bits.RotateLeft32(x14+x13, 18)
	}

	tmp[0] = x0 + w0
	tmp[1] = x1 + w1
	tmp[2] = x2 + w2
	tmp[3] = x3 + w3
	tmp[4] = x4 + w4
	tmp[5] = x5 + w5
	tmp[6] = x6 + w6
	tmp[7] = x7 + w7
	tmp[8] = x8 + w8
	tmp[9] = x9 + w9
	tmp[10] = x10 + w10
	tmp[11] = x11 + w11
	tmp[12] = x12 + w12
	tmp[13] = x13 + w13
	tmp[14] = x14 + w14
	tmp[15] = x15 + w15

	copy(out[:16], tmp[:])
}
