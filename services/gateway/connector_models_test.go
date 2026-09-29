package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func catalogChannel(index, count int) (SnapshotChannel, []SnapshotModel) {
	channel := SnapshotChannel{ID: fmt.Sprintf("catalog-channel-%d", index), ConnectionID: fmt.Sprintf("catalog-connection-%d", index), TenantID: testTenantID, ProjectID: "project-test", ProviderID: "ollama-provider", Provider: "ollama", Protocol: "openai", Transport: "local_sidecar", BaseURL: "https://connector.invalid/v1", CredentialMode: "byok", CredentialRef: "catalog-credential", Enabled: true, Capabilities: []string{"text", "streaming"}}
	var models []SnapshotModel
	for i := range count {
		id := fmt.Sprintf("ollama/model-%d-%d", index, i)
		channel.Models = append(channel.Models, id)
		models = append(models, SnapshotModel{ID: id, Provider: "ollama", Status: "active", Capabilities: []string{"text", "streaming"}})
	}
	return channel, models
}

func catalogGrant(connection string, models []string) connectorGrant {
	return connectorGrant{LeaseID: "lease-" + connection, ConnectorID: "identity-" + connection, ConnectionID: connection, TenantID: testTenantID, ExpiresAt: time.Now().Add(time.Minute), Models: models}
}

func attachCatalogHub(t *testing.T, h *testHarness, channels []SnapshotChannel, handler http.HandlerFunc) *ConnectorHub {
	t.Helper()
	cp := httptest.NewServer(handler)
	t.Cleanup(cp.Close)
	hub := NewConnectorHub(cp.URL, "synthetic-gateway-token")
	for _, channel := range channels {
		hub.sessions[channel.ConnectionID] = &connectorSession{token: "nxlease_" + channel.ConnectionID, grant: catalogGrant(channel.ConnectionID, channel.Models), polling: 1, seen: time.Now()}
	}
	h.proxy.connectors = hub
	return hub
}

func getCatalog(t *testing.T, h *testHarness) []string {
	t.Helper()
	r, _ := http.NewRequest(http.MethodGet, h.server.URL+"/v1/models", nil)
	r.Header.Set("authorization", "Bearer "+testAPIKey)
	res, err := h.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&payload) != nil {
		t.Fatalf("invalid catalog response: %d", res.StatusCode)
	}
	ids := make([]string, 0, len(payload.Data))
	for _, model := range payload.Data {
		ids = append(ids, model.ID)
	}
	return ids
}

func TestCatalogBatches64ModelsInOneLiveAuthorization(t *testing.T) {
	channel, models := catalogChannel(0, 64)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models, UpstreamHandler: func(http.ResponseWriter, *http.Request) { t.Error("catalog executed an upstream model request") }})
	var calls atomic.Int32
	attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input connectorAuth
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Model != "" || input.Transport || input.Scope != ScopeModelsRead || input.TenantID != testTenantID ||
			input.ProjectID != channel.ProjectID || input.OrganizationID != testOrgID || input.KeyID != testKeyID ||
			input.ChannelID != channel.ID || input.ConnectionID != channel.ConnectionID || len(input.RequestedModels) != 64 {
			t.Error("catalog batch omitted an identity binding or widened its operation")
		}
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, input.RequestedModels))
	})
	if ids := getCatalog(t, h); len(ids) != 64 || calls.Load() != 1 {
		t.Fatalf("same connector models were not batched: models=%d control_calls=%d", len(ids), calls.Load())
	}
	if len(h.store.Requests()) != 0 || h.managed.reserveCount() != 0 {
		t.Fatal("model discovery produced accounting or budget events")
	}
}

func TestCatalogChunksLargerSignedCandidateSets(t *testing.T) {
	channel, models := catalogChannel(0, 130)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
	var calls atomic.Int32
	var mu sync.Mutex
	seen := map[string]bool{}
	attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input connectorAuth
		_ = json.NewDecoder(r.Body).Decode(&input)
		if len(input.RequestedModels) < 1 || len(input.RequestedModels) > 64 {
			t.Errorf("batch size escaped protocol limit: %d", len(input.RequestedModels))
		}
		mu.Lock()
		for _, model := range input.RequestedModels {
			if seen[model] {
				t.Error("one channel/model was duplicated across batches")
			}
			seen[model] = true
		}
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, input.RequestedModels))
	})
	if ids := getCatalog(t, h); len(ids) != 130 || calls.Load() != 3 {
		t.Fatalf("oversized candidate set was lost or sent unbounded: models=%d calls=%d", len(ids), calls.Load())
	}
}

func TestCatalogBatchesHaveSharedDeadlineAndBoundedConcurrency(t *testing.T) {
	var channels []SnapshotChannel
	var models []SnapshotModel
	for i := range 9 {
		channel, entries := catalogChannel(i, 1)
		channels = append(channels, channel)
		models = append(models, entries...)
	}
	h := newHarness(t, harnessOptions{Channels: channels, Models: models})
	var calls, active, peak atomic.Int32
	canceled := make(chan struct{}, 9)
	attachCatalogHub(t, h, channels, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		var input connectorAuth
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.ChannelID == channels[0].ID {
			_ = json.NewEncoder(w).Encode(catalogGrant(input.ConnectionID, input.RequestedModels))
			return
		}
		<-r.Context().Done()
		canceled <- struct{}{}
	})
	started := time.Now()
	ids := getCatalog(t, h)
	elapsed := time.Since(started)
	if !slices.Equal(ids, channels[0].Models) || peak.Load() != 4 || calls.Load() > 5 || elapsed < 4*time.Second || elapsed > 7*time.Second {
		t.Fatalf("catalog I/O was not bounded or lost a healthy partial result: ids=%v peak=%d calls=%d elapsed=%v", ids, peak.Load(), calls.Load(), elapsed)
	}
	for range calls.Load() - 1 {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("unfinished CP authorization outlived the catalog deadline")
		}
	}
}

func TestCatalogClientCancellationStopsBatchWorkers(t *testing.T) {
	channel, models := catalogChannel(0, 1)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
	started, canceled := make(chan struct{}), make(chan struct{})
	attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(canceled)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/v1/models", nil).WithContext(ctx)
	r.Header.Set("authorization", "Bearer "+testAPIKey)
	done := make(chan struct{})
	go func() { h.proxy.ServeModels(httptest.NewRecorder(), r); close(done) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("batch was not dispatched")
	}
	cancel()
	for _, finished := range []<-chan struct{}{done, canceled} {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("client cancellation did not join catalog work")
		}
	}
}

func TestCatalogPartialAuthorizationAndNoCrossRequestCache(t *testing.T) {
	channel, models := catalogChannel(0, 3)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
	var calls atomic.Int32
	attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) > 1 {
			http.Error(w, "revoked private-key", http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, []string{channel.Models[1], "unsolicited-model"}))
	})
	if got := getCatalog(t, h); !slices.Equal(got, []string{channel.Models[1]}) {
		t.Fatalf("unready/unsolicited models escaped batch intersection: %v", got)
	}
	if got := getCatalog(t, h); len(got) != 0 || calls.Load() != 2 {
		t.Fatalf("revocation was hidden by cross-request caching: models=%v calls=%d", got, calls.Load())
	}
}

func TestCatalogFiltersRouterConstraintsBeforeBatch(t *testing.T) {
	channel, models := catalogChannel(0, 3)
	foreignProject, projectModels := catalogChannel(1, 1)
	foreignProject.ProjectID = "other-project"
	foreignTenant, tenantModels := catalogChannel(2, 1)
	foreignTenant.TenantID = "other-tenant"
	disabled, disabledModels := catalogChannel(3, 1)
	disabled.Enabled = false
	models[2].Status = "disabled"
	channels := []SnapshotChannel{channel, foreignProject, foreignTenant, disabled}
	models = append(models, projectModels...)
	models = append(models, tenantModels...)
	models = append(models, disabledModels...)
	h := newHarness(t, harnessOptions{Channels: channels, Models: models})
	h.breaker.Cooldown(BreakerKey(channel.ID, channel.Models[1]), time.Minute)
	var calls atomic.Int32
	attachCatalogHub(t, h, channels, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input connectorAuth
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.ChannelID != channel.ID || !slices.Equal(input.RequestedModels, channel.Models[:1]) {
			t.Errorf("hard-filtered candidate was sent for authorization: %+v", input.RequestedModels)
		}
		// Even a CP returning too much cannot restore the filtered models.
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, channel.Models))
	})
	if got := getCatalog(t, h); !slices.Equal(got, channel.Models[:1]) || calls.Load() != 1 {
		t.Fatalf("batch bypassed project/tenant/status/breaker routing: %v calls=%d", got, calls.Load())
	}
}

func TestCatalogDirectProviderFallbackNeedsNoConnectorAuthorization(t *testing.T) {
	channel, models := catalogChannel(0, 1)
	direct := channel
	direct.ID, direct.Transport, direct.Protocol = "direct-channel", "", "openai"
	direct.BaseURL = "https://provider.example.invalid/v1"
	channels := []SnapshotChannel{channel, direct}
	h := newHarness(t, harnessOptions{Channels: channels, Models: models})
	var calls atomic.Int32
	attachCatalogHub(t, h, channels[:1], func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Error(w, "unavailable", 503) })
	if got := getCatalog(t, h); !slices.Equal(got, channel.Models) || calls.Load() != 0 {
		t.Fatalf("direct-provider availability changed: ids=%v calls=%d", got, calls.Load())
	}
}

func TestCatalogDuplicateIDDoesNotRestoreDisabledEntry(t *testing.T) {
	channel, models := catalogChannel(0, 1)
	disabled := models[0]
	disabled.Provider = "other-provider"
	disabled.Status = "deprecated"
	models = append(models, disabled)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
	attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, channel.Models))
	})
	if got := getCatalog(t, h); !slices.Equal(got, channel.Models) {
		t.Fatalf("an active entry restored an inactive entry sharing its ID: %v", got)
	}
}

func TestCatalogRejectsInvalidGrantsAndLegacyAuthorization(t *testing.T) {
	channel, models := catalogChannel(0, 1)
	for _, tc := range []struct {
		name string
		edit func(*connectorGrant)
		raw  string
	}{
		{name: "wrong tenant", edit: func(g *connectorGrant) { g.TenantID = "other" }},
		{name: "wrong connection", edit: func(g *connectorGrant) { g.ConnectionID = "other" }},
		{name: "wrong connector", edit: func(g *connectorGrant) { g.ConnectorID = "other" }},
		{name: "wrong lease", edit: func(g *connectorGrant) { g.LeaseID = "other" }},
		{name: "expired lease", edit: func(g *connectorGrant) { g.ExpiresAt = time.Now().Add(-time.Second) }},
		{name: "missing fields", raw: `{}`},
		{name: "trailing JSON", raw: `trailing`},
		{name: "oversized body", raw: `oversized`},
		{name: "legacy CP", raw: `legacy`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
			var calls atomic.Int32
			attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				grant := catalogGrant(channel.ConnectionID, channel.Models)
				if tc.edit != nil {
					tc.edit(&grant)
				}
				if tc.raw == "legacy" {
					http.Error(w, "batch unsupported", http.StatusForbidden)
					return
				}
				if tc.raw == "{}" {
					_, _ = io.WriteString(w, tc.raw)
					return
				}
				_ = json.NewEncoder(w).Encode(grant)
				if tc.raw == "trailing" {
					_, _ = io.WriteString(w, `{}`)
				} else if tc.raw == "oversized" {
					_, _ = io.WriteString(w, strings.Repeat(" ", 16385))
				}
			})
			if got := getCatalog(t, h); len(got) != 0 || calls.Load() != 1 {
				t.Fatalf("invalid grant accepted or fell back to single-model calls: %v calls=%d", got, calls.Load())
			}
		})
	}
}

func TestCatalogGrantCannotOutliveLeaseOrTokenRotation(t *testing.T) {
	for _, rotate := range []bool{false, true} {
		t.Run(fmt.Sprint("rotation=", rotate), func(t *testing.T) {
			channel, models := catalogChannel(0, 1)
			h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
			var hub *ConnectorHub
			hub = attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
				hub.mu.Lock()
				if rotate {
					hub.sessions[channel.ConnectionID].token = "nxlease_replacement"
				} else {
					hub.sessions[channel.ConnectionID].grant.ExpiresAt = time.Now().Add(-time.Second)
				}
				hub.mu.Unlock()
				_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, channel.Models))
			})
			if got := getCatalog(t, h); len(got) != 0 {
				t.Fatalf("grant for obsolete local session was accepted: %v", got)
			}
		})
	}
}

type catalogSourceFunc func(context.Context, string) ([]byte, error)

func (f catalogSourceFunc) Fetch(ctx context.Context, tenant string) ([]byte, error) {
	return f(ctx, tenant)
}

type catalogTransportFunc func(*http.Request) (*http.Response, error)

func (f catalogTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCatalogIdentitySnapshotAndBatchShareOneDeadline(t *testing.T) {
	channel, models := catalogChannel(0, 1)
	h := newHarness(t, harnessOptions{Channels: []SnapshotChannel{channel}, Models: models})
	var mu sync.Mutex
	deadlines := make(map[string]time.Time)
	record := func(ctx context.Context, phase string) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > catalogTimeout {
			t.Errorf("%s has no catalog deadline", phase)
		}
		mu.Lock()
		deadlines[phase] = deadline
		mu.Unlock()
	}
	source := catalogSourceFunc(func(ctx context.Context, tenant string) ([]byte, error) {
		record(ctx, "snapshot:"+tenant)
		return h.source.Fetch(ctx, tenant)
	})
	cache := NewSnapshotCache(source, h.keyring, SnapshotConfig{FetchTimeout: time.Minute, MaxAge: time.Minute}, h.proxy.logger)
	h.proxy.snapshots = cache
	h.proxy.authn = NewAuthenticator(cache)
	hub := attachCatalogHub(t, h, []SnapshotChannel{channel}, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(catalogGrant(channel.ConnectionID, channel.Models))
	})
	hub.client.Transport = catalogTransportFunc(func(r *http.Request) (*http.Response, error) {
		record(r.Context(), "live-authorization")
		return http.DefaultTransport.RoundTrip(r)
	})
	if got := getCatalog(t, h); len(got) != 1 {
		t.Fatal("catalog fixture failed")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deadlines) != 3 || deadlines["snapshot:"] != deadlines["snapshot:"+testTenantID] || deadlines["snapshot:"] != deadlines["live-authorization"] {
		t.Fatalf("catalog phases reset the deadline: %v", deadlines)
	}
}
