package connectorclient

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var checkPaths = [3]string{"/api/health", "/readyz", "/v1/models"}
var checkBodies = [3]string{`{"ok":true}`, `{"status":"ready","checks":{"snapshot":true,"database":true,"redis":false},"admission_mode":"local"}`, `{"data":[{"id":"beta"},{"id":"unconfigured-private-model"},{"id":"alpha"}]}`}

const checkLocalKey = "upstream-test-secret"

type checkFixture struct {
	client *Client
	calls  [3]atomic.Int32
	config Config
	lease  lease
}

func newCheckFixture(t *testing.T, handlers [3]http.HandlerFunc) *checkFixture {
	t.Helper()
	t.Setenv("NEXUS_CONNECTOR_CHECK_TEST_KEY", checkLocalKey)
	f := &checkFixture{}
	var origins [3]string
	for stage := range handlers {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			f.calls[stage].Add(1)
			if r.Method != http.MethodGet || r.URL.Path != checkPaths[stage] || r.URL.RawQuery != "" {
				t.Error("check escaped its fixed GET endpoint")
			}
			body, err := io.ReadAll(r.Body)
			if err != nil || len(body) != 0 {
				t.Error("check sent a request body")
			}
			wantAuth := ""
			if stage == 2 {
				wantAuth = "Bearer " + checkLocalKey
			}
			if r.Header.Get("Authorization") != wantAuth {
				t.Error("check authorization crossed the local upstream boundary")
			}
			w.Header().Set("X-Private-Check", "private-check-header")
			if handlers[stage] != nil {
				handlers[stage](w, r)
				return
			}
			_, _ = io.WriteString(w, checkBodies[stage])
		}))
		t.Cleanup(server.Close)
		origins[stage] = server.URL
	}
	cfg := configFixture()
	cfg.ControlURL, cfg.GatewayURL, cfg.UpstreamURL = origins[0], origins[1], origins[2]+"/v1"
	cfg.Models, cfg.APIKeyEnv, cfg.AllowHTTPDevelopment = []string{"alpha", "beta"}, "NEXUS_CONNECTOR_CHECK_TEST_KEY", true
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.remote.CloseIdleConnections)
	t.Cleanup(client.local.CloseIdleConnections)
	f.client, f.config = client, client.config
	f.config.Models = append([]string(nil), client.config.Models...)
	f.lease = lease{Token: "private-check-lease", ExpiresAt: time.Now().Add(time.Hour)}
	client.lease = f.lease
	return f
}

func assertCheckResult(t *testing.T, f *checkFixture, result CheckResult, statuses [3]string, available [2]bool) {
	t.Helper()
	actual := [3]string{string(result.ControlPlane), string(result.Gateway), string(result.Upstream)}
	if actual != statuses {
		t.Errorf("stage codes = %v, want %v", actual, statuses)
	}
	wantModels := []ModelCheck{{ID: "alpha", Available: available[0]}, {ID: "beta", Available: available[1]}}
	if !reflect.DeepEqual(result.Models, wantModels) {
		t.Errorf("configured model availability = %v, want %v", result.Models, wantModels)
	}
	wantOK := statuses == [3]string{"ok", "ok", "ok"} && available == [2]bool{true, true}
	if result.OK != wantOK {
		t.Errorf("overall OK = %v, want %v", result.OK, wantOK)
	}
	if !reflect.DeepEqual(f.client.config, f.config) || f.client.currentLease() != f.lease {
		t.Error("check mutated configuration or an existing lease")
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{checkLocalKey, f.lease.Token, "private-check-header", "private-check-body", "unconfigured-private-model", f.config.ControlURL, f.config.GatewayURL, f.config.UpstreamURL} {
		if strings.Contains(string(raw), private) {
			t.Error("check retained private response data, a credential, or an endpoint")
		}
	}
}

func assertCheckCalls(t *testing.T, f *checkFixture, want int32) {
	t.Helper()
	for stage := range f.calls {
		if got := f.calls[stage].Load(); got != want {
			t.Errorf("check stage %d made %d HTTP calls, want %d", stage, got, want)
		}
	}
}

func TestCheckParallelFixedGETsWithoutLeaseMutation(t *testing.T) {
	started := make(chan int, 3)
	release := make(chan struct{})
	var handlers [3]http.HandlerFunc
	for stage := range handlers {
		handlers[stage] = func(w http.ResponseWriter, r *http.Request) {
			started <- stage
			select {
			case <-release:
				_, _ = io.WriteString(w, checkBodies[stage])
			case <-r.Context().Done():
			}
		}
	}
	f := newCheckFixture(t, handlers)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan CheckResult, 1)
	go func() { done <- f.client.Check(ctx) }()
	for range 3 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("three probes did not start concurrently")
		}
	}
	close(release)
	select {
	case result := <-done:
		assertCheckResult(t, f, result, [3]string{"ok", "ok", "ok"}, [2]bool{true, true})
	case <-ctx.Done():
		t.Fatal("healthy check did not return")
	}
	assertCheckCalls(t, f, 1)
}

func TestCheckCompleteBoundedJSONAndModelAvailability(t *testing.T) {
	tests := []struct {
		name      string
		stage     int
		body      string
		status    string
		available [2]bool
	}{
		{name: "control_exact_limit", body: `{"ok":true}` + strings.Repeat(" ", 16384-len(`{"ok":true}`)), status: "ok", available: [2]bool{true, true}},
		{name: "control_over_limit", body: `{"ok":true}` + strings.Repeat(" ", 16385-len(`{"ok":true}`)), status: "invalid_response", available: [2]bool{true, true}},
		{name: "control_false", body: `{"ok":false,"detail":"private-check-body"}`, status: "not_ready", available: [2]bool{true, true}},
		{name: "control_missing", body: `{}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "control_null", body: `{"ok":null}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "control_wrong_type", body: `{"ok":"true"}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "control_trailing_value", body: `{"ok":true}{"ok":true}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "gateway_not_ready", stage: 1, body: `{"status":"not_ready"}`, status: "not_ready", available: [2]bool{true, true}},
		{name: "gateway_unknown_status", stage: 1, body: `{"status":"starting"}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "gateway_missing", stage: 1, body: `{}`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "gateway_truncated", stage: 1, body: `{"status":"ready"`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "gateway_trailing_junk", stage: 1, body: `{"status":"ready"}private-check-body`, status: "invalid_response", available: [2]bool{true, true}},
		{name: "models_exact_limit", stage: 2, body: checkBodies[2] + strings.Repeat(" ", (1<<20)-len(checkBodies[2])), status: "ok", available: [2]bool{true, true}},
		{name: "models_over_limit", stage: 2, body: checkBodies[2] + strings.Repeat(" ", (1<<20)+1-len(checkBodies[2])), status: "invalid_response"},
		{name: "models_missing_one", stage: 2, body: `{"data":[{"id":"alpha"},{"id":"unconfigured-private-model"}]}`, status: "ok", available: [2]bool{true, false}},
		{name: "models_empty", stage: 2, body: `{"data":[]}`, status: "ok"},
		{name: "models_absent", stage: 2, body: `{}`, status: "invalid_response"},
		{name: "models_null", stage: 2, body: `{"data":null}`, status: "invalid_response"},
		{name: "models_wrong_type", stage: 2, body: `{"data":[{"id":4}]}`, status: "invalid_response"},
		{name: "models_trailing_value", stage: 2, body: checkBodies[2] + `{}`, status: "invalid_response"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var handlers [3]http.HandlerFunc
			handlers[tc.stage] = func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, tc.body) }
			f := newCheckFixture(t, handlers)
			statuses := [3]string{"ok", "ok", "ok"}
			statuses[tc.stage] = tc.status
			assertCheckResult(t, f, f.client.Check(context.Background()), statuses, tc.available)
			assertCheckCalls(t, f, 1)
			if tc.stage == 2 {
				want := []string{}
				for index, available := range tc.available {
					if available {
						want = append(want, f.config.Models[index])
					}
				}
				if got := f.client.readyModels(context.Background()); !reflect.DeepEqual(got, want) {
					t.Errorf("existing model discovery changed: %v, want %v", got, want)
				}
			}
		})
	}
}

func TestCheckHTTPFailuresAndRedirectPrivacy(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	for _, tc := range []struct {
		name          string
		stage, status int
		want          string
	}{
		{"control_unauthorized", 0, 401, "unauthorized"}, {"gateway_forbidden", 1, 403, "unauthorized"},
		{"upstream_unauthorized", 2, 401, "unauthorized"}, {"control_not_ready", 0, 503, "not_ready"},
		{"gateway_not_ready", 1, 503, "not_ready"}, {"upstream_unavailable", 2, 503, "unavailable"},
		{"control_redirect", 0, 302, "unavailable"}, {"gateway_redirect", 1, 302, "unavailable"}, {"upstream_redirect", 2, 302, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var handlers [3]http.HandlerFunc
			handlers[tc.stage] = func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", target.URL+"/private-check-header")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, "private-check-body")
			}
			f := newCheckFixture(t, handlers)
			statuses, available := [3]string{"ok", "ok", "ok"}, [2]bool{true, true}
			statuses[tc.stage] = tc.want
			if tc.stage == 2 {
				available = [2]bool{}
			}
			assertCheckResult(t, f, f.client.Check(context.Background()), statuses, available)
			assertCheckCalls(t, f, 1)
		})
	}
	if redirected.Load() != 0 {
		t.Error("check followed a redirect")
	}
}

func TestCheckPreAbortedContextsMakeNoRequests(t *testing.T) {
	for _, canceled := range []bool{true, false} {
		name, status := "expired_deadline", "timeout"
		if canceled {
			name, status = "canceled", "canceled"
		}
		t.Run(name, func(t *testing.T) {
			f := newCheckFixture(t, [3]http.HandlerFunc{})
			var ctx context.Context
			var cancel context.CancelFunc
			if canceled {
				ctx, cancel = context.WithCancel(context.Background())
				cancel()
			} else {
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			}
			defer cancel()
			assertCheckResult(t, f, f.client.Check(ctx), [3]string{status, status, status}, [2]bool{})
			assertCheckCalls(t, f, 0)
		})
	}
}

func TestCheckCancellationClosesStalledBodies(t *testing.T) {
	started, ended := make(chan struct{}, 3), make(chan struct{}, 3)
	var handlers [3]http.HandlerFunc
	for stage := range handlers {
		handlers[stage] = func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, checkBodies[stage])
			w.(http.Flusher).Flush()
			started <- struct{}{}
			<-r.Context().Done()
			ended <- struct{}{}
		}
	}
	f := newCheckFixture(t, handlers)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan CheckResult, 1)
	go func() { done <- f.client.Check(ctx) }()
	for range 3 {
		awaitNetworkSignal(t, started, "stalled check body")
	}
	select {
	case <-done:
		t.Fatal("check accepted a JSON prefix before body completion")
	default:
	}
	cancel()
	select {
	case result := <-done:
		assertCheckResult(t, f, result, [3]string{"canceled", "canceled", "canceled"}, [2]bool{})
	case <-time.After(2 * time.Second):
		t.Fatal("check did not return after cancellation")
	}
	for range 3 {
		awaitNetworkSignal(t, ended, "closed check body")
	}
}

func TestCheckSharedFiveSecondDeadline(t *testing.T) {
	started := make(chan struct{}, 3)
	var handlers [3]http.HandlerFunc
	for stage := range handlers {
		handlers[stage] = func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, checkBodies[stage])
			w.(http.Flusher).Flush()
			started <- struct{}{}
			<-r.Context().Done()
		}
	}
	f := newCheckFixture(t, handlers)
	// The parent is only a cleanup bound; the check must use its own earlier shared limit.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	before := time.Now()
	result := f.client.Check(ctx)
	elapsed := time.Since(before)
	assertCheckResult(t, f, result, [3]string{"timeout", "timeout", "timeout"}, [2]bool{})
	if elapsed < 4500*time.Millisecond || elapsed > 7*time.Second {
		t.Errorf("shared five-second check took %v", elapsed)
	}
	if len(started) != 3 {
		t.Error("shared deadline did not cover three actual HTTP probes")
	}
}

func TestCheckCallerDeadlineBoundsStalledBody(t *testing.T) {
	var handlers [3]http.HandlerFunc
	handlers[2] = func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, checkBodies[2])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
	f := newCheckFixture(t, handlers)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	assertCheckResult(t, f, f.client.Check(ctx), [3]string{"ok", "ok", "timeout"}, [2]bool{})
	if f.calls[2].Load() != 1 {
		t.Error("deadline test did not reach the stalled body")
	}
}

func TestCheckUsesExistingPrivateCATLSAndHTTP2(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		name := "tls12_http1"
		if h2 {
			name = "http2"
		}
		t.Run(name, func(t *testing.T) {
			ca, logs := newLocalTLSAuthority(t), &localTLSLogs{}
			max := uint16(tls.VersionTLS12)
			if h2 {
				max = 0
			}
			var calls atomic.Int32
			server := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), h2, max, logs, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				protocol := 1
				if h2 {
					protocol = 2
				}
				if r.ProtoMajor != protocol || r.TLS.Version < tls.VersionTLS12 {
					t.Error("check changed existing verified TLS transport")
				}
				for stage, path := range checkPaths {
					if r.URL.Path == path {
						_, _ = io.WriteString(w, checkBodies[stage])
						return
					}
				}
				t.Error("TLS check escaped fixed endpoints")
			}))
			cfg := configFixture()
			cfg.ControlURL, cfg.GatewayURL, cfg.UpstreamURL = server.URL, server.URL, server.URL+"/v1"
			cfg.Models, cfg.CAFile = []string{"alpha", "beta"}, localTLSCAFile(t, ca)
			client, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(client.remote.CloseIdleConnections)
			t.Cleanup(client.local.CloseIdleConnections)
			result := client.Check(context.Background())
			if !result.OK || result.ControlPlane != "ok" || result.Gateway != "ok" || result.Upstream != "ok" || calls.Load() != 3 {
				t.Error("trusted TLS check did not probe all three endpoints")
			}
		})
	}
}

func TestCheckSanitizesTLSVerificationFailures(t *testing.T) {
	ca, logs := newLocalTLSAuthority(t), &localTLSLogs{}
	var calls atomic.Int32
	server := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), false, 0, logs, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); _, _ = io.WriteString(w, checkBodies[2]) }))
	f := newCheckFixture(t, [3]http.HandlerFunc{})
	cfg := f.config
	cfg.UpstreamURL = server.URL + "/v1"
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.remote.CloseIdleConnections)
	t.Cleanup(client.local.CloseIdleConnections)
	client.lease = f.lease
	f.client, f.config = client, client.config
	f.config.Models = append([]string(nil), client.config.Models...)
	assertCheckResult(t, f, f.client.Check(context.Background()), [3]string{"ok", "ok", "tls_verification_failed"}, [2]bool{})
	if calls.Load() != 0 {
		t.Error("untrusted TLS check reached the HTTP handler")
	}
}
