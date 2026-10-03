package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRateLimitedRequestsExplainTemporaryWaitWithoutDispatch(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, bucket := range []string{"requests", "tokens"} {
			t.Run(endpoint+"/"+bucket, func(t *testing.T) {
				limits := defaultLimits()
				if bucket == "requests" {
					limits.RequestsPerMinute = 10 // Development fallback admits one per minute.
				} else {
					limits.TokensPerMinute = 500 // The reduced bucket can fit one request, not two.
				}
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					defaultUpstreamHandler()(w, r)
				}})
				router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
				payload := string(chatBody(chatBodyOptions{MaxTokens: 10}))
				if endpoint == "/v1/responses" {
					payload = `{"model":"gpt-4o","input":"hi","max_output_tokens":10}`
				}
				call := func() *httptest.ResponseRecorder {
					req := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(payload))
					req.Header.Set("Authorization", "Bearer "+testAPIKey)
					w := httptest.NewRecorder()
					router.ServeHTTP(w, req)
					return w
				}
				if first := call(); first.Code != http.StatusOK || first.Header().Get("Retry-After") != "" {
					t.Fatalf("first request did not pass rate admission: %d", first.Code)
				}
				second := call()
				seconds, err := strconv.Atoi(second.Header().Get("Retry-After"))
				if second.Code != http.StatusTooManyRequests || err != nil || seconds < 1 || seconds > 60 {
					t.Fatalf("temporary rate rejection omitted a bounded wait: status=%d retry-after=%q", second.Code, second.Header().Get("Retry-After"))
				}
				if !strings.Contains(second.Body.String(), CodeRateLimitExceeded) || calls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 {
					t.Fatal("rate rejection changed public errors or performed billable work")
				}
			})
		}
	}
}

func TestRequestExceedingTokenBucketCapacityHasNoRetryPromise(t *testing.T) {
	limits := defaultLimits()
	limits.TokensPerMinute = 10
	h := newHarness(t, harnessOptions{Limits: limits})
	response := h.doChat(chatBody(chatBodyOptions{MaxTokens: 10}), nil)
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusTooManyRequests || response.Header.Get("Retry-After") != "" || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 {
		t.Fatal("a request exceeding capacity was admitted or promised recovery by waiting")
	}
}

func TestRateRetryHintRoundsUpWithoutOverflow(t *testing.T) {
	for _, tc := range []struct {
		wait time.Duration
		want string
	}{
		{0, ""}, {-time.Second, ""}, {time.Nanosecond, "1"},
		{time.Second, "1"}, {time.Second + time.Nanosecond, "2"},
		{60 * time.Second, "60"}, {time.Duration(1<<63 - 1), "9223372037"},
	} {
		t.Run(tc.wait.String(), func(t *testing.T) {
			w := httptest.NewRecorder()
			writeRateLimitError(w, "fixture-request", tc.wait)
			if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != tc.want {
				t.Fatalf("wait %s: status=%d Retry-After=%q, want %q", tc.wait, w.Code, w.Header().Get("Retry-After"), tc.want)
			}
		})
	}
}
