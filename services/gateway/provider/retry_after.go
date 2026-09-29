package provider

import (
	"net/http"
	"time"

	"nexus/gateway/internal/retryafter"
)

// retryAfter keeps only a bounded duration from explicitly supported headers.
// Millisecond headers take precedence; invalid values fall through to the next
// header. Raw headers never leave the adapter or enter errors and logs.
func retryAfter(headers http.Header, now time.Time) time.Duration {
	return retryafter.Parse(headers, now)
}

func newUpstreamHTTPError(status int, body []byte, headers http.Header, now time.Time) *UpstreamHTTPError {
	return &UpstreamHTTPError{Status: status, Body: body, RetryAfter: retryAfter(headers, now)}
}
