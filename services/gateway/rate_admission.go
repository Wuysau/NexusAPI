package main

import (
	"net/http"
	"strconv"
	"time"
)

func (p *Proxy) allowLocalAdmission() bool {
	return p.env != nil && (p.env.Environment == "development" || p.env.Environment == "test")
}

// A recovery hint is meaningful only for a request that can fit after refill.
// Round upward so a client waiting the advertised seconds does not retry early.
func writeRateLimitError(w http.ResponseWriter, requestID string, retryAfter time.Duration) {
	if retryAfter > 0 {
		seconds := retryAfter / time.Second
		if retryAfter%time.Second != 0 {
			seconds++
		}
		w.Header().Set("Retry-After", strconv.FormatInt(int64(seconds), 10))
	}
	writeAPIError(w, requestID, errRateLimited())
}
