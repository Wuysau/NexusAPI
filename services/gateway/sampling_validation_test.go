package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type samplingHTTPFixture struct {
	h        *testHarness
	server   *httptest.Server
	mu       sync.Mutex
	received []json.RawMessage
}

func newSamplingHTTPFixture(t *testing.T) *samplingHTTPFixture {
	t.Helper()
	f := &samplingHTTPFixture{}
	f.h = newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			TopP json.RawMessage `json:"top_p"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("mock upstream could not decode request: %v", err)
		}
		f.mu.Lock()
		f.received = append(f.received, append(json.RawMessage(nil), request.TopP...))
		f.mu.Unlock()
		defaultUpstreamHandler()(w, r)
	}})
	f.server = httptest.NewServer(NewHTTPRouter(f.h.proxy, f.h.snapshots, f.h.limiter, f.h.store, RouteOptions{EnableResponses: true}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *samplingHTTPFixture) call(t *testing.T, endpoint, topP, idempotencyKey string) (int, string) {
	t.Helper()
	payload := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]`
	if endpoint == "/v1/responses" {
		payload = `{"model":"gpt-4o","input":"hi"`
	}
	if topP != "" {
		payload += `,"top_p":` + topP
	}
	payload += "}"
	req, err := http.NewRequest(http.MethodPost, f.server.URL+endpoint, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testAPIKey)
	req.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, readAll(response)
}

func (f *samplingHTTPFixture) values() []json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]json.RawMessage(nil), f.received...)
}

func TestInvalidTopPIsRejectedBeforeExecutionAndDoesNotClaimIdempotency(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, tc := range []struct {
			name, value string
			typeError   bool
		}{
			{"negative", "-0.1", false},
			{"above_one", "1.01", false},
			{"string", `"0.5"`, true},
			{"boolean", "true", true},
			{"object", "{}", true},
			{"array", "[]", true},
		} {
			t.Run(endpoint+"/"+tc.name, func(t *testing.T) {
				f := newSamplingHTTPFixture(t)
				const idempotencyKey = "sampling-invalid-then-corrected"
				status, body := f.call(t, endpoint, tc.value, idempotencyKey)
				var envelope errorEnvelope
				if err := json.Unmarshal([]byte(body), &envelope); err != nil {
					t.Fatal("gateway did not return valid JSON")
				}
				wantCode := CodeInvalidParameter
				if tc.typeError {
					wantCode = CodeInvalidJSON
				}
				if status != http.StatusBadRequest || envelope.Error.Code != wantCode {
					t.Errorf("invalid top_p was not rejected: status=%d code=%s", status, envelope.Error.Code)
				}
				if !tc.typeError && (envelope.Error.Param == nil || *envelope.Error.Param != "top_p") {
					t.Error("out-of-range top_p error did not identify the parameter")
				}
				if len(f.values()) != 0 || f.h.managed.reserveCount() != 0 || len(f.h.store.Requests()) != 0 || f.h.store.OutboxCount(testTenantID) != 0 {
					t.Errorf("invalid sampling value caused execution: upstream=%d reservations=%d terminal=%d outbox=%d", len(f.values()), f.h.managed.reserveCount(), len(f.h.store.Requests()), f.h.store.OutboxCount(testTenantID))
				}
				// A validation rejection must not claim the operation permanently.
				// Correcting the value under the same caller key executes once.
				status, _ = f.call(t, endpoint, "0.5", idempotencyKey)
				values := f.values()
				if status != http.StatusOK || len(values) != 1 || string(values[0]) != "0.5" || f.h.managed.reserveCount() != 1 || len(f.h.store.Requests()) != 1 || f.h.store.OutboxCount(testTenantID) != 1 {
					t.Errorf("corrected request did not execute exactly once: status=%d wire=%v reservations=%d terminal=%d", status, values, f.h.managed.reserveCount(), len(f.h.store.Requests()))
				}
			})
		}
	}
}

func TestValidTopPPreservesSamplingSemanticsOnUpstreamWire(t *testing.T) {
	for _, endpoint := range []string{"/v1/chat/completions", "/v1/responses"} {
		for _, tc := range []struct{ name, value, wire string }{
			{"zero", "0", "0"},
			{"one", "1", "1"},
			{"fraction", "0.25", "0.25"},
			{"null", "null", ""},
			{"omitted", "", ""},
		} {
			t.Run(endpoint+"/"+tc.name, func(t *testing.T) {
				f := newSamplingHTTPFixture(t)
				status, _ := f.call(t, endpoint, tc.value, "")
				values := f.values()
				if status != http.StatusOK || len(values) != 1 || string(values[0]) != tc.wire {
					t.Fatalf("sampling value changed on upstream wire: status=%d values=%s want=%q", status, fmt.Sprint(values), tc.wire)
				}
				if f.h.managed.reserveCount() != 1 || len(f.h.store.Requests()) != 1 || f.h.store.OutboxCount(testTenantID) != 1 {
					t.Fatal("accepted sampling value did not retain normal attribution and persistence")
				}
			})
		}
	}
}
