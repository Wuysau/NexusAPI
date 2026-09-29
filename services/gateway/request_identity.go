package main

import (
	"context"
	"net/http"
	"strings"
)

type requestIdentityKey struct{}

// The authoritative identity is generated here, never from an HTTP header.
// Internal wire adapters share this private context value when cloning a call.
func withRequestIdentity(r *http.Request) *http.Request {
	if id, _ := r.Context().Value(requestIdentityKey{}).(string); id != "" {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), requestIdentityKey{}, newRandomID()))
}

func requestIdentityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withRequestIdentity(r)
		w.Header().Set("x-request-id", ensureRequestID(r))
		// Correlation is useful to callers but is not persisted or used for
		// authorization, accounting, tracing identity, or deduplication.
		correlation := r.Header.Get("x-client-request-id")
		if correlation == "" {
			correlation = r.Header.Get("x-request-id")
		}
		correlation = strings.TrimSpace(correlation)
		if len(correlation) > 0 && len(correlation) <= 128 && isSafeID(correlation) {
			w.Header().Set("x-client-request-id", correlation)
		}
		next.ServeHTTP(w, r)
	})
}
