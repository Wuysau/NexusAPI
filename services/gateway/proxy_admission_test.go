package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func admissionHTTPCall(ctx context.Context, h *testHarness) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.server.URL+"/v1/chat/completions", strings.NewReader(string(chatBody(chatBodyOptions{}))))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+testAPIKey)
	req.Header.Set("Content-Type", "application/json")
	return h.server.Client().Do(req)
}

func awaitAdmissionCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("admission lifecycle did not reach expected state")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestProxyAdmissionEnforcesChannelCapOverHTTP(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	limits := defaultLimits()
	limits.ChannelMaxConcurrent = 1
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-release:
			defaultUpstreamHandler()(w, r)
		case <-r.Context().Done():
		}
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	firstDone := make(chan error, 1)
	go func() {
		resp, err := admissionHTTPCall(ctx, h)
		if resp != nil {
			_ = readAll(resp)
		}
		firstDone <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("first request did not dispatch")
	}
	defer close(release)
	second := h.doChat(chatBody(chatBodyOptions{}), nil)
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("channel cap bypassed: %d %s", second.StatusCode, readAll(second))
	}
	if code := errorCode(t, second); code != CodeConcurrencyExceeded {
		t.Fatalf("wrong admission error: %s", code)
	}
	select {
	case <-entered:
		t.Fatal("denied request reached upstream")
	default:
	}
	cancel()
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first request stuck after cancellation")
	}
}

func TestProxyAdmissionProductionWithoutRedisFailsClosed(t *testing.T) {
	var calls atomic.Int64
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { calls.Add(1); defaultUpstreamHandler()(w, r) }})
	h.proxy.env.Environment = "production"
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("production missing Redis allowed: %d %s", resp.StatusCode, readAll(resp))
	}
	_ = readAll(resp)
	if calls.Load() != 0 || h.managed.reserveCount() != 0 {
		t.Fatal("unavailable admission dispatched or reserved budget")
	}
}

func TestProxyAdmissionClientCancellationReleasesCapacityWithoutPoisoningHealth(t *testing.T) {
	entered := make(chan struct{})
	stopUpstream := make(chan struct{})
	defer close(stopUpstream)
	var calls atomic.Int64
	limits := defaultLimits()
	limits.MaxConcurrent = 1
	limits.ChannelMaxConcurrent = 1
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = io.Copy(io.Discard, r.Body)
			close(entered)
			select {
			case <-r.Context().Done():
			case <-stopUpstream:
			}
			return
		}
		defaultUpstreamHandler()(w, r)
	}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		resp, err := admissionHTTPCall(ctx, h)
		if resp != nil {
			_ = readAll(resp)
		}
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("first request did not dispatch")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("client cancellation did not finish")
	}
	awaitAdmissionCondition(t, func() bool { return len(h.store.Requests()) == 1 })
	key := BreakerKey("chan_test_1", testModel)
	failureRate := h.breaker.FailureRate(key)
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cancelled request leaked tenant/channel capacity: %d %s", resp.StatusCode, readAll(resp))
	}
	_ = readAll(resp)
	if failureRate != 0 {
		t.Fatalf("client cancellation counted as upstream failure: %v", failureRate)
	}
}

func TestProxyAdmissionQueueTimeDoesNotContaminateUpstreamTTFT(t *testing.T) {
	limits := defaultLimits()
	limits.ChannelMaxConcurrent = 1
	limits.ConcurrencyWait = time.Second
	h := newHarness(t, harnessOptions{Limits: limits})
	hold, err := h.limiter.AcquireContext(context.Background(), ConcurrencyRequest{ChannelID: "chan_test_1", ChannelLimit: 1, AllowLocal: true})
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		resp, err := admissionHTTPCall(ctx, h)
		if resp != nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				err = io.ErrUnexpectedEOF
			}
		}
		done <- err
	}()
	awaitAdmissionCondition(t, func() bool { return h.managed.reserveCount() == 1 })
	time.Sleep(250 * time.Millisecond)
	hold.Release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if ttft := h.breaker.TTFTMs(BreakerKey("chan_test_1", testModel)); ttft >= 150 {
		t.Fatalf("admission queue delay contaminated upstream TTFT: %.1f ms", ttft)
	}
}
