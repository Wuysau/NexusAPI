package main

// Canonical JSON, byte-compatible with `canonicalJson` in
// src/lib/catalog/snapshot.ts.
//
// The control plane signs `canonicalJson(payload)` with HMAC-SHA256. The
// gateway must re-derive exactly the same bytes from the JSON it received, or
// verification fails. The two implementations therefore have to agree on:
//
//   - object keys sorted ascending (ASCII keys only, see below)
//   - no whitespace
//   - strings escaped exactly like JavaScript's JSON.stringify
//   - numbers emitted as their original JSON literal
//
// Numbers are decoded with json.Number and re-emitted verbatim. The bytes the
// gateway verifies were produced by JavaScript's JSON.stringify (the control
// plane serializes the response body with it), so the literal in the response
// is already the JavaScript representation; preserving it is exact. Re-encoding
// through float64 would risk a different rendering for values where Go and
// JavaScript disagree on exponent formatting.
//
// Key ordering: JavaScript's Array.prototype.sort compares UTF-16 code units,
// Go's sort.Strings compares UTF-8 bytes. The two agree for ASCII, and every
// key in the snapshot bundle is ASCII (schema_version, price_versions, ...).
// canonicalJSON rejects non-ASCII keys rather than silently ordering them
// differently from the signer.

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// CanonicalJSON renders any JSON-decoded value (with json.Number for numbers)
// in the canonical form the control plane signs.
func CanonicalJSON(value any) (string, error) {
	var sb strings.Builder
	if err := writeCanonical(&sb, value); err != nil {
		return "", err
	}
	return sb.String(), nil
}

func writeCanonical(sb *strings.Builder, value any) error {
	switch v := value.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if v {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case string:
		writeJSONString(sb, v)
	case json.Number:
		// Reject NaN/Infinity spellings outright: they are not valid JSON and
		// JavaScript's JSON.stringify would have produced null.
		if !isExactJSONNumber(v.String()) {
			return fmt.Errorf("canonical: non-finite or malformed number %q", v.String())
		}
		sb.WriteString(v.String())
	case float64:
		// Only reached for values built in Go, never for decoded JSON.
		if v != v || v > 1.7976931348623157e308 || v < -1.7976931348623157e308 {
			return fmt.Errorf("canonical: non-finite number is not canonical")
		}
		sb.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	case []any:
		sb.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeCanonical(sb, item); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			if !isASCII(k) {
				return fmt.Errorf("canonical: non-ASCII object key %q is not supported", k)
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeJSONString(sb, k)
			sb.WriteByte(':')
			if err := writeCanonical(sb, v[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	default:
		return fmt.Errorf("canonical: cannot canonicalize %T", value)
	}
	return nil
}

// WriteJSONField writes `"key":value` with the key encoded the JavaScript way.
// Used by request/response builders that need canonical-ish fragments.
func WriteJSONField(sb *strings.Builder, key string) {
	writeJSONString(sb, key)
	sb.WriteByte(':')
}

// EncodeJSONString returns the JavaScript-JSON.stringify encoding of s.
func EncodeJSONString(s string) string {
	var sb strings.Builder
	writeJSONString(&sb, s)
	return sb.String()
}

// writeJSONString matches JavaScript's JSON.stringify string escaping:
// quote, reverse solidus, \b \f \n \r \t, other C0 controls as \u00XX, and
// lone surrogates as \uXXXX (ES2019 well-formed JSON.stringify). Go's
// encoding/json additionally escapes <, >, & by default, which would break
// byte equality with the signer, so it is not used here.
func writeJSONString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(sb, `\u%04x`, r)
			case r == utf8.RuneError:
				// Preserve U+FFFD literally; it is well-formed.
				sb.WriteRune(r)
			case utf16.IsSurrogate(r):
				fmt.Fprintf(sb, `\u%04x`, r)
			default:
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// isExactJSONNumber accepts only the JSON number grammar. json.Number can carry
// whatever the decoder saw, which for a well-formed document is already valid,
// but rejecting explicitly keeps the canonicalizer honest.
func isExactJSONNumber(s string) bool {
	if s == "" {
		return false
	}
	i := 0
	if s[i] == '-' {
		i++
	}
	if i >= len(s) {
		return false
	}
	if s[i] == '0' {
		i++
	} else if s[i] >= '1' && s[i] <= '9' {
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	} else {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		if i >= len(s) || s[i] < '0' || s[i] > '9' {
			return false
		}
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		if i >= len(s) || s[i] < '0' || s[i] > '9' {
			return false
		}
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	}
	return i == len(s)
}
