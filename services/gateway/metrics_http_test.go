package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func metricsTestRouter(t *testing.T, token string) http.Handler {
	t.Helper()
	h := newHarness(t, harnessOptions{})
	h.proxy.env.MetricsToken = token
	return NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
}

func serveMetricsRequest(handler http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func metricSample(t *testing.T, body, name string) float64 {
	t.Helper()
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, name+" ") {
			value, err := strconv.ParseFloat(strings.TrimPrefix(line, name+" "), 64)
			if err != nil {
				t.Fatal(err)
			}
			return value
		}
	}
	t.Fatalf("missing metric %s in %s", name, body)
	return 0
}

func TestMetricsEndpointRequiresDedicatedTokenAndExcludesScrapes(t *testing.T) {
	token := strings.Repeat("m", 32)
	handler := metricsTestRouter(t, token)
	for _, auth := range []string{"", "Bearer wrong-metrics-fixture", "Basic " + token, "Bearer " + token + "extra"} {
		r := httptest.NewRequest("GET", "/metrics?token="+token, nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 401 || w.Header().Get("cache-control") != "no-store" || strings.Contains(w.Body.String(), token) || strings.Contains(w.Body.String(), "nexus_requests") {
			t.Fatalf("metrics authentication failed: %d %s", w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "/metrics", nil)
	r.Header.Add("Authorization", "Bearer "+token)
	r.Header.Add("Authorization", "Bearer other-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("ambiguous duplicate authorization headers accepted")
	}
	for _, path := range []string{"/metrics", "/healthz", "/readyz", "/versionz", "/unknown-private-model"} {
		_ = serveMetricsRequest(handler, "GET", path, "", token)
	}
	scrape := serveMetricsRequest(handler, "GET", "/metrics", "", token)
	if scrape.Code != 200 || scrape.Header().Get("content-type") != "text/plain; version=0.0.4; charset=utf-8" || scrape.Header().Get("cache-control") != "no-store" {
		t.Fatalf("invalid exposition response: %d %v", scrape.Code, scrape.Header())
	}
	if metricSample(t, scrape.Body.String(), "nexus_requests_total") != 0 || metricSample(t, scrape.Body.String(), "nexus_request_duration_seconds_count") != 0 {
		t.Fatal("scrapes, health probes or unknown routes counted as inference")
	}
	for _, disabled := range []string{"", "weak-token"} {
		w := serveMetricsRequest(metricsTestRouter(t, disabled), "GET", "/metrics", "", disabled)
		if w.Code != 404 {
			t.Fatalf("disabled/invalid metrics endpoint was exposed: %d", w.Code)
		}
	}
}

func TestHTTPMetricsObserveRealEndpointsWithoutSensitiveLabels(t *testing.T) {
	token := strings.Repeat("m", 32)
	handler := metricsTestRouter(t, token)
	for _, request := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/v1/models", "", 200},
		{"POST", "/v1/chat/completions", `{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"private-prompt-fixture"}]}`, 200},
		{"POST", "/v1/responses", `{"model":"gpt-4o","input":"private-prompt-fixture"}`, 200},
		{"POST", "/v1/embeddings", `{}`, 501},
		{"POST", "/v1/chat/completions", `{`, 400},
	} {
		w := serveMetricsRequest(handler, request.method, request.path, request.body, testAPIKey)
		if w.Code != request.status {
			t.Fatalf("%s status=%d body=%s", request.path, w.Code, w.Body.String())
		}
	}
	body := serveMetricsRequest(handler, "GET", "/metrics", "", token).Body.String()
	for name, want := range map[string]float64{"nexus_requests_total": 5, "nexus_request_errors_total": 2, "nexus_request_duration_seconds_count": 5, "nexus_first_byte_duration_seconds_count": 5} {
		if got := metricSample(t, body, name); got != want {
			t.Fatalf("%s=%v want=%v", name, got, want)
		}
	}
	if metricSample(t, body, "nexus_request_duration_seconds_sum") <= 0 || metricSample(t, body, "nexus_first_byte_duration_seconds_sum") <= 0 {
		t.Fatal("request and first-byte latency were not observed")
	}
	for _, private := range []string{token, testAPIKey, testTenantID, testModel, "private-prompt-fixture", "/v1/", "nexus_provider_errors", "nexus_outbox", "nexus_fallback", "nexus_kms", "nexus_snapshot"} {
		if strings.Contains(body, private) {
			t.Fatalf("exposition contains private/unobserved field %q", private)
		}
	}
	if !strings.Contains(body, `nexus_request_duration_seconds_bucket{le="+Inf"} 5`) {
		t.Fatal("Prometheus cumulative histogram buckets missing")
	}
}

func TestHTTPMetricsStreamingFlushAndCancellation(t *testing.T) {
	registry := NewMetrics()
	metrics := NewGatewayMetrics(registry)
	returned := make(chan struct{})
	handler := httpMetricsMiddleware(metrics)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: partial\n\n")
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Error(err)
			return
		}
		<-r.Context().Done()
	}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		close(returned)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/v1/chat/completions", nil)
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "data: partial\n" {
		t.Fatalf("first chunk did not flush: %q %v", line, err)
	}
	cancel()
	_ = response.Body.Close()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("metrics wrapper blocked request cancellation")
	}
	body := registry.Render()
	if metricSample(t, body, "nexus_request_duration_seconds_count") != 1 || metricSample(t, body, "nexus_first_byte_duration_seconds_count") != 1 || metricSample(t, body, "nexus_request_errors_total") != 0 {
		t.Fatalf("partial 200 stream must retain HTTP semantics: %s", body)
	}
}

type metricsCapabilityWriter struct {
	*httptest.ResponseRecorder
	flushErr      error
	writeDeadline time.Time
	hijacked      bool
}

func (w *metricsCapabilityWriter) FlushError() error { return w.flushErr }
func (w *metricsCapabilityWriter) SetWriteDeadline(deadline time.Time) error {
	w.writeDeadline = deadline
	return nil
}
func (w *metricsCapabilityWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	return nil, nil, http.ErrNotSupported
}
func (w *metricsCapabilityWriter) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(w.ResponseRecorder, r)
}

func TestHTTPMetricsPreserveWriterCapabilitiesAndFlushErrors(t *testing.T) {
	registry := NewMetrics()
	metrics := NewGatewayMetrics(registry)
	flushErr := errors.New("flush fixture")
	underlying := &metricsCapabilityWriter{ResponseRecorder: httptest.NewRecorder(), flushErr: flushErr}
	deadline := time.Now().Add(time.Second)
	handler := httpMetricsMiddleware(metrics)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Fatal("Flusher lost")
		}
		if _, ok := w.(io.ReaderFrom); !ok {
			t.Fatal("ReaderFrom lost")
		}
		if _, _, err := w.(http.Hijacker).Hijack(); !errors.Is(err, http.ErrNotSupported) {
			t.Fatal("Hijacker not delegated")
		}
		controller := http.NewResponseController(w)
		if err := controller.SetWriteDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		if err := controller.Flush(); !errors.Is(err, flushErr) {
			t.Fatalf("flush error swallowed: %v", err)
		}
		if metricSample(t, registry.Render(), "nexus_first_byte_duration_seconds_count") != 0 {
			t.Fatal("headers/flush counted as a body byte")
		}
		_, _ = io.Copy(w, struct{ io.Reader }{strings.NewReader("first body")})
	}))
	handler.ServeHTTP(underlying, httptest.NewRequest("POST", "/v1/chat/completions", nil))
	if !underlying.hijacked || !underlying.writeDeadline.Equal(deadline) || underlying.Body.String() != "first body" || metricSample(t, registry.Render(), "nexus_first_byte_duration_seconds_count") != 1 {
		t.Fatal("writer capabilities or copied body observation changed")
	}
}

type metricsFailedWriter struct{ header http.Header }

func (w *metricsFailedWriter) Header() http.Header { return w.header }
func (w *metricsFailedWriter) WriteHeader(int)     {}
func (w *metricsFailedWriter) Write([]byte) (int, error) {
	return 0, io.ErrClosedPipe
}

func TestHTTPMetricsDoNotObserveFailedBodyWritesOrInventInterfaces(t *testing.T) {
	registry := NewMetrics()
	handler := httpMetricsMiddleware(NewGatewayMetrics(registry))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			t.Fatal("wrapper invented Flusher")
		}
		if _, ok := w.(http.Hijacker); ok {
			t.Fatal("wrapper invented Hijacker")
		}
		if err := http.NewResponseController(w).Flush(); !errors.Is(err, http.ErrNotSupported) {
			t.Fatalf("unsupported flush changed: %v", err)
		}
		_, _ = w.Write([]byte("private failed body"))
	}))
	handler.ServeHTTP(&metricsFailedWriter{header: make(http.Header)}, httptest.NewRequest("POST", "/v1/chat/completions", nil))
	if metricSample(t, registry.Render(), "nexus_first_byte_duration_seconds_count") != 0 {
		t.Fatal("failed body write counted as delivered first byte")
	}
}

type metricsHTTP2Writer struct {
	*httptest.ResponseRecorder
	pushed string
}

func (w *metricsHTTP2Writer) Push(target string, _ *http.PushOptions) error {
	w.pushed = target
	return nil
}

func TestHTTPMetricsPreserveHTTP2PushAndFlush(t *testing.T) {
	registry := NewMetrics()
	underlying := &metricsHTTP2Writer{ResponseRecorder: httptest.NewRecorder()}
	handler := httpMetricsMiddleware(NewGatewayMetrics(registry))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pusher, ok := w.(http.Pusher)
		if !ok {
			t.Fatal("HTTP/2 Pusher lost")
		}
		if err := pusher.Push("/fixture", nil); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(w, "data: body\n\n")
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Fatal(err)
		}
	}))
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	r.ProtoMajor = 2
	handler.ServeHTTP(underlying, r)
	if underlying.pushed != "/fixture" || !underlying.Flushed {
		t.Fatal("HTTP/2 writer capabilities not forwarded")
	}
}

func TestHTTPMetricsConcurrentRequestsAndSnapshots(t *testing.T) {
	registry := NewMetrics()
	handler := httpMetricsMiddleware(NewGatewayMetrics(registry))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	var group sync.WaitGroup
	for i := 0; i < 50; i++ {
		group.Add(2)
		go func() {
			defer group.Done()
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/models", nil))
		}()
		go func() { defer group.Done(); _ = registry.Render() }()
	}
	group.Wait()
	body := registry.Render()
	if metricSample(t, body, "nexus_requests_total") != 50 || metricSample(t, body, "nexus_request_duration_seconds_count") != 50 || metricSample(t, body, "nexus_first_byte_duration_seconds_count") != 50 {
		t.Fatalf("concurrent observations lost: %s", body)
	}
}
