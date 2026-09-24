package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestConfirmedQuotaExhaustionRoutesNextRequestToCompatibleChannel(t *testing.T) {
	var primaryCalls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		primaryCalls.Add(1)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"code":"insufficient_quota"}}`)
	}, ExtraChannels: []SnapshotChannel{{
		ID: "chan_fallback", ConnectionID: "connection-fallback", ProviderID: "prov_openai", Provider: "openai",
		BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global",
		CredentialMode: "managed", CredentialRef: "cred_fallback", Priority: 1, Enabled: true,
	}}})

	first := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(first)
	if primaryCalls.Load() != 1 || fallbackCalls.Load() != 0 {
		t.Fatalf("quota rejection replayed current request: primary=%d fallback=%d", primaryCalls.Load(), fallbackCalls.Load())
	}
	if state := h.breaker.State(BreakerKey("chan_test_1", testModel)); state != BreakerOpen {
		t.Fatalf("exhausted channel remains selectable: %s", state)
	}
	second := h.doChat(chatBody(chatBodyOptions{}), nil)
	if second.StatusCode != http.StatusOK {
		t.Fatalf("next request did not use fallback: %d %s", second.StatusCode, readAll(second))
	}
	_ = readAll(second)
	if primaryCalls.Load() != 1 || fallbackCalls.Load() != 1 {
		t.Fatalf("wrong next-request target: primary=%d fallback=%d", primaryCalls.Load(), fallbackCalls.Load())
	}
}

func TestProviderUnavailableResponseDoesNotReplayCurrentRequest(t *testing.T) {
	var primaryCalls, fallbackCalls atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}))
	t.Cleanup(fallback.Close)
	h := newHarness(t, harnessOptions{MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		primaryCalls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}, ExtraChannels: []SnapshotChannel{{
		ID: "chan_fallback", ConnectionID: "connection-fallback", ProviderID: "prov_openai", Provider: "openai",
		BaseURL: fallback.URL, AuthScheme: "bearer", Models: []string{testModel}, Region: "global",
		CredentialMode: "managed", CredentialRef: "cred_fallback", Priority: 1, Enabled: true,
	}}})
	_ = readAll(h.doChat(chatBody(chatBodyOptions{}), nil))
	if primaryCalls.Load() != 1 || fallbackCalls.Load() != 0 {
		t.Fatalf("provider response caused ambiguous replay: primary=%d fallback=%d", primaryCalls.Load(), fallbackCalls.Load())
	}
}
