package provider

import (
	"net/http"
	"strings"
	"time"
)

const maxRetryAfter = 60 * time.Second

// retryAfter keeps only a bounded duration from explicitly supported headers.
// Millisecond headers take precedence; invalid values fall through to the next
// header. Raw headers never leave the adapter or enter errors and logs.
func retryAfter(headers http.Header, now time.Time) time.Duration {
	for _, name := range []string{"retry-after-ms", "x-ms-retry-after-ms"} {
		if delay := positiveRetryNumber(headers.Get(name), time.Millisecond); delay > 0 {
			return delay
		}
	}
	value := strings.TrimSpace(headers.Get("Retry-After"))
	if delay := positiveRetryNumber(value, time.Second); delay > 0 {
		return delay
	}
	if deadline, err := http.ParseTime(value); err == nil && deadline.After(now) {
		return min(deadline.Sub(now), maxRetryAfter)
	}
	return 0
}

// Parse digits with saturation before multiplication so even extremely large
// valid integers cannot overflow. Signs, fractions and duplicate values fail.
func positiveRetryNumber(value string, unit time.Duration) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	limit := uint64(maxRetryAfter / unit)
	var number uint64
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return 0
		}
		if number <= limit {
			number = min(number*10+uint64(digit-'0'), limit+1)
		}
	}
	return time.Duration(min(number, limit)) * unit
}

func newUpstreamHTTPError(status int, body []byte, headers http.Header, now time.Time) *UpstreamHTTPError {
	return &UpstreamHTTPError{Status: status, Body: body, RetryAfter: retryAfter(headers, now)}
}
