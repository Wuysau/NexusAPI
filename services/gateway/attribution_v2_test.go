package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"nexus/gateway/provider"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSignedIdentityFreezesCanonicalKeyFacts(t *testing.T) {
	var key SnapshotKey
	raw := `{"key_id":"key-fixture","tenant_id":"tenant-fixture","organization_id":"org-fixture","enabled":true,"scopes":["*"],"project_id":"project-a","project_name":"A","key_kind":"shared","principal_id":null,"attribution_status":"attributed"}`
	if err := json.Unmarshal([]byte(raw), &key); err != nil {
		t.Fatal(err)
	}
	key.KeyID = testKeyID
	key.TenantID = testTenantID
	key.OrganizationID = testOrgID
	key.HashSHA256 = HashKey(testAPIKey)
	h := newHarness(t, harnessOptions{Keys: []SnapshotKey{key}})
	identity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(identity)
	var facts map[string]any
	_ = json.Unmarshal(data, &facts)
	if facts["KeyKind"] != "shared" || facts["AttributionStatus"] != "attributed" {
		t.Fatalf("signed key facts lost: %s", data)
	}
}

func TestV2CapturesBeforeForwardAndPreservesUnknownUsage(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmtBool(streaming), func(t *testing.T) {
			var h *testHarness
			h = newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				captured := h.store.CapturedRequests()
				if len(captured) != 1 || captured[0].Attribution.APIKeyID != testKeyID {
					t.Error("request identity not durable before provider")
				}
				w.Header().Set("content-type", "text/event-stream")
				_, _ = io.WriteString(w, "data: {\"id\":\"missing\",\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}})
			response := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), nil)
			body := readAll(response)
			if response.StatusCode != 200 {
				t.Fatalf("status=%d %s", response.StatusCode, body)
			}
			records := h.store.Requests()
			if len(records) != 1 {
				t.Fatalf("records=%d", len(records))
			}
			e := records[0].EventV2
			if e == nil || e.Attribution.ProjectId == nil || *e.Attribution.ProjectId != "project-test" || e.Attribution.PrincipalId != nil || e.Attribution.ConnectionId == nil || *e.Attribution.ConnectionId != "connection-test" || e.Streaming != streaming {
				t.Fatalf("wrong frozen event: %+v", e)
			}
			if e.Usage.InputTokens != nil || e.Usage.OutputTokens != nil || e.Usage.TotalTokens != nil || e.Usage.CachedInputTokens != nil || e.Usage.ReasoningTokens != nil {
				t.Fatalf("unknown became observed: %+v", e.Usage)
			}
		})
	}
}
func fmtBool(b bool) string {
	if b {
		return "stream"
	}
	return "nonstream"
}

func TestV2ManagedReservationCarriesFrozenContext(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true})
	updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) {
		priority := 1
		b.Snapshot.RoutingPolicies = []SnapshotRoutingPolicy{{ID: "policy-version-test", Version: 3, ModelRoutes: []SnapshotModelRoute{{ModelID: testModel, Priority: &priority}}}}
	})
	resp := h.doChat(chatBody(chatBodyOptions{Model: "gpt4o"}), nil)
	_ = readAll(resp)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	requests := h.managed.reserveRequests()
	if len(requests) != 1 || requests[0].AttributionContext == nil {
		t.Fatal("missing budget attribution")
	}
	c := requests[0].AttributionContext
	if c.RequestedModel != "gpt4o" || c.APIKeyID != testKeyID || c.PrincipalID != nil {
		t.Fatalf("wrong context %+v", c)
	}
	if c.PolicyVersionID == nil || *c.PolicyVersionID != "policy-version-test" {
		t.Fatal("matched policy not frozen through alias")
	}
	if e := h.store.Requests()[0].EventV2; e == nil || e.RequestedModel != "gpt4o" || e.Attribution.ExecutionMode != "managed" || e.PolicyVersionId == nil || *e.PolicyVersionId != "policy-version-test" {
		t.Fatalf("wrong event %+v", e)
	}
}

func TestV2DefaultOffPreservesV1(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	if resp.StatusCode != 200 || h.store.Requests()[0].EventV2 != nil || h.managed.reserveRequests()[0].AttributionContext != nil {
		t.Fatal("v2 enabled without explicit opt-in")
	}
}

func TestV2RejectsUnknownIdentityAndUnavailableCapture(t *testing.T) {
	for _, kind := range []string{"unknown-project", "shared-principal", "missing-connection", "stale", "storage", "revoked", "deleted"} {
		t.Run(kind, func(t *testing.T) {
			key := SnapshotKey{KeyID: testKeyID, TenantID: testTenantID, OrganizationID: testOrgID, HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeAll}, Enabled: true, ProjectID: "project-test", ProjectName: "A", KeyKind: "shared", AttributionStatus: "attributed"}
			opts := harnessOptions{EnableUsageV2: true, CredentialMode: "byok", Keys: []SnapshotKey{key}, UpstreamHandler: func(http.ResponseWriter, *http.Request) { t.Error("invalid request reached provider") }}
			switch kind {
			case "revoked":
				opts.Keys[0].RevokedAt = nullableString(time.Now().UTC().Format(time.RFC3339))
			case "deleted":
				opts.Keys[0].Enabled = false
			case "unknown-project":
				opts.Keys[0].AttributionStatus = "unknown"
				opts.Keys[0].ProjectID = ""
				opts.Keys[0].ProjectName = ""
			case "shared-principal":
				opts.Keys[0].PrincipalID = nullableString("creator-not-caller")
			case "stale":
				opts.ExpiresIn = -time.Minute
				opts.PlatformExpiresIn = time.Minute
				opts.SnapshotLimits.ByokContinueWhenStale = true
			case "missing-connection":
				opts.ExtraChannelsFn = func(url string) []SnapshotChannel { return nil }
			}
			h := newHarness(t, opts)
			if kind == "missing-connection" {
				updateSignedBundle(t, h, testTenantID, func(b *GatewayBundle) { b.Channels[0].ConnectionID = "" })
			}
			if kind == "storage" {
				h.store.SetHealthy(false)
			}
			resp := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(resp)
			if resp.StatusCode == 200 {
				t.Fatal("request accepted")
			}
			if len(h.store.Requests()) != 0 {
				t.Fatal("rejected request emitted usage")
			}
		})
	}
}

func updateSignedBundle(t *testing.T, h *testHarness, tenant string, change func(*GatewayBundle)) {
	t.Helper()
	h.source.mu.Lock()
	raw := append([]byte(nil), h.source.bundles[tenant]...)
	h.source.mu.Unlock()
	var envelope struct {
		Bundle json.RawMessage `json:"bundle"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	var b GatewayBundle
	if err := json.Unmarshal(envelope.Bundle, &b); err != nil {
		t.Fatal(err)
	}
	change(&b)
	b.SequenceNumber++
	b.Snapshot.SequenceNumber++
	signed := signBundleForTest(t, h.keyring, &b)
	h.source.mu.Lock()
	h.source.bundles[tenant] = signed
	h.source.mu.Unlock()
	state, err := h.snapshots.fetchAndVerify(context.Background(), tenant)
	if err != nil {
		t.Fatal(err)
	}
	h.snapshots.entryFor(tenant).state.Store(state)
}

func TestV2StreamingKeyMoveAffectsOnlyNextRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-started:
		default:
			close(started)
			<-release
		}
		defaultUpstreamHandler()(w, r)
	}})
	done := make(chan string, 1)
	go func() { resp := h.doChat(chatBody(chatBodyOptions{Stream: true}), nil); done <- readAll(resp) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not reached")
	}
	updateSignedBundle(t, h, "", func(b *GatewayBundle) { b.Keys[0].ProjectID = "project-b"; b.Keys[0].ProjectName = "B" })
	close(release)
	if body := <-done; !strings.Contains(body, "Hello") {
		t.Fatal(body)
	}
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	projects := map[string]int{}
	for _, r := range h.store.Requests() {
		projects[*r.EventV2.Attribution.ProjectId]++
	}
	if projects["project-test"] != 1 || projects["project-b"] != 1 {
		t.Fatalf("key move reinterpreted active request: %v", projects)
	}
}

func TestV2NextRequestFailoverUsesActualConnection(t *testing.T) {
	var calls atomic.Int64
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"code":"insufficient_quota"}}`)
			return
		}
		defaultUpstreamHandler()(w, r)
	}, ExtraChannelsFn: func(url string) []SnapshotChannel {
		return []SnapshotChannel{{ID: "retry-channel", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global", CredentialMode: "byok", CredentialRef: "retry-credential", ConnectionID: "retry-connection", Weight: 1, Priority: 1, Capabilities: []string{"text", "streaming"}, Enabled: true}}
	}})
	first := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(first)
	if calls.Load() != 1 {
		t.Fatalf("quota failure replayed current request: %d calls", calls.Load())
	}
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	body := readAll(resp)
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d %s", resp.StatusCode, body)
	}
	var r *TerminalRecord
	for _, record := range h.store.Requests() {
		if record.Status == string(OutcomeCompleted) {
			r = record
		}
	}
	if r == nil {
		t.Fatal("missing completed fallback request")
	}
	if len(r.Attempts) != 1 || r.EventV2 == nil || *r.EventV2.Attribution.ConnectionId != "retry-connection" || *r.EventV2.Attribution.ChannelId != "retry-channel" || *r.EventV2.Attribution.CredentialId != "retry-credential" {
		t.Fatalf("retry routing mismatch: %+v", r)
	}
	if len(h.store.CapturedRequests()) != 2 {
		t.Fatal("separate requests did not capture separate identities")
	}
}

func TestV2TerminalFailureLeavesCapturedIdentity(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	h.store.FailNext()
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	if resp.StatusCode == 200 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 || len(h.store.CapturedRequests()) != 1 {
		t.Fatal("failed terminal lost capture or published a partial outbox")
	}
}

func TestV2FailureRetainsUnknownCountsAndAttempt(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	records := h.store.Requests()
	if len(records) != 1 {
		t.Fatal("failure usage missing")
	}
	e := records[0].EventV2
	if e.Status != "failed" || e.Usage.InputTokens != nil || e.Usage.OutputTokens != nil || e.AttemptId != records[0].Attempts[0].AttemptID {
		t.Fatalf("failure facts=%+v", e)
	}
}

func TestV2ObservedZeroRemainsKnownAndSubsetsRemainUnknown(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"observed-zero\",\"choices\":[],\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":0,\"total_tokens\":0}}\n\ndata: [DONE]\n\n")
	}})
	resp := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(resp)
	e := h.store.Requests()[0].EventV2
	if e.Usage.InputTokens == nil || *e.Usage.InputTokens != 0 || e.Usage.OutputTokens == nil || *e.Usage.OutputTokens != 0 || e.Usage.TotalTokens == nil || *e.Usage.TotalTokens != 0 || e.Usage.CachedInputTokens != nil || e.Usage.ReasoningTokens != nil {
		t.Fatalf("zero/unknown lost: %+v", e.Usage)
	}
}

func TestV2InvalidProviderUsagePersistsUnknownReconciliationFact(t *testing.T) {
	for _, wire := range []string{`{"prompt_tokens":-1,"completion_tokens":2}`, `{"prompt_tokens":1,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}`, `{"prompt_tokens":1,"completion_tokens":2,"total_tokens":9}`, `{"prompt_tokens":2147483648,"completion_tokens":2}`} {
		t.Run(wire, func(t *testing.T) {
			h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", "text/event-stream")
				_, _ = io.WriteString(w, "data: {\"id\":\"badusage\",\"choices\":[],\"usage\":"+wire+"}\n\ndata: [DONE]\n\n")
			}})
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(response)
			records := h.store.Requests()
			if len(records) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("invalid provider usage lost terminal fact")
			}
			r := records[0]
			if r.EventV2.Status != "unknown" || r.ErrorCode != "invalid_provider_usage" || r.EventV2.Usage.InputTokens != nil || r.EventV2.Usage.OutputTokens != nil || r.EventV2.Usage.TotalTokens != nil {
				t.Fatalf("not reconciliation fact: %+v", r)
			}
		})
	}
}

func TestV2CanonicalContextLimitsRejectBeforeCapture(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(http.ResponseWriter, *http.Request) { t.Error("invalid context reached provider") }})
	updateSignedBundle(t, h, "", func(b *GatewayBundle) { b.Keys[0].ProjectName = strings.Repeat("a", 257) })
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if response.StatusCode == 200 || len(h.store.CapturedRequests()) != 0 {
		t.Fatal("invalid context was captured")
	}
}

func TestV2RejectsTerminalConnectionTamper(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	r := h.store.Requests()[0]
	r.EventV2.Attribution.ConnectionId = nullableString("another-connection")
	if err := r.Validate(); err == nil {
		t.Fatal("terminal connection can be rebound")
	}
}

type rejectingAttemptStore struct{ *MemoryStore }

func (s *rejectingAttemptStore) CaptureAttempt(context.Context, string, string, *AttemptRecord) error {
	return ErrStoreUnavailable
}
func TestV2AttemptCaptureFailureNeverDispatches(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok", UpstreamHandler: func(http.ResponseWriter, *http.Request) { t.Error("uncaptured attempt dispatched") }})
	h.proxy.store = &rejectingAttemptStore{h.store}
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if response.StatusCode != 503 || len(h.store.CapturedRequests()) != 1 || h.store.OutboxCount(testTenantID) != 0 {
		t.Fatal("capture failure lost request or published invented attempt")
	}
}

func TestV2TerminalLogContainsOnlyStableAttribution(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	var buffer bytes.Buffer
	h.proxy.logger = slog.New(slog.NewJSONHandler(&buffer, nil))
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	var log map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buffer.Bytes()), &log); err != nil {
		t.Fatal(err)
	}
	if log["project_id"] != "project-test" || log["request_id"] == "" || log["trace_id"] == "" || log["tenant_id"] != testTenantID {
		t.Fatalf("uncorrelated log %v", log)
	}
	if strings.Contains(buffer.String(), testAPIKey) || strings.Contains(buffer.String(), "Project Test") {
		t.Fatal("sensitive/display identity leaked to logs")
	}
}

func TestV2PartialProviderUsageCannotHideInvalidLegacyProjection(t *testing.T) {
	for _, tc := range []struct {
		name    string
		adapter provider.Adapter
		body    string
	}{
		{"anthropic negative", provider.NewAnthropic(), `{"usage":{"input_tokens":-1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}`},
		{"anthropic partial overflow", provider.NewAnthropic(), `{"usage":{"input_tokens":2147483648,"output_tokens":2}}`},
		{"gemini partial negative", provider.NewGemini(), `{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":-1}}`},
		{"gemini partial overflow", provider.NewGemini(), `{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2147483648}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
			ctx := context.Background()
			state, err := h.snapshots.Get(ctx, testTenantID)
			if err != nil {
				t.Fatal(err)
			}
			bundle := state.Verified.Bundle
			identity, err := h.proxy.authn.Authenticate(ctx, testAPIKey, ScopeChatWrite)
			if err != nil {
				t.Fatal(err)
			}
			usage := tc.adapter.ParseUsage(&provider.ProviderResult{Body: []byte(tc.body)})
			if usage == nil {
				t.Fatal("provider fixture did not parse")
			}
			model, _ := bundle.ResolveModel(testModel)
			channel := &bundle.Channels[0]
			candidate := Candidate{Channel: channel, Price: bundle.LookupPrice(channel.Provider, model.ID, channel.Region)}
			result := &attemptResult{outcome: OutcomeCompleted, usage: *usage, channel: channel, attempts: []AttemptRecord{h.proxy.completedAttempt(candidate, 1, time.Now(), usage, "completed")}}
			record := h.proxy.buildTerminalRecord(result, &routedCredentials{channel: channel}, bundle, model, &chatRequest{Model: testModel}, identity, "partial-provider-request", time.Now(), nil, "")
			if err := h.store.PersistTerminal(ctx, record); err != nil {
				t.Fatalf("invalid legacy projection dropped terminal: %v", err)
			}
			if record.Status != "unknown" || record.EventV2.Usage.InputTokens != nil || record.EventV2.Usage.OutputTokens != nil || record.InputTokens != 0 || record.OutputTokens != 0 {
				t.Fatalf("unsafe projection not normalized: %+v", record)
			}
		})
	}
}

func TestVersionedProviderProjectionMatchesInclusiveObservations(t *testing.T) {
	for _, tc := range []struct {
		name                                     string
		adapter                                  provider.Adapter
		body                                     string
		input, output, legacyInput, legacyOutput int
	}{
		{"anthropic", provider.NewAnthropic(), `{"usage":{"input_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":2}}`, 9, 2, 4, 2},
		{"gemini", provider.NewGemini(), `{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"thoughtsTokenCount":3,"cachedContentTokenCount":0,"totalTokenCount":9}}`, 4, 5, 4, 2},
	} {
		for _, v2 := range []bool{false, true} {
			t.Run(tc.name+fmtBool(v2), func(t *testing.T) {
				h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok"})
				ctx := context.Background()
				state, err := h.snapshots.Get(ctx, testTenantID)
				if err != nil {
					t.Fatal(err)
				}
				bundle := state.Verified.Bundle
				identity, err := h.proxy.authn.Authenticate(ctx, testAPIKey, ScopeChatWrite)
				if err != nil {
					t.Fatal(err)
				}
				usage := tc.adapter.ParseUsage(&provider.ProviderResult{Body: []byte(tc.body)})
				if usage == nil {
					t.Fatal("provider fixture did not parse")
				}
				model, _ := bundle.ResolveModel(testModel)
				channel := &bundle.Channels[0]
				candidate := Candidate{Channel: channel, Price: bundle.LookupPrice(channel.Provider, model.ID, channel.Region)}
				result := &attemptResult{outcome: OutcomeCompleted, usage: *usage, channel: channel, attempts: []AttemptRecord{h.proxy.completedAttempt(candidate, 1, time.Now(), usage, "completed")}}
				r := h.proxy.buildTerminalRecord(result, &routedCredentials{channel: channel}, bundle, model, &chatRequest{Model: testModel}, identity, "provider-projection-request", time.Now(), nil, "")
				wantInput, wantOutput := tc.legacyInput, tc.legacyOutput
				if v2 {
					wantInput, wantOutput = tc.input, tc.output
				}
				if r.InputTokens != wantInput || r.OutputTokens != wantOutput || r.Attempts[0].InputTokens != wantInput || r.Attempts[0].OutputTokens != wantOutput || r.Event.Usage.InputTokens != wantInput || r.Event.Usage.OutputTokens != wantOutput {
					t.Fatalf("SQL projection differs from selected calculator: request=%d/%d attempt=%d/%d want=%d/%d", r.InputTokens, r.OutputTokens, r.Attempts[0].InputTokens, r.Attempts[0].OutputTokens, wantInput, wantOutput)
				}
				if err := r.Validate(); err != nil {
					t.Fatal(err)
				}
				if v2 && tc.name == "anthropic" {
					if r.EventV2.Usage.Semantics != "anthropic-inclusive-v1" || r.EventV2.Usage.CacheCreationInputTokens == nil || *r.EventV2.Usage.CacheCreationInputTokens != 3 || r.EventV2.Usage.ReasoningTokens != nil {
						t.Fatal("Anthropic observations or billing semantics lost at event boundary")
					}
				}
			})
		}
	}
}
