package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

func metricsHandler(registry *Metrics, token string) http.HandlerFunc {
	expected := sha256.Sum256([]byte(token))
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("cache-control", "no-store")
		if len(token) < minProductionTokenLength {
			http.NotFound(w, r)
			return
		}
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			metricsUnauthorized(w)
			return
		}
		scheme, presented, ok := strings.Cut(values[0], " ")
		digest := sha256.Sum256([]byte(presented))
		if !ok || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare(digest[:], expected[:]) != 1 {
			metricsUnauthorized(w)
			return
		}
		w.Header().Set("content-type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = io.WriteString(w, registry.Render())
	}
}

func metricsUnauthorized(w http.ResponseWriter) {
	w.Header().Set("www-authenticate", `Bearer realm="metrics"`)
	http.Error(w, "Metrics authentication required.", http.StatusUnauthorized)
}

// Only the fixed public inference/model API paths contribute. No request data
// becomes a metric name or label, and scrapes, probes and arbitrary paths do
// not change these observations.
func observesHTTPMetrics(path string) bool {
	switch path {
	case "/v1/chat/completions", "/v1/responses", "/v1/embeddings", "/v1/models":
		return true
	default:
		return false
	}
}

func httpMetricsMiddleware(metrics *GatewayMetrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !observesHTTPMetrics(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			started := time.Now()
			metrics.IncRequest()
			wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			wrapped.Tee(&firstBodyObservation{metrics: metrics, started: started})
			defer func() {
				// This is the HTTP outcome. A 200 SSE response can still report
				// an application failure after its headers were committed.
				if wrapped.Status() >= http.StatusBadRequest {
					metrics.IncError()
				}
				metrics.ObserveRequestDuration(time.Since(started).Seconds())
			}()
			next.ServeHTTP(preserveMetricsWriter(wrapped), r)
		})
	}
}

// Tee invokes this only with bytes the underlying writer accepted. Observing
// length retains neither prompts nor response content, including on short or
// failed writes. A header-only flush is not a first response body byte.
type firstBodyObservation struct {
	metrics *GatewayMetrics
	started time.Time
	once    sync.Once
}

func (o *firstBodyObservation) Write(p []byte) (int, error) {
	if len(p) > 0 {
		o.once.Do(func() { o.metrics.ObserveFirstByteDuration(time.Since(o.started).Seconds()) })
	}
	return len(p), nil
}

// chi preserves optional writer interfaces, but its Flush discards FlushError.
// Restore that error path for ResponseController without manufacturing optional
// interfaces unsupported by the proxied writer.
type metricsResponseWriter struct{ middleware.WrapResponseWriter }

func (w *metricsResponseWriter) FlushError() error {
	if w.Status() == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(w.Unwrap()).Flush()
}

func preserveMetricsWriter(w middleware.WrapResponseWriter) http.ResponseWriter {
	base := &metricsResponseWriter{w}
	switch writer := w.(type) {
	case interface {
		http.Flusher
		http.Hijacker
		io.ReaderFrom
	}:
		return struct {
			*metricsResponseWriter
			http.Flusher
			http.Hijacker
			io.ReaderFrom
		}{base, writer, writer, writer}
	case interface {
		http.Flusher
		http.Hijacker
	}:
		return struct {
			*metricsResponseWriter
			http.Flusher
			http.Hijacker
		}{base, writer, writer}
	case interface {
		http.Flusher
		http.Pusher
	}:
		return struct {
			*metricsResponseWriter
			http.Flusher
			http.Pusher
		}{base, writer, writer}
	case http.Flusher:
		return struct {
			*metricsResponseWriter
			http.Flusher
		}{base, writer}
	default:
		return w
	}
}
