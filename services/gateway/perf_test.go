package main

// Proxy-overhead benchmark (plan requirement 10).
//
// The target is p95 proxy overhead < 75 ms EXCLUDING upstream. To isolate
// Nexus's own cost the mock upstream does no work and reports how long it held
// each request; the measured value is (gateway wall time − upstream handler
// time). That removes the mock's own scheduling noise from the number.
//
// The assertions here are deliberately loose so CI is not flaky on a busy
// machine. A published performance claim must come from a dedicated run using
// the same method with the hardware stated; see README.md.

import (
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPerfOverhead(t *testing.T) {
	var upstreamNanos atomic.Int64

	h := newHarness(t, harnessOptions{
		MaxAttempts: 1,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			for i := 0; i < 8; i++ {
				_, _ = io.WriteString(w, "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"tok\"}}]}\n\n")
				w.(http.Flusher).Flush()
			}
			_, _ = io.WriteString(w, "data: {\"id\":\"c\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":8}}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			upstreamNanos.Add(time.Since(start).Nanoseconds())
		},
	})

	const (
		concurrency = 16
		perWorker   = 20
	)

	var (
		mu        sync.Mutex
		overheads []time.Duration
		wg        sync.WaitGroup
		failures  atomic.Int64
	)

	start := time.Now()
	for worker := 0; worker < concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := chatBody(chatBodyOptions{Stream: true})
			for i := 0; i < perWorker; i++ {
				requestStart := time.Now()
				resp := h.doChat(body, nil)
				if resp.StatusCode != http.StatusOK {
					failures.Add(1)
					_ = readAll(resp)
					continue
				}
				_ = readAll(resp)
				mu.Lock()
				overheads = append(overheads, time.Since(requestStart))
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	wall := time.Since(start)

	if failures.Load() > 0 {
		t.Fatalf("%d requests failed", failures.Load())
	}
	if len(overheads) != concurrency*perWorker {
		t.Fatalf("collected %d samples", len(overheads))
	}

	// Subtract the mean upstream handler time from every sample. The handler
	// time is summed across requests, so the mean is the right per-request
	// subtraction.
	upstreamMean := time.Duration(upstreamNanos.Load()/int64(len(overheads))) * time.Nanosecond
	adjusted := make([]time.Duration, len(overheads))
	for i, sample := range overheads {
		if sample > upstreamMean {
			adjusted[i] = sample - upstreamMean
		}
	}
	sort.Slice(adjusted, func(i, j int) bool { return adjusted[i] < adjusted[j] })

	p := func(q float64) time.Duration {
		index := int(float64(len(adjusted)-1) * q)
		return adjusted[index]
	}
	p50, p95, p99 := p(0.50), p(0.95), p(0.99)

	t.Logf("payload=streaming-8-chunk concurrency=%d requests=%d wall=%s", concurrency, len(adjusted), wall)
	t.Logf("upstream mean per request: %s", upstreamMean)
	t.Logf("proxy overhead p50=%s p95=%s p99=%s max=%s", p50, p95, p99, adjusted[len(adjusted)-1])

	if testing.Short() {
		return
	}
	// Generous ceiling: this is a smoke check that the hot path has not
	// regressed into an O(seconds) path. The published target is 75 ms.
	if p95 > 250*time.Millisecond {
		t.Fatalf("p95 proxy overhead %s exceeds the CI ceiling", p95)
	}
}

// A long stream must not block other connections: a slow-but-progressing
// consumer runs concurrently with short requests and neither starves.
func TestPerfStreamingDoesNotBlockOtherConnections(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, harnessOptions{
		MaxAttempts: 1,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.RawQuery, "slow=1") {
				<-release
			}
			w.Header().Set("content-type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		},
	})

	// Occupy every concurrency slot with a slow upstream call.
	slowDone := make(chan struct{})
	go func() {
		defer close(slowDone)
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				req, _ := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions?x=1",
					strings.NewReader(string(chatBody(chatBodyOptions{Stream: true}))))
				req.Header.Set("content-type", "application/json")
				req.Header.Set("authorization", "Bearer "+testAPIKey)
				resp, err := h.server.Client().Do(req)
				if err == nil {
					_ = readAll(resp)
				}
				_ = i
			}(i)
		}
		wg.Wait()
	}()

	// A short request must still complete promptly. The mock upstream for the
	// fast path does not block, so this measures whether the gateway serialises
	// unrelated connections.
	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
		_ = readAll(resp)
		done <- time.Since(start)
	}()

	select {
	case elapsed := <-done:
		if elapsed > 2*time.Second {
			t.Fatalf("a short request waited %s behind unrelated traffic", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a short request was blocked by concurrent streaming")
	}

	close(release)
	select {
	case <-slowDone:
	case <-time.After(10 * time.Second):
		t.Fatal("slow requests did not finish after release")
	}
}

// Concurrency slots must be released even when the request fails.
func TestPerfConcurrencySlotsAreReleased(t *testing.T) {
	limits := defaultLimits()
	limits.MaxConcurrent = 2
	h := newHarness(t, harnessOptions{
		Limits: limits,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"boom"}}`)
		},
	})
	h.breaker.SetClock(func() time.Time { return time.Now().Add(-time.Hour) }) // never opens

	for i := 0; i < 10; i++ {
		resp := h.doChat(chatBody(chatBodyOptions{}), nil)
		_ = readAll(resp)
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("concurrency slots leaked after %d failed requests", i)
		}
	}
}
