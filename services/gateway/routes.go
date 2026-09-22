package main

// HTTP surface.
//
// Models and Chat Completions are enabled by default. Responses is an opt-in
// stateless protocol adapter; embeddings remains explicitly unsupported.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// RouteOptions gates the optional endpoints.
type RouteOptions struct {
	EnableResponses  bool
	EnableEmbeddings bool
}

// NewRouter wires the HTTP surface.
func NewHTTPRouter(proxy *Proxy, snapshots *SnapshotCache, limiter *Limiter, store Store, options RouteOptions) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.Recoverer)
	router.Use(headerLimitMiddleware(int64(proxy.limits.MaxHeaderBytes)))

	router.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"service": "nexus-gateway",
			"time":    time.Now().UTC().Format(time.RFC3339),
		})
	})

	router.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ready := snapshots.Ready()
		checks := map[string]any{
			"snapshot": ready,
			"database": store.Ping(r.Context()) == nil,
			"redis":    !limiter.Degraded(),
		}
		status := http.StatusOK
		if !ready {
			// No verified snapshot means no request can be authorized or
			// routed: the instance is not ready, and saying otherwise would
			// keep it in the load balancer while it fails every request.
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{"status": statusText(ready), "checks": checks})
	})

	// Adapter versions are part of the ProviderAdapterV1 contract ("adapter
	// 版本可观测"), so they are exposed here.
	router.Get("/versionz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"adapters": proxy.registry.Versions(),
			"breaker":  proxy.breaker.Snapshot(),
		})
	})

	router.Post("/v1/chat/completions", proxy.ServeChatCompletions)
	router.Get("/v1/models", proxy.ServeModels)

	if options.EnableResponses {
		router.Post("/v1/responses", proxy.ServeResponses)
	} else {
		router.Post("/v1/responses", disabledEndpoint("responses"))
	}
	if options.EnableEmbeddings {
		router.Post("/v1/embeddings", disabledEndpoint("embeddings"))
	} else {
		router.Post("/v1/embeddings", disabledEndpoint("embeddings"))
	}

	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, ensureRequestID(r), &APIError{
			Status: http.StatusNotFound, Code: CodeModelNotFound, Type: TypeInvalidRequest,
			Message: "Unknown endpoint.",
		})
	})
	return router
}

// disabledEndpoint answers 501 for an endpoint that is not implemented yet.
func disabledEndpoint(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, ensureRequestID(r), &APIError{
			Status:  http.StatusNotImplemented,
			Code:    CodeCapabilityUnsupported,
			Type:    TypeInvalidRequest,
			Message: "This endpoint is not enabled on this gateway.",
			Param:   &name,
		})
	}
}

// headerLimitMiddleware rejects an oversized header block before the request
// reaches any handler. http.Server.MaxHeaderBytes is the primary defence; this
// catches proxies that fold headers into a single oversized line.
func headerLimitMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var total int64
			for name, values := range r.Header {
				total += int64(len(name))
				for _, value := range values {
					total += int64(len(value))
				}
			}
			if total > maxBytes {
				writeAPIError(w, ensureRequestID(r), errRequestTooLarge())
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func statusText(ready bool) string {
	if ready {
		return "ready"
	}
	return "not_ready"
}
