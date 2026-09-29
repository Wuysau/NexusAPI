package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func startLifecycleServer(t *testing.T, handler http.Handler) (*Server, string, <-chan error) {
	t.Helper()
	server := NewServer("127.0.0.1:0", handler, 16*1024, discardLogger())
	listener, err := net.Listen("tcp", server.http.Addr)
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan error, 1)
	go func() {
		stopped <- server.http.Serve(listener)
		close(stopped)
	}()
	t.Cleanup(func() { _ = server.http.Close() })
	return server, "http://" + listener.Addr().String(), stopped
}

func lifecycleStream(t *testing.T, baseURL string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/chat/completions", strings.NewReader(string(chatBody(chatBodyOptions{Stream: true}))))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("authorization", "Bearer "+testAPIKey)
	req.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", response.StatusCode, readAll(response))
	}
	return response
}

func TestServerShutdownForcedDrainPersistsBeforeClosers(t *testing.T) {
	upstreamCanceled := make(chan struct{})
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"drain\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(upstreamCanceled)
	}})
	// A terminal write deliberately outlives the grace deadline, and must still
	// finish before the resource registered below is closed.
	h.store.Latency = 150 * time.Millisecond
	server, baseURL, _ := startLifecycleServer(t, h.handler)
	var closerCalled atomic.Bool
	server.RegisterCloser(func() {
		closerCalled.Store(true)
		if len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
			t.Error("resources closed before canceled stream terminal and outbox became durable")
		}
		h.store.Close()
	})
	response := lifecycleStream(t, baseURL)
	buffer := make([]byte, 32)
	if _, err := response.Body.Read(buffer); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := server.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("forced drain must report expired grace: %v", err)
	}
	if !closerCalled.Load() {
		t.Fatal("cleaned server did not release resources")
	}
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("forced drain did not cancel upstream")
	}
	records := h.store.Requests()
	if len(records) != 1 || records[0].Status != string(OutcomeUnknown) || records[0].EventV2 == nil || records[0].EventV2.Usage.InputTokens != nil {
		t.Fatalf("canceled stream lost its unknown usage fact: %+v", records)
	}
}

func TestServerShutdownGracefulStreamCompletesBeforeClosers(t *testing.T) {
	finish := make(chan struct{})
	upstreamCanceled := make(chan struct{})
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"grace\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-finish:
			_, _ = io.WriteString(w, "data: {\"id\":\"grace\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"grace\",\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n")
		case <-r.Context().Done():
			close(upstreamCanceled)
		}
	}})
	server, baseURL, listenerStopped := startLifecycleServer(t, h.handler)
	var closerCalls atomic.Int32
	server.RegisterCloser(func() {
		closerCalls.Add(1)
		records := h.store.Requests()
		if len(records) != 1 || records[0].Status != string(OutcomeCompleted) || h.store.OutboxCount(testTenantID) != 1 {
			t.Error("resource closure preceded successful stream persistence")
		}
	})
	response := lifecycleStream(t, baseURL)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- server.Shutdown(ctx) }()
	select {
	case <-listenerStopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not stop accepting requests")
	}
	select {
	case <-upstreamCanceled:
		t.Fatal("graceful shutdown canceled the active stream before grace expired")
	default:
	}
	close(finish)
	body := readAll(response)
	if !strings.HasSuffix(strings.TrimSpace(body), "data: [DONE]") {
		t.Fatalf("graceful stream did not complete: %s", body)
	}
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	if closerCalls.Load() != 1 {
		t.Fatalf("closer called %d times", closerCalls.Load())
	}
}

func TestServerShutdownConcurrentCallersShareCleanup(t *testing.T) {
	handlerDone := make(chan struct{})
	var calls atomic.Int32
	server, baseURL, listenerStopped := startLifecycleServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(handlerDone)
	}))
	var closerCalls atomic.Int32
	server.RegisterCloser(func() { closerCalls.Add(1) })
	client := &http.Client{Timeout: 3 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	response, err := client.Get(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	firstDone := make(chan error, 1)
	go func() { firstDone <- server.Shutdown(ctx) }()
	select {
	case <-listenerStopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not stop listener")
	}

	// Waiting callers may time out without shortening the initiating caller's
	// grace period or closing request dependencies on their own.
	otherCtx, cancelOther := context.WithCancel(context.Background())
	cancelOther()
	if err := server.Shutdown(otherCtx); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting caller did not honor its own cancellation: %v", err)
	}
	select {
	case <-handlerDone:
		t.Fatal("waiting caller canceled another caller's drain")
	default:
	}
	if closerCalls.Load() != 0 {
		t.Fatal("waiting caller released resources during grace")
	}

	// Requests racing with listener closure never enter application handlers.
	responseRecorder := httptest.NewRecorder()
	server.http.Handler.ServeHTTP(responseRecorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if responseRecorder.Code != http.StatusServiceUnavailable || calls.Load() != 1 {
		t.Fatalf("new request admitted during drain: status=%d calls=%d", responseRecorder.Code, calls.Load())
	}
	if responseRecorder.Header().Get("retry-after") != "1" || responseRecorder.Header().Get("x-request-id") == "" {
		t.Fatal("draining response lost retry guidance or request correlation")
	}

	const followers = 8
	results := make(chan error, followers)
	for range followers {
		go func() {
			waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer waitCancel()
			results <- server.Shutdown(waitCtx)
		}()
	}
	cancel()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("first shutdown result=%v", err)
	}
	for range followers {
		if err := <-results; !errors.Is(err, context.Canceled) {
			t.Fatalf("concurrent shutdown result=%v", err)
		}
	}
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("canceled handler still running after shutdown")
	}
	if closerCalls.Load() != 1 {
		t.Fatalf("concurrent shutdown closed resources %d times", closerCalls.Load())
	}
}

func TestServerShutdownEmergencyCleanupIsBounded(t *testing.T) {
	releaseHandler := make(chan struct{})
	handlerCanceled := make(chan struct{})
	handlerDone := make(chan struct{})
	server, baseURL, _ := startLifecycleServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(handlerCanceled)
		<-releaseHandler // simulate a broken dependency ignoring cancellation
	}))
	if server.cleanupTimeout <= 10*time.Second {
		t.Fatal("production cleanup window must exceed terminal persistence budget")
	}
	server.cleanupTimeout = 30 * time.Millisecond
	var closerCalls atomic.Int32
	server.RegisterCloser(func() { closerCalls.Add(1) })
	t.Cleanup(func() {
		close(releaseHandler)
		_ = server.http.Close()
		select {
		case <-handlerDone:
		case <-time.After(time.Second):
			t.Error("emergency fixture handler leaked")
		}
	})
	client := &http.Client{Timeout: 3 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	response, err := client.Get(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = server.Shutdown(ctx)
	if !errors.Is(err, ErrShutdownIncomplete) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("emergency result=%v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("emergency shutdown waited beyond its cleanup budget")
	}
	select {
	case <-handlerCanceled:
	case <-time.After(time.Second):
		t.Fatal("emergency shutdown did not cancel handler context")
	}
	if closerCalls.Load() != 0 {
		t.Fatal("emergency shutdown closed dependencies under a running handler")
	}
	if err := server.Shutdown(context.Background()); !errors.Is(err, ErrShutdownIncomplete) {
		t.Fatalf("repeated shutdown concealed incomplete cleanup: %v", err)
	}
}

func TestServerShutdownNilLoggerAndCloserOrder(t *testing.T) {
	server := NewServer("127.0.0.1:0", nil, 16*1024, nil)
	var order []int
	server.RegisterCloser(func() { order = append(order, 1) })
	server.RegisterCloser(func() { order = append(order, 2) })
	server.RegisterCloser(nil)
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	server.RegisterCloser(func() { order = append(order, 3) })
	if len(order) != 3 || order[0] != 2 || order[1] != 1 || order[2] != 3 {
		t.Fatalf("closer order=%v", order)
	}
}
