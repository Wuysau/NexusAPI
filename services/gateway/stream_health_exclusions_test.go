package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These failures happen after the upstream accepts and begins the response.
// They must retain the unknown execution fact without recording upstream
// health failures merely because the relay closes the provider stream.
func TestStreamHealthExcludesClientAndDownstreamFailures(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, failure := range []string{"client cancellation", "downstream write", "downstream timeout"} {
			t.Run(path+"/"+failure, func(t *testing.T) {
				var calls atomic.Int64
				canceled := make(chan struct{}, 1)
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: healthExclusionUpstream(&calls, canceled)})
				router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				writer := &healthExclusionWriter{ResponseRecorder: httptest.NewRecorder()}
				switch failure {
				case "client cancellation":
					writer.onPartial = cancel
				case "downstream write":
					writer.writeError = io.ErrClosedPipe
				case "downstream timeout":
					writer.writeError = context.DeadlineExceeded
				}
				request := healthExclusionRequest(ctx, path, true)
				router.ServeHTTP(writer, request)
				if !writer.sawPartial {
					t.Fatal("fixture did not reach downstream semantic output")
				}
				assertHealthExclusion(t, h, calls.Load(), canceled)
			})
		}
	}
}

func TestStreamHealthExcludesParentTotalDeadline(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, streaming := range []bool{false, true} {
			t.Run(path+"/"+fmtBool(streaming), func(t *testing.T) {
				var calls atomic.Int64
				canceled := make(chan struct{}, 1)
				limits := defaultLimits()
				limits.TotalDuration = 80 * time.Millisecond
				limits.UpstreamTimeout = time.Second
				limits.IdleTimeout = time.Second
				h := newHarness(t, harnessOptions{EnableUsageV2: true, Limits: limits, UpstreamHandler: healthExclusionUpstream(&calls, canceled)})
				router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
				writer := httptest.NewRecorder()
				router.ServeHTTP(writer, healthExclusionRequest(context.Background(), path, streaming))
				if streaming {
					if writer.Code != http.StatusOK || !strings.Contains(writer.Body.String(), "partial") {
						t.Fatal("fixture did not reach streaming output before its parent deadline")
					}
				} else if writer.Code != http.StatusGatewayTimeout {
					t.Fatalf("parent deadline returned status=%d", writer.Code)
				}
				assertHealthExclusion(t, h, calls.Load(), canceled)
				if h.store.Requests()[0].ErrorCode != CodeUpstreamTimeout {
					t.Fatal("parent deadline lost its terminal timeout classification")
				}
			})
		}
	}
}

func healthExclusionUpstream(calls *atomic.Int64, canceled chan<- struct{}) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}],\"usage\":{\"prompt_tokens\":11}}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			canceled <- struct{}{}
		case <-time.After(3 * time.Second):
		}
	}
}

func healthExclusionRequest(ctx context.Context, path string, streaming bool) *http.Request {
	body := chatBody(chatBodyOptions{Stream: streaming})
	if path == "/v1/responses" {
		body = []byte(fmt.Sprintf(`{"model":%q,"input":"hi","stream":%t}`, testModel, streaming))
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+testAPIKey)
	request.Header.Set("Content-Type", "application/json")
	return request
}

type healthExclusionWriter struct {
	*httptest.ResponseRecorder
	onPartial  func()
	writeError error
	sawPartial bool
}

func (w *healthExclusionWriter) Write(body []byte) (int, error) {
	partial := bytes.Contains(body, []byte("partial"))
	if partial {
		w.sawPartial = true
		if w.writeError != nil {
			return 0, w.writeError
		}
	}
	n, err := w.ResponseRecorder.Write(body)
	if partial && w.onPartial != nil {
		w.onPartial()
	}
	return n, err
}

func assertHealthExclusion(t *testing.T, h *testHarness, calls int64, canceled <-chan struct{}) {
	t.Helper()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("relay failure did not cancel its upstream execution")
	}
	records := h.store.Requests()
	if calls != 1 || h.managed.reserveCount() != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || records[0].Status != string(OutcomeUnknown) {
		t.Fatal("cancellation changed execution count or discarded the unknown terminal fact")
	}
	key := BreakerKey("chan_test_1", testModel)
	if h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 {
		t.Fatal("caller or downstream failure poisoned upstream health")
	}
	h.breaker.mu.Lock()
	entry := h.breaker.entries[key]
	healthSamples, failures := entry.healthSamples, entry.consecutiveFailures
	probes := h.breaker.probes[key]
	h.breaker.mu.Unlock()
	if healthSamples != 0 || failures != 0 || probes != 0 {
		t.Fatalf("excluded failure recorded health or leaked a probe: samples=%d failures=%d probes=%d", healthSamples, failures, probes)
	}
}
