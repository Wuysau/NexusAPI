package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nexus/gateway/connectorclient"
)

// Use the real polling Client and Hub over HTTP; only control-plane authority
// and model execution are fixtures. No PostgreSQL or external provider is used.
func loopbackConnectorHub(t *testing.T, upstreamURL string, channel SnapshotChannel) *ConnectorHub {
	t.Helper()
	const leaseToken = "nxlease_synthetic-cooldown-lease"
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/api/connector/lease":
			_ = json.NewEncoder(w).Encode(map[string]any{"leaseToken": leaseToken, "expiresAt": time.Now().Add(time.Minute)})
		case "/api/internal/gateway/connector":
			_ = json.NewEncoder(w).Encode(connectorGrant{LeaseID: "cooldown-lease", ConnectorID: "cooldown-connector", ConnectionID: channel.ConnectionID, TenantID: channel.TenantID, ExpiresAt: time.Now().Add(time.Minute), Models: channel.Models})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(cp.Close)
	hub := NewConnectorHub(cp.URL, "synthetic-cooldown-internal-token")
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	client, err := connectorclient.New(connectorclient.Config{ControlURL: cp.URL, GatewayURL: server.URL, UpstreamURL: upstreamURL + "/v1", Models: channel.Models, AllowHTTPDevelopment: true, UpstreamTimeoutSeconds: 5})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.Run(ctx, connectorclient.Identity{ConnectorID: "cooldown-connector", ConnectionID: channel.ConnectionID, TenantID: channel.TenantID, Credential: "nxidentity_synthetic-cooldown-identity", ControlURL: cp.URL})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("client shutdown: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("client did not join workers on cancellation")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for hub.session(&channel) == nil {
		if time.Now().After(deadline) {
			t.Fatal("connector never registered a polling session")
		}
		time.Sleep(time.Millisecond)
	}
	return hub
}

func TestConnectorRetryHintControlsLaterRequestsAndRecoversPerModel(t *testing.T) {
	const otherModel = "ollama-cooldown-other"
	const headerMarker = "private-cooldown-header-marker"
	const bodyMarker = "private-cooldown-body-marker"
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprintf("status=%d", status), func(t *testing.T) {
			channel := SnapshotChannel{ID: "cooldown-channel", ConnectionID: "cooldown-connection", TenantID: testTenantID, ProjectID: "project-test", ProviderID: "ollama-provider", Provider: "ollama", Protocol: "openai", Transport: "local_sidecar", BaseURL: "https://connector.invalid/v1", CredentialMode: "byok", CredentialRef: "cooldown-credential", Enabled: true, Models: []string{testModel, otherModel}, Capabilities: []string{"text", "streaming"}}
			key := BreakerKey(channel.ID, testModel)
			var targetCalls, otherCalls atomic.Int64
			recoveryState := make(chan BreakerState, 1)
			var h *testHarness
			h = newHarness(t, harnessOptions{CredentialMode: "byok", EnableUsageV2: true, NoPrice: true, Channels: []SnapshotChannel{channel}, Models: []SnapshotModel{
				{ID: testModel, Provider: "ollama", License: "fixture", Status: "active", Capabilities: []string{"text", "streaming"}},
				{ID: otherModel, Provider: "ollama", License: "fixture", Status: "active", Capabilities: []string{"text", "streaming"}},
			}, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/models" {
					_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"id": testModel}, map[string]string{"id": otherModel}}})
					return
				}
				var input struct{ Model string }
				if json.NewDecoder(r.Body).Decode(&input) != nil {
					http.Error(w, "invalid fixture input", 400)
					return
				}
				if input.Model == testModel {
					if targetCalls.Add(1) == 1 {
						w.Header().Set("Retry-After", "12")
						w.Header().Set("X-Private-Provider-Header", headerMarker)
						w.Header().Set("Set-Cookie", headerMarker)
						w.WriteHeader(status)
						_, _ = io.WriteString(w, `{"error":{"message":"`+bodyMarker+`"}}`)
						return
					}
					recoveryState <- h.breaker.State(key)
				} else {
					otherCalls.Add(1)
				}
				defaultUpstreamHandler()(w, r)
			}})
			h.proxy.connectors = loopbackConnectorHub(t, h.upstream.URL, channel)
			var logs bytes.Buffer
			h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
			clock := &testClock{now: time.Now()}
			h.breaker.SetClock(clock.Now)
			h.breaker.cfg.OpenDuration = 30 * time.Second

			first := h.doChat(chatBody(chatBodyOptions{}), nil)
			firstBody := readAll(first)
			firstID := first.Header.Get("x-request-id")
			if first.StatusCode == http.StatusOK || targetCalls.Load() != 1 {
				t.Fatalf("rejection replayed or disappeared: status=%d executions=%d", first.StatusCode, targetCalls.Load())
			}
			h.breaker.mu.Lock()
			entry := h.breaker.entries[key]
			state, retryAt := entry.state, entry.retryAt
			h.breaker.mu.Unlock()
			if state != BreakerOpen || !retryAt.Equal(clock.Now().Add(12*time.Second)) {
				t.Fatalf("connector hint lost: state=%s retryAt=%s, want 12-second cooldown", state, retryAt)
			}
			blocked := h.doChat(chatBody(chatBodyOptions{}), nil)
			blockedBody := readAll(blocked)
			if blocked.StatusCode != http.StatusServiceUnavailable || targetCalls.Load() != 1 || len(h.store.Requests()) != 1 {
				t.Fatal("request during cooldown executed or produced a terminal usage fact")
			}
			other := h.doChat(chatBody(chatBodyOptions{Model: otherModel}), nil)
			otherBody := readAll(other)
			if other.StatusCode != http.StatusOK || otherCalls.Load() != 1 || h.breaker.State(BreakerKey(channel.ID, otherModel)) != BreakerClosed {
				t.Fatal("cooldown affected another model on the same connector")
			}
			clock.Advance(11 * time.Second)
			if h.breaker.Available(key) {
				t.Fatal("cooldown ended before the provider's hint")
			}
			clock.Advance(time.Second)
			recovered := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
			recoveredBody := readAll(recovered)
			if recovered.StatusCode != http.StatusOK || !strings.Contains(recoveredBody, "[DONE]") || targetCalls.Load() != 2 || h.breaker.State(key) != BreakerClosed {
				t.Fatal("expired cooldown did not recover through one successful probe")
			}
			if state := <-recoveryState; state != BreakerHalfOpen {
				t.Fatalf("recovery bypassed half-open admission: %s", state)
			}

			records := h.store.Requests()
			if len(records) != 3 || len(h.store.CapturedRequests()) != 3 || h.store.OutboxCount(testTenantID) != 3 || h.managed.reserveCount() != 0 {
				t.Fatal("cooldown changed execution/accounting cardinality or charged managed capacity")
			}
			for _, record := range records {
				event := record.EventV2
				if len(record.Attempts) != 1 || event == nil || event.PriceVersionId != nil || event.Attribution.ExecutionMode != "byok" ||
					event.Attribution.ConnectionId == nil || *event.Attribution.ConnectionId != channel.ConnectionID ||
					event.Attribution.ProjectId == nil || *event.Attribution.ProjectId != "project-test" ||
					event.Attribution.ApiKeyId == nil || *event.Attribution.ApiKeyId != testKeyID ||
					record.Attempts[0].ConnectionID != channel.ConnectionID || record.Attempts[0].PriceVersionID != "" {
					t.Fatal("connector attempt lost attribution or invented a price")
				}
				if record.RequestID == firstID {
					if record.Status != string(OutcomeFailed) || event.Usage.InputTokens != nil || event.Usage.OutputTokens != nil {
						t.Fatal("upstream rejection invented completed usage")
					}
				} else if record.Status != string(OutcomeCompleted) || event.Usage.InputTokens == nil || *event.Usage.InputTokens != 11 || event.Usage.OutputTokens == nil || *event.Usage.OutputTokens != 4 {
					t.Fatal("successful execution lost observed usage")
				}
			}
			facts, _ := json.Marshal(records)
			retained := string(facts) + logs.String() + firstBody + blockedBody + otherBody + recoveredBody + fmt.Sprint(first.Header)
			for _, marker := range []string{headerMarker, bodyMarker} {
				if strings.Contains(retained, marker) {
					t.Fatal("local upstream headers or error body escaped into facts, logs or downstream response")
				}
			}
		})
	}
}
