package main

// Hot-path behaviour: auth, routing, streaming, usage accounting, idempotency.

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"nexus/gateway/provider"
)

func TestChatCompletionsStreamsAndRecordsUsage(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readAll(resp))
	}
	if ct := resp.Header.Get("content-type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	body := readAll(resp)
	if !strings.Contains(body, `"content":"Hello"`) {
		t.Fatalf("stream body missing content: %s", body)
	}
	if !strings.HasSuffix(strings.TrimSpace(body), "data: [DONE]") {
		t.Fatalf("stream must end with [DONE]: %s", body)
	}

	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("expected one terminal record, got %d", len(records))
	}
	rec := records[0]
	if rec.Status != "completed" {
		t.Fatalf("status = %q", rec.Status)
	}
	if rec.InputTokens != 11 || rec.OutputTokens != 4 {
		t.Fatalf("tokens = %d/%d", rec.InputTokens, rec.OutputTokens)
	}
	if rec.ChannelKind != "platform" {
		t.Fatalf("channel kind = %q", rec.ChannelKind)
	}
	if rec.Event.Status != UsageStatusCompleted || rec.Event.Usage.Estimated {
		t.Fatalf("usage event = %+v", rec.Event)
	}
	if rec.Event.PriceVersionID != testPriceID {
		t.Fatalf("price version = %q", rec.Event.PriceVersionID)
	}
	if rec.Event.CatalogVersionID != testCatalogID {
		t.Fatalf("catalog version = %q", rec.Event.CatalogVersionID)
	}
	if err := rec.Event.Validate(); err != nil {
		t.Fatalf("usage event must satisfy the contract: %v", err)
	}
	if h.store.OutboxCount(testTenantID) != 1 {
		t.Fatalf("outbox rows = %d", h.store.OutboxCount(testTenantID))
	}

	// Exactly one attempt, and it is the attempt the event bills.
	if len(rec.Attempts) != 1 || rec.Attempts[0].AttemptID != rec.Event.AttemptID {
		t.Fatalf("attempts = %+v", rec.Attempts)
	}

	hold := h.managed.reserveRequests()[0]
	if hold.PriceVersionID != rec.ProviderPriceVersionID || hold.SalePriceSnapshotID != rec.SalePriceSnapshotID || hold.SalePriceSnapshotID == "" {
		t.Fatalf("authorization pins differ: hold=%+v terminal=%+v", hold, rec)
	}
	// Managed traffic must have been reserved with terminal usage persisted for Worker.
	if h.managed.reserveCount() != 1 {
		t.Fatalf("reserve calls = %d", h.managed.reserveCount())
	}
	if rec.Status != "completed" || rec.InputTokens != 11 || rec.OutputTokens != 4 || rec.Event.Usage.Estimated {
		t.Fatalf("terminal usage = %+v", rec)
	}

}

func TestChatCompletionsNonStreamingAggregates(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["object"] != "chat.completion" {
		t.Fatalf("object = %v", body["object"])
	}
	choices, _ := body["choices"].([]any)
	if len(choices) != 1 {
		t.Fatalf("choices = %v", body["choices"])
	}
	message := choices[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "Hello" {
		t.Fatalf("content = %v", message["content"])
	}
	usage, _ := body["usage"].(map[string]any)
	if usage == nil || usage["prompt_tokens"].(float64) != 11 {
		t.Fatalf("usage = %v", body["usage"])
	}
}

// Usage missing from the provider must be estimated and flagged, never billed
// as a silent zero.
func TestMissingUsageIsEstimated(t *testing.T) {
	h := newHarness(t, harnessOptions{
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		},
	})
	resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	_ = readAll(resp)

	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("records = %d", len(records))
	}
	event := records[0].Event
	if !event.Usage.Estimated {
		t.Fatal("usage without provider counts must be marked estimated")
	}
	if event.Usage.InputTokens <= 0 {
		t.Fatalf("estimated input tokens must be positive, got %d", event.Usage.InputTokens)
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("estimated event must still satisfy the contract: %v", err)
	}
}

func TestAliasResolution(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	resp := h.doChat(chatBody(chatBodyOptions{Model: "gpt4o"}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("alias must resolve to the canonical model, got %d", resp.StatusCode)
	}
	_ = readAll(resp)
	records := h.store.Requests()
	if len(records) != 1 || records[0].ResolvedUpstreamModel != testModel {
		t.Fatalf("resolved model = %+v", records)
	}
	if records[0].RequestModel != "gpt4o" {
		t.Fatalf("request model should preserve what the client sent, got %q", records[0].RequestModel)
	}
}

func TestUnknownModelIsRejected(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	resp := h.doChat(chatBody(chatBodyOptions{Model: "not-a-model"}), nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if code := errorCode(t, resp); code != CodeModelNotFound {
		t.Fatalf("code = %q", code)
	}
}

// A model with no published price version cannot produce a contract-valid usage
// event, so it must not be served at a silent zero price.
func TestModelWithoutPriceVersionIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{NoPrice: true})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestAuthFailures(t *testing.T) {
	cases := []struct {
		name     string
		key      string
		options  harnessOptions
		wantCode string
		wantHTTP int
	}{
		{"missing key", "", harnessOptions{}, CodeInvalidAPIKey, http.StatusUnauthorized},
		{"malformed key", APIKeyPrefix + "short", harnessOptions{}, CodeInvalidAPIKey, http.StatusUnauthorized},
		{"unknown key", APIKeyPrefix + "unknown000000000000000000000000000", harnessOptions{}, CodeInvalidAPIKey, http.StatusUnauthorized},
		{"disabled key", testAPIKey, harnessOptions{DisableKey: true}, CodeKeyDisabled, http.StatusUnauthorized},
		{"revoked key", testAPIKey, harnessOptions{RevokeKey: true}, CodeKeyRevoked, http.StatusUnauthorized},
		{"expired key", testAPIKey, harnessOptions{KeyExpiresIn: -time.Minute}, CodeKeyExpired, http.StatusUnauthorized},
		{"missing scope", testAPIKey, harnessOptions{KeyScopes: []string{ScopeModelsRead}}, CodeScopeDenied, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.options)
			req, _ := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions", strings.NewReader(string(chatBody(chatBodyOptions{}))))
			req.Header.Set("content-type", "application/json")
			if tc.key != "" {
				req.Header.Set("authorization", "Bearer "+tc.key)
			}
			resp, err := h.server.Client().Do(req)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			if resp.StatusCode != tc.wantHTTP {
				t.Fatalf("status = %d want %d (body %s)", resp.StatusCode, tc.wantHTTP, readAll(resp))
			}
			if code := errorCode(t, resp); code != tc.wantCode {
				t.Fatalf("code = %q want %q", code, tc.wantCode)
			}
		})
	}
}

// There is no default-open path: a gateway without a usable snapshot refuses
// traffic instead of serving it unauthenticated.
func TestNoSnapshotFailsClosed(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.source.setFail(true)
	// Force the cache to refetch by using a fresh cache over the failing source.
	cache := NewSnapshotCache(h.source, h.keyring, SnapshotConfig{RefreshInterval: time.Minute, MaxAge: time.Minute, FetchTimeout: time.Second}, discardLogger())
	h.proxy.snapshots = cache
	h.proxy.authn = NewAuthenticator(cache)

	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readAll(resp))
	}
	if code := errorCode(t, resp); code != CodeSnapshotUnavailable {
		t.Fatalf("code = %q", code)
	}
}

func TestScopeDeniedForModelsReadOnChat(t *testing.T) {
	h := newHarness(t, harnessOptions{KeyScopes: []string{ScopeModelsRead}})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestModelsEndpointComesFromSnapshot(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	req, _ := http.NewRequest(http.MethodGet, h.server.URL+"/v1/models", nil)
	req.Header.Set("authorization", "Bearer "+testAPIKey)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	body := decodeJSON(t, resp)
	data, _ := body["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("models = %v", body["data"])
	}
	model := data[0].(map[string]any)
	if model["id"] != testModel {
		t.Fatalf("model id = %v", model["id"])
	}
	// /v1/models must not call an upstream provider.
	if h.managed.reserveCount() != 0 {
		t.Fatal("/v1/models must not reserve budget")
	}
}

func TestUnsupportedParameterAndValidation(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	cases := []struct {
		name string
		body []byte
		code string
	}{
		{"unknown param", chatBody(chatBodyOptions{Extra: map[string]any{"bogus": 1}}), CodeUnsupportedParam},
		{"empty messages", []byte(`{"model":"gpt-4o","messages":[]}`), CodeInvalidParameter},
		{"bad role", chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "wizard", "content": "hi"}}}), CodeInvalidParameter},
		{"bad temperature", chatBody(chatBodyOptions{Extra: map[string]any{"temperature": 9}}), CodeInvalidParameter},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.doChat(tc.body, nil)
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			if code := errorCode(t, resp); code != tc.code {
				t.Fatalf("code = %q want %q", code, tc.code)
			}
		})
	}
}

func TestRequestTooLargeIsRejected(t *testing.T) {
	limits := defaultLimits()
	limits.MaxBodyBytes = 512
	h := newHarness(t, harnessOptions{Limits: limits})
	resp := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "user", "content": strings.Repeat("x", 2048)}}}), nil)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if code := errorCode(t, resp); code != CodeRequestTooLarge {
		t.Fatalf("code = %q", code)
	}
}

// A duplicate idempotency key must not trigger a second upstream call.
func TestDuplicateRequestIsRejected(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	headers := map[string]string{"Idempotency-Key": "idem-1"}

	first := h.doChat(chatBody(chatBodyOptions{}), headers)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first status = %d", first.StatusCode)
	}
	_ = readAll(first)

	second := h.doChat(chatBody(chatBodyOptions{}), headers)
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second status = %d body=%s", second.StatusCode, readAll(second))
	}
	if code := errorCode(t, second); code != CodeIdempotencyConflict {
		t.Fatalf("code = %q", code)
	}
	if got := len(h.store.Requests()); got != 1 {
		t.Fatalf("expected one durable request, got %d", got)
	}
	if got := h.store.OutboxCount(testTenantID); got != 1 {
		t.Fatalf("expected one outbox event, got %d", got)
	}
}

// Every upstream attempt gets its own record; the usage event bills the final
// one.
func TestFailoverRecordsEachAttempt(t *testing.T) {
	var calls int
	h := newHarness(t, harnessOptions{
		MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls++
			if calls == 1 {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, `{"error":{"message":"slow down"}}`)
				return
			}
			w.Header().Set("content-type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		},
		ExtraChannelsFn: func(upstreamURL string) []SnapshotChannel {
			return []SnapshotChannel{{
				ID: "chan_test_2", ProviderID: "prov_openai", Provider: "openai",
				BaseURL: upstreamURL, AuthScheme: "bearer", Models: []string{testModel},
				Region: "global", CredentialMode: "managed", CredentialRef: "cred_test",
				Weight: 5, Capabilities: []string{"text", "streaming"}, Enabled: true,
			}}
		},
	})

	resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.StatusCode, readAll(resp))
	}
	_ = readAll(resp)

	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("records = %d", len(records))
	}
	if len(records[0].Attempts) != 2 {
		t.Fatalf("expected two attempt records, got %d", len(records[0].Attempts))
	}
	if records[0].Attempts[0].ErrorCode != string(provider.ErrRateLimit) {
		t.Fatalf("first attempt error = %q", records[0].Attempts[0].ErrorCode)
	}
	if records[0].Attempts[1].Status != "completed" {
		t.Fatalf("second attempt status = %q", records[0].Attempts[1].Status)
	}
	if records[0].Event.AttemptID != records[0].Attempts[1].AttemptID {
		t.Fatal("usage event must reference the final attempt")
	}
}

// After a response has started there is no switching, even if the stream dies.
func TestNoSwitchAfterUpstreamAcceptance(t *testing.T) {
	var calls int
	h := newHarness(t, harnessOptions{
		MaxAttempts: 2,
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"par\"},\"finish_reason\":null}]}\n\n")
			w.(http.Flusher).Flush()
			// Die mid-stream without a finish or [DONE].
			if hijacker, ok := w.(http.Hijacker); ok {
				conn, _, err := hijacker.Hijack()
				if err == nil {
					_ = conn.Close()
				}
			}
		},
		ExtraChannelsFn: func(upstreamURL string) []SnapshotChannel {
			return []SnapshotChannel{{
				ID: "chan_test_2", ProviderID: "prov_openai", Provider: "openai",
				BaseURL: upstreamURL, AuthScheme: "bearer", Models: []string{testModel},
				Region: "global", CredentialMode: "managed", CredentialRef: "cred_test",
				Weight: 5, Capabilities: []string{"text", "streaming"}, Enabled: true,
			}}
		},
	})
	resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil)
	_ = readAll(resp)

	if calls != 1 {
		t.Fatalf("a second upstream call after acceptance is forbidden; calls = %d", calls)
	}
	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatalf("records = %d", len(records))
	}
	if records[0].Status != string(OutcomeUnknown) {
		t.Fatalf("a stream cut mid-flight must be recorded as unknown, got %q", records[0].Status)
	}
	if !records[0].Event.Usage.Estimated {
		t.Fatal("unknown outcomes must be marked estimated")
	}
}

// ── helpers ───────────────────────────────────────────────────────────

func readAll(resp *http.Response) string {
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return string(raw)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
