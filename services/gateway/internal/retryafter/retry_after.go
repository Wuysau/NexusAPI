// Package retryafter normalizes explicitly supported HTTP cooldown hints.
package retryafter

import (
	"net/http"
	"strings"
	"time"
)

// MaxDelay bounds every accepted upstream hint.
const MaxDelay = 60 * time.Second

// Parse returns a bounded positive duration, or zero when no hint is usable.
// Millisecond headers take precedence; invalid values fall through to the next
// header. Callers retain only the duration, never raw header values.
func Parse(headers http.Header, now time.Time) time.Duration {
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
		return min(deadline.Sub(now), MaxDelay)
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
	limit := uint64(MaxDelay / unit)
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
