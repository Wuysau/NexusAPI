package main

import (
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderCooldownRoutesNextRequestWithoutReplayingCurrentRequest(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int64
			h := newHarness(t, harnessOptions{
				MaxAttempts: 2,
				UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					if calls.Add(1) == 1 {
						w.Header().Set("Retry-After", "10")
						w.WriteHeader(status)
						_, _ = io.WriteString(w, `{"error":{"message":"try later"}}`)
						return
					}
					defaultUpstreamHandler()(w, r)
				},
				ExtraChannelsFn: func(url string) []SnapshotChannel {
					return []SnapshotChannel{{ID: "chan_test_2", ProviderID: "prov_openai", Provider: "openai",
						BaseURL: url, AuthScheme: "bearer", Models: []string{testModel},
						Region: "global", CredentialMode: "managed", CredentialRef: "cred_test",
						Weight: 5, Priority: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}}
				},
			})
			first := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(first)
			if calls.Load() != 1 || first.StatusCode == http.StatusOK {
				t.Fatalf("provider rejection replayed current request: calls=%d status=%d", calls.Load(), first.StatusCode)
			}
			second := h.doChat(chatBody(chatBodyOptions{}), nil)
			body := readAll(second)
			if second.StatusCode != http.StatusOK || calls.Load() != 2 {
				t.Fatalf("next request failed: %d %s, calls=%d", second.StatusCode, body, calls.Load())
			}
			records := h.store.Requests()
			if len(records) != 2 {
				t.Fatalf("expected separate request facts, got %d", len(records))
			}
			for _, record := range records {
				if len(record.Attempts) != 1 {
					t.Fatal("one request was replayed")
				}
				wantChannel := "chan_test_1"
				if record.Status == string(OutcomeCompleted) {
					wantChannel = "chan_test_2"
				}
				if record.Attempts[0].ChannelID != wantChannel {
					t.Fatalf("attempt route=%s want=%s", record.Attempts[0].ChannelID, wantChannel)
				}
			}
		})
	}
}

func TestProviderClientErrorsDoNotOpenSharedCircuit(t *testing.T) {
	for _, body := range []string{`{"error":{"message":"invalid parameter"}}`, `{"error":{"code":"content_policy"}}`} {
		t.Run(body, func(t *testing.T) {
			var calls atomic.Int64
			h := newHarness(t, harnessOptions{MaxAttempts: 1, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, body)
			}})
			for i := 0; i < 5; i++ {
				resp := h.doChat(chatBody(chatBodyOptions{}), nil)
				_ = readAll(resp)
			}
			key := BreakerKey("chan_test_1", testModel)
			if calls.Load() != 5 || h.breaker.State(key) != BreakerClosed || h.breaker.FailureRate(key) != 0 {
				t.Fatalf("client error poisoned upstream health: calls=%d state=%s failureRate=%f", calls.Load(), h.breaker.State(key), h.breaker.FailureRate(key))
			}
		})
	}
}

func TestProviderRateLimitWithoutHintUsesConfiguredCooldown(t *testing.T) {
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "-1")
		w.WriteHeader(http.StatusTooManyRequests)
	}})
	now := time.Now()
	h.breaker.SetClock(func() time.Time { return now })
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	key := BreakerKey("chan_test_1", testModel)
	now = now.Add(59 * time.Second)
	if h.breaker.Available(key) {
		t.Fatal("invalid hint replaced configured one-minute cooldown")
	}
	now = now.Add(time.Second)
	if !h.breaker.Allow(key) {
		t.Fatal("configured cooldown failed to expire")
	}
}
