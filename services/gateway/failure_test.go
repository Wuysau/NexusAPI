package main

// Failure and degradation scenarios required by the plan:
// 429/5xx failover, timeout, circuit breaker, Redis down, control plane down,
// unknown terminal state, disconnect-cancel, slow client, goroutine release.

import (
	"context"
	"io"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ── Circuit breaker ───────────────────────────────────────────────────

func TestCircuitBreakerOpensAndStopsCallingTheUpstream(t *testing.T) {
	var calls atomic.Int64
	h := newHarness(t, harnessOptions{
		MaxAttempts: 1,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"boom"}}`)
		},
	})

	// FailureThreshold in the harness is 3.
	for i := 0; i < 3; i++ {
		resp := h.doChat(chatBody(chatBodyOptions{}), nil)
		if resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("request %d status = %d (body %s)", i, resp.StatusCode, readAll(resp))
		}
		_ = readAll(resp)
	}
	if got := h.breaker.State(BreakerKey("chan_test_1", testModel)); got != BreakerOpen {
		t.Fatalf("breaker state = %q want open", got)
	}
	callsBefore := calls.Load()

	// The open breaker is a HARD filter: no candidate survives, and crucially
	// the upstream is not called again.
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readAll(resp))
	}
	if code := errorCode(t, resp); code != CodeNoHealthyUpstream {
		t.Fatalf("code = %q", code)
	}
	if calls.Load() != callsBefore {
		t.Fatalf("an open breaker must not call upstream again: %d -> %d", callsBefore, calls.Load())
	}
}

// ── Idle / timeout ────────────────────────────────────────────────────

func TestStalledUpstreamEndsStreamAtIdleTimeout(t *testing.T) {
	upstreamCancelled := make(chan struct{})
	h := newHarness(t, harnessOptions{
		Limits: func() Limits {
			l := defaultLimits()
			l.IdleTimeout = 300 * time.Millisecond
			l.TotalDuration = 10 * time.Second
			return l
		}(),
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"par\"},\"finish_reason\":null}]}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(upstreamCancelled)
		},
	})

	done := make(chan int, 1)
	go func() {
		resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
		_ = readAll(resp)
		done <- resp.StatusCode
	}()

	select {
	case status := <-done:
		if status != http.StatusOK {
			t.Fatalf("streaming response had already started, status = %d", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a stalled upstream must be cut off by the idle timeout")
	}

	select {
	case <-upstreamCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the idle timeout must cancel the upstream call")
	}

	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("records = %d", len(records))
	}
	if records[0].Status != string(OutcomeUnknown) {
		t.Fatalf("a stalled stream is an unknown terminal state, got %q", records[0].Status)
	}
	if !records[0].Event.Usage.Estimated {
		t.Fatal("unknown outcomes must be marked estimated")
	}
}

// ── Disconnect / cancellation ─────────────────────────────────────────

func TestClientDisconnectCancelsUpstreamAndStillRecordsUsage(t *testing.T) {
	testClientDisconnect(t, false)
}
func TestV2ClientDisconnectPreservesFrozenUnknownFact(t *testing.T) {
	testClientDisconnect(t, true)
}
func testClientDisconnect(t *testing.T, enableV2 bool) {
	upstreamCancelled := make(chan struct{})
	firstChunkSent := make(chan struct{})
	mode := ""
	if enableV2 {
		mode = "byok"
	}
	h := newHarness(t, harnessOptions{
		EnableUsageV2:  enableV2,
		CredentialMode: mode,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n")
			w.(http.Flusher).Flush()
			close(firstChunkSent)
			<-r.Context().Done()
			close(upstreamCancelled)
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(string(chatBody(chatBodyOptions{Stream: true}))))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+testAPIKey)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	buffer := make([]byte, 64)
	_, _ = resp.Body.Read(buffer)

	select {
	case <-firstChunkSent:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never sent its first chunk")
	}
	cancel() // client goes away
	_ = resp.Body.Close()

	select {
	case <-upstreamCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("client disconnect must cancel the upstream call immediately")
	}

	// The usage observed before the disconnect must still be recorded, on a
	// context that survives the disconnect.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(h.store.Requests()) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("expected the disconnect to still produce a terminal record, got %d", len(records))
	}
	if records[0].Status != string(OutcomeUnknown) {
		t.Fatalf("status = %q", records[0].Status)
	}
	if !enableV2 && records[0].InputTokens == 0 && records[0].OutputTokens == 0 {
		t.Fatal("an estimated usage must be recorded for the aborted stream")
	}
	if enableV2 {
		e := records[0].EventV2
		if records[0].InputTokens != 0 || records[0].OutputTokens != 0 {
			t.Fatal("unknown v2 observations must use zero only in compatibility columns")
		}
		if e == nil || e.Status != "unknown" || e.Usage.InputTokens != nil || e.Attribution.ProjectId == nil || len(h.store.CapturedRequests()) != 1 {
			t.Fatal("disconnect lost frozen unknown usage")
		}
	}
}

// ── Slow client ───────────────────────────────────────────────────────

// A client that stops reading must be disconnected rather than buffered without
// bound. The gateway bounds it with a write deadline and then cancels upstream.
func TestSlowClientIsDisconnected(t *testing.T) {
	upstreamCancelled := make(chan struct{})
	h := newHarness(t, harnessOptions{
		Limits: func() Limits {
			l := defaultLimits()
			l.IdleTimeout = 250 * time.Millisecond
			l.TotalDuration = 20 * time.Second
			return l
		}(),
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			chunk := strings.Repeat("x", 16*1024)
			for i := 0; i < 512; i++ { // ~8 MiB, far beyond any socket buffer
				if _, err := io.WriteString(w, "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\""+chunk+"\"}}]}\n\n"); err != nil {
					break
				}
				w.(http.Flusher).Flush()
			}
			<-r.Context().Done()
			close(upstreamCancelled)
		},
	})

	address := strings.TrimPrefix(h.server.URL, "http://")
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	request := "POST /v1/chat/completions HTTP/1.1\r\nHost: " + address +
		"\r\nAuthorization: Bearer " + testAPIKey +
		"\r\nContent-Type: application/json\r\nContent-Length: " +
		itoa(len(chatBody(chatBodyOptions{Stream: true}))) + "\r\n\r\n" + string(chatBody(chatBodyOptions{Stream: true}))
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write request: %v", err)
	}
	// Read a little, then stop reading entirely.
	buffer := make([]byte, 128)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Read(buffer)

	select {
	case <-upstreamCancelled:
	case <-time.After(15 * time.Second):
		t.Fatal("a client that stops reading must be disconnected and the upstream cancelled")
	}
}

// ── Redis degradation ─────────────────────────────────────────────────

func TestRedisDownDegradesToConservativeLocalLimits(t *testing.T) {
	// An unreachable Redis must not fail the request path; it must degrade.
	logger := discardLogger()
	limiter, err := NewLimiter("redis://127.0.0.1:6399/0", logger)
	if err != nil {
		t.Fatalf("limiter: %v", err)
	}
	defer func() { _ = limiter.Close() }()

	limits := defaultLimits()
	limits.RequestsPerMinute = 10 // local fallback = 10/10 = 1 per minute
	// The token bucket is left generous so this test isolates the request
	// bucket; a shrunken token ceiling is covered by the unit tests.
	limits.TokensPerMinute = 10_000_000
	h := newHarness(t, harnessOptions{Limiter: limiter, Limits: limits})

	first := h.doChat(chatBody(chatBodyOptions{}), nil)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first status = %d", first.StatusCode)
	}
	_ = readAll(first)
	if !limiter.Degraded() {
		t.Fatal("an unreachable Redis must be reported as degraded")
	}

	second := h.doChat(chatBody(chatBodyOptions{}), nil)
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("the conservative local limit must still apply, got %d", second.StatusCode)
	}
	if code := errorCode(t, second); code != CodeRateLimitExceeded {
		t.Fatalf("code = %q", code)
	}
}

// ── Control plane down ────────────────────────────────────────────────

func TestExpiredSnapshotFailsClosedForManagedTraffic(t *testing.T) {
	clock := &testClock{now: time.Now()}
	h := newHarness(t, harnessOptions{
		Clock:          clock.Now,
		ExpiresIn:      time.Minute,
		MaxAttempts:    1,
		CredentialMode: "managed",
	})
	// Warm the cache, then expire it and take the control plane away.
	if resp := h.doChat(chatBody(chatBodyOptions{}), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("warmup status = %d", resp.StatusCode)
	} else {
		_ = readAll(resp)
	}
	clock.Advance(2 * time.Minute)
	h.source.setFail(true)

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("managed traffic must fail closed on an expired snapshot, got %d (%s)", resp.StatusCode, readAll(resp))
	}
	if code := errorCode(t, resp); code != CodeSnapshotExpired {
		t.Fatalf("code = %q", code)
	}
}

func TestExpiredSnapshotLetsByokContinueWhenPolicyAllows(t *testing.T) {
	clock := &testClock{now: time.Now()}
	h := newHarness(t, harnessOptions{
		Clock:             clock.Now,
		ExpiresIn:         time.Minute,
		PlatformExpiresIn: time.Hour,
		CredentialMode:    "byok",
		SnapshotLimits:    SnapshotLimits{ByokContinueWhenStale: true},
	})
	if resp := h.doChat(chatBody(chatBodyOptions{}), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("warmup status = %d", resp.StatusCode)
	} else {
		_ = readAll(resp)
	}
	clock.Advance(2 * time.Minute)
	h.source.setFail(true)

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("BYOK must continue under an explicit tenant policy, got %d (%s)", resp.StatusCode, readAll(resp))
	}
	_ = readAll(resp)
	records := h.store.Requests()
	if len(records) != 2 {
		t.Fatalf("records = %d", len(records))
	}
	for _, rec := range records {
		if rec.ChannelKind != "byok" {
			t.Fatalf("channel kind = %q", rec.ChannelKind)
		}
	}
}

func TestExpiredSnapshotRefusesByokWithoutPolicy(t *testing.T) {
	clock := &testClock{now: time.Now()}
	h := newHarness(t, harnessOptions{
		Clock:             clock.Now,
		ExpiresIn:         time.Minute,
		PlatformExpiresIn: time.Hour,
		CredentialMode:    "byok",
	})
	if resp := h.doChat(chatBody(chatBodyOptions{}), nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("warmup status = %d", resp.StatusCode)
	} else {
		_ = readAll(resp)
	}
	clock.Advance(2 * time.Minute)
	h.source.setFail(true)

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("BYOK without an explicit stale policy must also fail closed, got %d", resp.StatusCode)
	}
}

// ── Budget / storage degradation ──────────────────────────────────────

func TestManagedFailsClosedWhenReservationIsUnavailable(t *testing.T) {
	h := newHarness(t, harnessOptions{MaxAttempts: 1})
	h.managed.reserveErr = ErrBudgetServiceUnavailable

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("managed traffic must fail closed without a hold, got %d (%s)", resp.StatusCode, readAll(resp))
	}
	if len(h.store.Requests()) != 0 {
		t.Fatal("a request refused before dispatch must not produce a terminal record")
	}
}

func TestBudgetExceededIsReportedAs429(t *testing.T) {
	h := newHarness(t, harnessOptions{MaxAttempts: 1})
	h.managed.reserveErr = ErrBudgetExceeded

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if code := errorCode(t, resp); code != CodeBudgetExceeded {
		t.Fatalf("code = %q", code)
	}
}

func TestByokSkipsReservation(t *testing.T) {
	h := newHarness(t, harnessOptions{CredentialMode: "byok"})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s)", resp.StatusCode, readAll(resp))
	}
	_ = readAll(resp)
	if h.managed.reserveCount() != 0 {
		t.Fatal("BYOK traffic must not take a Nexus budget hold")
	}
	if h.byok.reserveCount() != 0 {
		t.Fatal("BYOK traffic must not reserve at all")
	}
}

func TestUnhealthyOutboxFailsManagedClosedButAllowsByok(t *testing.T) {
	t.Run("managed", func(t *testing.T) {
		h := newHarness(t, harnessOptions{})
		h.store.SetHealthy(false)
		resp := h.doChat(chatBody(chatBodyOptions{}), nil)
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (%s)", resp.StatusCode, readAll(resp))
		}
		if code := errorCode(t, resp); code != CodeStorageUnavailable {
			t.Fatalf("code = %q", code)
		}
		if h.managed.reserveCount() != 0 {
			t.Fatal("no budget may be held once storage is known to be unusable")
		}
	})

	t.Run("byok", func(t *testing.T) {
		h := newHarness(t, harnessOptions{CredentialMode: "byok"})
		h.store.SetHealthy(false)
		resp := h.doChat(chatBody(chatBodyOptions{}), nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("BYOK must continue while storage is degraded, got %d", resp.StatusCode)
		}
		_ = readAll(resp)
	})
}

// A non-streaming response is written only after the usage fact is durable, so
// an uncommittable outbox can still be reported instead of silently dropping
// the billing fact.
func TestNonStreamingWriteIsGatedOnPersist(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.store.SetHealthy(true)
	h.store.FailNext()

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d (%s)", resp.StatusCode, readAll(resp))
	}
}

// ── Goroutine / connection release ────────────────────────────────────

func TestCancelledRequestsReleaseGoroutines(t *testing.T) {
	h := newHarness(t, harnessOptions{
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		},
	})

	// Let the pool settle so the baseline is stable.
	runtime.GC()
	time.Sleep(100 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	for i := 0; i < 25; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.server.URL+"/v1/chat/completions",
			strings.NewReader(string(chatBody(chatBodyOptions{Stream: true}))))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("authorization", "Bearer "+testAPIKey)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			t.Fatalf("do %d: %v", i, err)
		}
		buffer := make([]byte, 32)
		_, _ = resp.Body.Read(buffer)
		cancel()
		_ = resp.Body.Close()
	}

	// Every cancelled request must release its goroutines and connections.
	deadline := time.Now().Add(10 * time.Second)
	var after int
	for time.Now().Before(deadline) {
		runtime.GC()
		after = runtime.NumGoroutine()
		if after <= baseline+8 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if after > baseline+8 {
		t.Fatalf("goroutines leaked: baseline %d, after %d", baseline, after)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
