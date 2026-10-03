package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// The optional ID is synthetic malformed metadata. It must not erase reliable
// measured usage after an accepted native execution. The shared fixture skips
// unless the explicit loopback source27 -> disposable target18 is configured.
func TestProviderRequestIDStoragePostgres(t *testing.T) {
	db, store := newProviderIDPostgresFixture(t)
	seen := map[string]bool{}
	for _, native := range []struct{ name, adapter, normalID, invalidID string }{
		{"Anthropic NUL", "anthropic", "msg_fixture_nul_control", "msg_fixture_\x00_tail"},
		{"Gemini invalid UTF8", "gemini", "r_界�", string([]byte{'r', 0xff})},
	} {
		for _, v2 := range []bool{false, true} {
			for _, streaming := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/v2=%t/stream=%t", native.name, v2, streaming), func(t *testing.T) {
					var records []*TerminalRecord
					for _, tc := range []struct{ name, upstreamID, wantID string }{
						{"valid identifier retained", native.normalID, native.normalID},
						{"unrepresentable identifier omitted", native.invalidID, ""},
					} {
						t.Run(tc.name, func(t *testing.T) {
							h, calls, fallback := newProviderRequestIDHarness(t, native.adapter, tc.upstreamID, v2)
							pinProviderIDPostgresHarness(t, h, native.adapter)
							capture := &providerIDPostgresCapture{PostgresStore: store}
							h.proxy.store = capture
							var logs connectorRetryLogs
							h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
							response := h.doChat(chatBody(chatBodyOptions{Stream: streaming, Messages: []map[string]any{{"role": "user", "content": "private-collision-prompt"}}}), nil)
							body := anthropicGatewayRead(t, response)
							r, persistErr := capture.result()
							if r == nil || len(r.Attempts) != 1 || calls.Load() != 1 || fallback.Load() != 0 {
								t.Fatal("native request did not execute once without fallback")
							}
							records = append(records, r)
							if response.StatusCode != http.StatusOK || persistErr != nil {
								t.Errorf("optional upstream metadata prevented terminal durability: HTTP=%d persist=%v", response.StatusCode, persistErr)
							}
							if err := r.Validate(); err != nil {
								t.Fatalf("projected terminal candidate is invalid: %v", err)
							}
							if response.Header.Get("x-request-id") != r.RequestID {
								t.Error("public response lost the authoritative Gateway request ID")
							}
							if response.StatusCode == http.StatusOK && persistErr == nil {
								assertProviderRequestIDPublicOutput(t, response, body, streaming, r.RequestID)
							}
							assertProviderRequestIDProjection(t, r, tc.wantID)
							assertProviderIDPostgresUsage(t, r, native.adapter, v2)
							if h.managed.reserveCount() != 0 || h.byok.reserveCount() != 0 {
								t.Error("optional metadata introduced a BYOK reservation")
							}
							for _, id := range []string{r.RequestID, r.Attempts[0].AttemptID, r.Event.EventID} {
								if id == "" || seen[id] {
									t.Fatal("fixture reused an authoritative operation identity")
								}
								seen[id] = true
							}
							facts, err := json.Marshal(r)
							if err != nil {
								t.Fatal(err)
							}
							for _, private := range []string{"private-collision-prompt", "private-id-output-marker", "private-id-upstream-header", testAPIKey, "upstream-test-secret"} {
								if strings.Contains(string(facts), private) || strings.Contains(logs.String(), private) {
									t.Error("private content or credentials entered terminal facts/logs")
								}
							}
							if strings.Contains(body, tc.upstreamID) || strings.Contains(fmt.Sprint(response.Header), tc.upstreamID) || strings.Contains(logs.String(), tc.upstreamID) {
								t.Error("optional upstream ID replaced public identity or entered routine logs")
							}
						})
					}
					if len(records) != 2 {
						t.Fatal("missing terminal candidates for the valid/unrepresentable pair")
					}
					// Check actual completed request/attempt/outbox rows, exact optional
					// metadata, frozen V2 attribution and private-content absence.
					assertProviderIDPostgresFacts(t, db, records, v2)
				})
			}
		}
	}
}
