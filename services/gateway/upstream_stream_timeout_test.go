package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWholeAttemptTimeoutBoundsProgressingStreams(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, streaming := range []bool{false, true} {
			t.Run(path+"/"+fmtBool(streaming), func(t *testing.T) {
				var calls atomic.Int64
				canceled := make(chan struct{}, 1)
				limits := defaultLimits()
				limits.UpstreamTimeout = 150 * time.Millisecond
				limits.IdleTimeout = 400 * time.Millisecond
				limits.TotalDuration = 2 * time.Second
				h := newHarness(t, harnessOptions{EnableUsageV2: true, Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					_, _ = io.Copy(io.Discard, r.Body)
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}],\"usage\":{\"prompt_tokens\":11}}\n\n")
					w.(http.Flusher).Flush()
					ticker := time.NewTicker(20 * time.Millisecond)
					defer ticker.Stop()
					guard := time.NewTimer(900 * time.Millisecond)
					defer guard.Stop()
					for {
						select {
						case <-r.Context().Done():
							canceled <- struct{}{}
							return
						case <-guard.C:
							_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
							return
						case <-ticker.C:
							_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\".\"}}]}\n\n")
							w.(http.Flusher).Flush()
						}
					}
				}})
				server := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
				t.Cleanup(server.Close)
				payload := chatBody(chatBodyOptions{Stream: streaming})
				if path == "/v1/responses" {
					payload = []byte(fmt.Sprintf(`{"model":%q,"input":"hi","stream":%t}`, testModel, streaming))
				}
				r, _ := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewReader(payload))
				r.Header.Set("Authorization", "Bearer "+testAPIKey)
				r.Header.Set("Content-Type", "application/json")
				started := time.Now()
				response, err := server.Client().Do(r)
				if err != nil {
					t.Fatal(err)
				}
				body := readAll(response)
				failureText := CodeUpstreamTimeout
				if path == "/v1/responses" && streaming {
					failureText = errUpstreamTimeout().Message
					var failed bool
					for _, event := range responseEvents(t, body) {
						if event["type"] == "response.failed" {
							failed = true
							failure := event["response"].(map[string]any)["error"].(map[string]any)
							if failure["code"] != "server_error" {
								t.Fatal("timeout emitted an incompatible Responses error code")
							}
						}
					}
					if !failed {
						t.Fatal("timeout omitted the Responses failure event")
					}
				}
				if elapsed := time.Since(started); elapsed > 700*time.Millisecond || !strings.Contains(body, failureText) {
					t.Fatalf("active stream escaped its attempt budget: status=%d elapsed=%s", response.StatusCode, elapsed)
				}
				if streaming {
					if response.StatusCode != 200 || !strings.Contains(body, "partial") || strings.Contains(body, "[DONE]") || strings.Contains(body, "response.completed") {
						t.Fatal("stream timeout lost partial output or claimed completion")
					}
				} else if response.StatusCode != http.StatusGatewayTimeout {
					t.Fatalf("buffered timeout status=%d", response.StatusCode)
				}
				select {
				case <-canceled:
				case <-time.After(time.Second):
					t.Fatal("timed-out stream did not cancel upstream")
				}
				records := h.store.Requests()
				if calls.Load() != 1 || len(records) != 1 || len(records[0].Attempts) != 1 || records[0].Status != string(OutcomeUnknown) || records[0].ErrorCode != CodeUpstreamTimeout {
					t.Fatal("timeout changed execution count or terminal outcome")
				}
				event := records[0].EventV2
				if event == nil || event.Usage.InputTokens == nil || *event.Usage.InputTokens != 11 || event.Usage.OutputTokens != nil || event.Usage.TotalTokens != nil {
					t.Fatal("timeout lost observed usage or invented missing counts")
				}
			})
		}
	}
}

func TestTotalDeadlineShortensAttemptBudget(t *testing.T) {
	limits := defaultLimits()
	limits.UpstreamTimeout = time.Second
	limits.TotalDuration = 80 * time.Millisecond
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(600 * time.Millisecond):
			defaultUpstreamHandler()(w, r)
		}
	}})
	started := time.Now()
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	if code := errorCode(t, response); response.StatusCode != http.StatusGatewayTimeout || code != CodeUpstreamTimeout || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("parent deadline was not honored: status=%d code=%s", response.StatusCode, code)
	}
}

type attemptContextTransport struct {
	base http.RoundTripper
	seen chan context.Context
}

func (t *attemptContextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.seen <- r.Context()
	return t.base.RoundTrip(r)
}

func TestSuccessfulAttemptReleasesDeadlineContext(t *testing.T) {
	limits := defaultLimits()
	limits.UpstreamTimeout = time.Minute
	h := newHarness(t, harnessOptions{Limits: limits})
	seen := make(chan context.Context, 1)
	h.proxy.httpClient = &http.Client{Transport: &attemptContextTransport{base: h.upstream.Client().Transport, seen: seen}}
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if response.StatusCode != 200 || h.store.Requests()[0].Status != string(OutcomeCompleted) {
		t.Fatal("healthy attempt did not complete")
	}
	attempt := <-seen
	if _, ok := attempt.Deadline(); !ok {
		t.Fatal("dispatch has no deadline")
	}
	select {
	case <-attempt.Done():
	case <-time.After(time.Second):
		t.Fatal("completed attempt retained its deadline context")
	}
}

func TestAttemptDeadlineBoundsStalledErrorBody(t *testing.T) {
	limits := defaultLimits()
	limits.UpstreamTimeout = 80 * time.Millisecond
	limits.TotalDuration = time.Second
	var calls atomic.Int64
	h := newHarness(t, harnessOptions{Limits: limits, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusServiceUnavailable)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(600 * time.Millisecond):
		}
	}})
	started := time.Now()
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	if code := errorCode(t, response); response.StatusCode != http.StatusGatewayTimeout || code != CodeUpstreamTimeout || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("error body escaped timeout: status=%d code=%s", response.StatusCode, code)
	}
	if records := h.store.Requests(); calls.Load() != 1 || len(records) != 1 || records[0].Status != string(OutcomeFailed) || records[0].ErrorCode != CodeUpstreamTimeout {
		t.Fatal("timeout lost the known HTTP failure or repeated execution")
	}
}

func TestPreconnectionTimeoutGetsFreshBudgetForSafeFallback(t *testing.T) {
	limits := defaultLimits()
	limits.UpstreamTimeout = 80 * time.Millisecond
	limits.TotalDuration = time.Second
	var executions atomic.Int64
	h := newHarness(t, harnessOptions{Limits: limits, MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		executions.Add(1)
		defaultUpstreamHandler()(w, r)
	}, ExtraChannelsFn: func(url string) []SnapshotChannel {
		return []SnapshotChannel{{ID: "timeout-fallback", ConnectionID: "connection-fallback", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", CredentialMode: "managed", CredentialRef: "cred_fallback", Priority: 1, Enabled: true}}
	}})
	seen := make(chan context.Context, 2)
	var transports atomic.Int64
	h.proxy.httpClient = &http.Client{Transport: catalogTransportFunc(func(r *http.Request) (*http.Response, error) {
		seen <- r.Context()
		if transports.Add(1) == 1 {
			// No connection is assigned and nothing is sent to the provider.
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return h.upstream.Client().Transport.RoundTrip(r)
	})}
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if response.StatusCode != 200 || transports.Load() != 2 || executions.Load() != 1 {
		t.Fatal("safe pre-connection fallback inherited the expired attempt")
	}
	first, second := <-seen, <-seen
	firstDeadline, okFirst := first.Deadline()
	secondDeadline, okSecond := second.Deadline()
	if !okFirst || !okSecond || !secondDeadline.After(firstDeadline) || first.Err() != context.DeadlineExceeded || second.Err() != context.Canceled {
		t.Fatal("attempt deadline ownership was not independent and released")
	}
	if records := h.store.Requests(); len(records) != 1 || len(records[0].Attempts) != 2 || records[0].Status != string(OutcomeCompleted) || records[0].Attempts[1].ChannelID != "timeout-fallback" || h.managed.reserveCount() != 1 {
		t.Fatal("safe fallback changed reservation or attempt attribution")
	}
}
