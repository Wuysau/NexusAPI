package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func largeBufferedUpstream(calls *atomic.Int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("content-type", "text/event-stream")
		chunk := strings.Repeat("x", 32*1024)
		for range 256 {
			if _, err := fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"%s\"}}]}\n\n", chunk); err != nil {
				return
			}
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n")
	}
}

func TestBufferedInferenceDisconnectsClientThatStopsReading(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(endpoint, func(t *testing.T) {
			limits := defaultLimits()
			limits.IdleTimeout = 150 * time.Millisecond
			limits.MaxConcurrent = 1
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: largeBufferedUpstream(&calls)})
			router := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true})
			done := make(chan struct{})
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				router.ServeHTTP(w, r)
			}))
			// Small kernel buffers make the real network backpressure reproducible.
			server.Config.ConnState = func(conn net.Conn, state http.ConnState) {
				if state == http.StateNew {
					if tcp, ok := conn.(*net.TCPConn); ok {
						_ = tcp.SetWriteBuffer(4096)
					}
				}
			}
			server.Start()
			defer server.Close()
			address := strings.TrimPrefix(server.URL, "http://")
			conn, err := net.Dial("tcp", address)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.(*net.TCPConn).SetReadBuffer(4096)
			body := string(chatBody(chatBodyOptions{}))
			if endpoint == "/v1/responses" {
				body = `{"model":"gpt-4o","input":"hello"}`
			}
			if _, err := fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", endpoint, address, testAPIKey, len(body), body); err != nil {
				t.Fatal(err)
			}
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("response did not begin: %v", err)
			}
			if response.StatusCode != http.StatusOK || response.Header.Get("content-type") != "application/json" {
				t.Fatalf("fixture did not reach buffered completion: %d", response.StatusCode)
			}
			// Leave the connection open without consuming the remaining JSON.
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("buffered response remains blocked after the write budget")
			}
			if calls.Load() != 1 || h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("failed delivery replayed inference or changed terminal accounting")
			}
			if h.store.Requests()[0].Status != string(OutcomeCompleted) {
				t.Fatal("post-persistence delivery failure changed the upstream completion fact")
			}
			release, available := h.limiter.AcquireConcurrency(testTenantID, 1)
			if !available {
				t.Fatal("slow response retained the tenant concurrency slot")
			}
			release()
		})
	}
}

func TestBufferedInferenceDeliversCompleteLargeJSON(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		t.Run(endpoint, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: largeBufferedUpstream(&calls)})
			server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
			defer server.Close()
			body := string(chatBody(chatBodyOptions{}))
			if endpoint == "/v1/responses" {
				body = `{"model":"gpt-4o","input":"hello"}`
			}
			req, _ := http.NewRequest(http.MethodPost, server.URL+endpoint, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+testAPIKey)
			client := server.Client()
			client.Timeout = 10 * time.Second
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var output struct {
				Choices []struct{ Message struct{ Content string } }
				Output  []struct{ Content []struct{ Text string } }
			}
			if err := json.NewDecoder(res.Body).Decode(&output); err != nil || res.StatusCode != http.StatusOK {
				t.Fatalf("healthy large response failed: status=%d err=%v", res.StatusCode, err)
			}
			if _, err := io.Copy(io.Discard, res.Body); err != nil {
				t.Fatalf("HTTP response framing did not complete: %v", err)
			}
			var text string
			if len(output.Choices) == 1 {
				text = output.Choices[0].Message.Content
			} else if len(output.Output) == 1 && len(output.Output[0].Content) == 1 {
				text = output.Output[0].Content[0].Text
			}
			if len(text) != 8<<20 || strings.Trim(text, "x") != "" || calls.Load() != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("large response lost content or repeated execution/accounting")
			}
		})
	}
}
