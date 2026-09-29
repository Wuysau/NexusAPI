package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestStreamFailuresOpenBreakerForLaterRequests(t *testing.T) {
	for _, mode := range []string{"truncated", "malformed", "idle", "attempt_timeout"} {
		for _, streaming := range []bool{false, true} {
			t.Run(mode+"/"+fmtBool(streaming), func(t *testing.T) {
				var primaryCalls, fallbackCalls atomic.Int64
				fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					fallbackCalls.Add(1)
					defaultUpstreamHandler()(w, r)
				}))
				t.Cleanup(fallback.Close)
				limits := defaultLimits()
				limits.IdleTimeout = 35 * time.Millisecond
				if mode == "attempt_timeout" {
					limits.UpstreamTimeout = 35 * time.Millisecond
					limits.IdleTimeout = time.Second
				}
				h := newHarness(t, harnessOptions{EnableUsageV2: true, Limits: limits, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					primaryCalls.Add(1)
					_, _ = io.Copy(io.Discard, r.Body)
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}],\"usage\":{\"prompt_tokens\":11}}\n\n")
					w.(http.Flusher).Flush()
					switch mode {
					case "malformed":
						_, _ = io.WriteString(w, "data: {not-json}\n\n")
					case "idle", "attempt_timeout":
						select {
						case <-r.Context().Done():
						case <-time.After(time.Second):
						}
					}
				}, ExtraChannels: []SnapshotChannel{{
					ID: "stream-fallback", ConnectionID: "connection-fallback", ProviderID: "prov_openai", Provider: "openai",
					BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global",
					CredentialMode: "managed", CredentialRef: "cred_fallback", Priority: 1, Enabled: true,
				}}})
				key := BreakerKey("chan_test_1", testModel)
				for i := 1; i <= 3; i++ {
					response := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil)
					_ = readAll(response)
					if primaryCalls.Load() != int64(i) || fallbackCalls.Load() != 0 {
						t.Fatal("partial execution was replayed to a fallback")
					}
					records := h.store.Requests()
					if len(records) != i || h.store.OutboxCount(testTenantID) != i {
						t.Fatal("stream failure changed terminal cardinality")
					}
					for _, record := range records {
						if record.Status != string(OutcomeUnknown) || len(record.Attempts) != 1 || record.Attempts[0].ChannelID != "chan_test_1" {
							t.Fatal("stream failure lost its sole execution attribution")
						}
						if e := record.EventV2; e == nil || e.Usage.InputTokens == nil || *e.Usage.InputTokens != 11 || e.Usage.OutputTokens != nil || e.Usage.TotalTokens != nil {
							t.Fatal("health tracking changed observed or unknown usage")
						}
					}
					if i < 3 && h.breaker.State(key) != BreakerClosed {
						t.Fatal("one stream failure was counted more than once")
					}
				}
				if h.breaker.State(key) != BreakerOpen || h.breaker.FailureRate(key) != 1 {
					t.Fatalf("failed stream stayed routable: state=%s rate=%f", h.breaker.State(key), h.breaker.FailureRate(key))
				}
				response := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil)
				_ = readAll(response)
				if response.StatusCode != 200 || primaryCalls.Load() != 3 || fallbackCalls.Load() != 1 || len(h.store.Requests()) != 4 {
					t.Fatal("later request did not use its eligible healthy fallback")
				}
				if h.breaker.State(BreakerKey("stream-fallback", testModel)) != BreakerClosed || h.breaker.State(BreakerKey("chan_test_1", "other-model")) != BreakerClosed {
					t.Fatal("stream failure escaped its channel/model health scope")
				}
			})
		}
	}
}
