package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type h2PersistenceGate struct {
	Store
	entered, release, finished chan struct{}
	open                       sync.Once
	calls                      atomic.Int32
}

func (g *h2PersistenceGate) unblock() { g.open.Do(func() { close(g.release) }) }

func (g *h2PersistenceGate) PersistTerminal(ctx context.Context, record *TerminalRecord) error {
	if g.calls.Add(1) == 1 {
		close(g.entered)
	}
	select {
	case <-g.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	err := g.Store.PersistTerminal(ctx, record)
	close(g.finished)
	return err
}

func TestHTTP2SuccessfulStreamWriteDoesNotExpireDuringPersistence(t *testing.T) {
	for _, tc := range []struct {
		name, path, request, completion string
	}{
		{"chat", "/v1/chat/completions", `{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}],"stream":true}`, "data: [DONE]"},
		{"responses", "/v1/responses", `{"model":"gpt-4o","input":"hello","stream":true}`, "event: response.completed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			limits := defaultLimits()
			limits.IdleTimeout = 100 * time.Millisecond
			limits.TotalDuration = 3 * time.Second
			var upstreamCalls atomic.Int32
			h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			gate := &h2PersistenceGate{Store: h.store, entered: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{})}
			h.proxy.store = gate
			handler := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
			server := httptest.NewUnstartedServer(handler)
			server.EnableHTTP2 = true
			server.StartTLS()
			t.Cleanup(func() { gate.unblock(); server.Close() })
			client := server.Client()
			client.Timeout = 4 * time.Second
			r, _ := http.NewRequest(http.MethodPost, server.URL+tc.path, strings.NewReader(tc.request))
			r.Header.Set("Authorization", "Bearer "+testAPIKey)
			r.Header.Set("Content-Type", "application/json")
			res, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			if res.ProtoMajor != 2 || res.StatusCode != http.StatusOK {
				t.Fatalf("fixture must exercise an established HTTP/2 stream: protocol=%s status=%d", res.Proto, res.StatusCode)
			}
			type readResult struct {
				body []byte
				err  error
			}
			readDone := make(chan readResult, 1)
			go func() { body, err := io.ReadAll(res.Body); readDone <- readResult{body, err} }()
			select {
			case <-gate.entered:
			case <-time.After(time.Second):
				t.Fatal("upstream did not finish before the persistence wait")
			}
			// The client continuously drains the body. Only durable persistence
			// pauses here, beyond the deadline of the last successful SSE write.
			// A downstream idle deadline must not reset this healthy HTTP/2 stream.
			persistenceDelay := time.NewTimer(3 * limits.IdleTimeout)
			<-persistenceDelay.C
			gate.unblock()
			select {
			case <-gate.finished:
			case <-time.After(time.Second):
				t.Fatal("terminal persistence did not finish after release")
			}
			var result readResult
			select {
			case result = <-readDone:
			case <-time.After(time.Second):
				t.Fatal("HTTP/2 response did not finish after durable persistence")
			}
			records := h.store.Requests()
			if upstreamCalls.Load() != 1 || gate.calls.Load() != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatalf("slow persistence repeated execution/accounting: upstream=%d persist=%d records=%d", upstreamCalls.Load(), gate.calls.Load(), len(records))
			}
			if records[0].Status != string(OutcomeCompleted) || records[0].InputTokens != 11 || records[0].OutputTokens != 4 {
				t.Fatal("healthy upstream completion or measured usage was lost")
			}
			if result.err != nil || !strings.Contains(string(result.body), tc.completion) || strings.Contains(string(result.body), "response.failed") {
				t.Fatalf("successful write deadline expired during persistence: read_error=%v completion_present=%v", result.err, strings.Contains(string(result.body), tc.completion))
			}
		})
	}
}

func TestTerminalWriteDeadlineDoesNotPoisonConnectionReuse(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, endpoint := range []string{"chat/completions", "responses"} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("http%d/%s/stream=%t", protocol, endpoint, streaming), func(t *testing.T) {
					limits := defaultLimits()
					limits.IdleTimeout = 100 * time.Millisecond
					var upstreamCalls atomic.Int32
					h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
						upstreamCalls.Add(1)
						defaultUpstreamHandler()(w, r)
					}})
					handler := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
					server := httptest.NewUnstartedServer(handler)
					server.EnableHTTP2 = protocol == 2
					server.StartTLS()
					t.Cleanup(server.Close)
					client := server.Client()
					client.Timeout = 3 * time.Second
					payload := fmt.Sprintf(`{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}],"stream":%t}`, streaming)
					completion := `"chat.completion"`
					if streaming {
						completion = "data: [DONE]"
					}
					if endpoint == "responses" {
						payload = fmt.Sprintf(`{"model":"gpt-4o","input":"hello","stream":%t}`, streaming)
						completion = `"status":"completed"`
						if streaming {
							completion = "event: response.completed"
						}
					}
					for requestNumber := range 2 {
						var reused atomic.Bool
						ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { reused.Store(info.Reused) }})
						r, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/"+endpoint, strings.NewReader(payload))
						r.Header.Set("Authorization", "Bearer "+testAPIKey)
						r.Header.Set("Content-Type", "application/json")
						res, err := client.Do(r)
						if err != nil {
							t.Fatalf("request %d failed on reusable connection: %v", requestNumber, err)
						}
						body, readErr := io.ReadAll(res.Body)
						_ = res.Body.Close()
						if res.ProtoMajor != protocol || res.StatusCode != 200 || readErr != nil || !strings.Contains(string(body), completion) {
							t.Fatalf("request %d did not complete: proto=%s status=%d read_error=%v", requestNumber, res.Proto, res.StatusCode, readErr)
						}
						if requestNumber == 1 && !reused.Load() {
							t.Fatal("second request opened another connection instead of proving reuse")
						}
						if requestNumber == 0 {
							// Allow any retained terminal timer to fire before reusing
							// the connection. net/http must have finished the prior
							// response and removed its request/stream deadline.
							timer := time.NewTimer(3 * limits.IdleTimeout)
							<-timer.C
						}
					}
					if upstreamCalls.Load() != 2 || len(h.store.Requests()) != 2 || h.store.OutboxCount(testTenantID) != 2 {
						t.Fatal("connection reuse repeated or lost model execution/accounting")
					}
				})
			}
		}
	}
}
