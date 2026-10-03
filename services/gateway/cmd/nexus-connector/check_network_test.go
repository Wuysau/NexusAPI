package main

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"nexus/gateway/connectorclient"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const (
	checkPrivateBody     = "PRIVATE_CHECK_RESPONSE_BODY"
	checkPrivateHeader   = "PRIVATE_CHECK_RESPONSE_HEADER"
	checkUndeclaredModel = "PRIVATE_CHECK_UNDECLARED_MODEL"
)

type checkCLIReport struct {
	ControlPlane string `json:"controlPlane"`
	Gateway      string `json:"gateway"`
	Upstream     string `json:"upstream"`
	Models       []struct {
		ID        string `json:"id"`
		Available bool   `json:"available"`
	} `json:"models"`
	OK bool `json:"ok"`
}

type checkCLIFixture struct {
	config       connectorclient.Config
	controlCalls atomic.Int32
	gatewayCalls atomic.Int32
	modelCalls   atomic.Int32
	otherCalls   atomic.Int32
}

type checkCLIResponse struct {
	status   int
	body     string
	redirect string
	before   func(http.ResponseWriter, *http.Request) bool
}

type checkCLIOptions struct {
	control, gateway, upstream checkCLIResponse
	tls, trustTLS              bool
}

func newCheckCLIFixture(t *testing.T, options ...checkCLIOptions) *checkCLIFixture {
	t.Helper()
	f := &checkCLIFixture{}
	var opts checkCLIOptions
	if len(options) > 0 {
		opts = options[0]
	}
	endpoint := func(path string, calls *atomic.Int32, local bool, spec checkCLIResponse, body string) *httptest.Server {
		server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != path || r.URL.RawQuery != "" {
				f.otherCalls.Add(1)
				t.Errorf("unexpected check request: %s %s", r.Method, r.URL.Path)
				http.Error(w, checkPrivateBody, http.StatusBadRequest)
				return
			}
			calls.Add(1)
			requestBody, err := io.ReadAll(r.Body)
			if err != nil || len(requestBody) != 0 {
				t.Error("check sent a request body")
			}
			wantAuth := ""
			if local {
				wantAuth = "Bearer " + cliUpstreamSecret
			}
			if r.Header.Get("Authorization") != wantAuth || r.Header.Get("Proxy-Authorization") != "" {
				t.Error("check did not preserve local-only credential scope")
				http.Error(w, checkPrivateBody, http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Private-Check", checkPrivateHeader)
			if spec.before != nil && spec.before(w, r) {
				return
			}
			if spec.redirect != "" {
				http.Redirect(w, r, spec.redirect, http.StatusTemporaryRedirect)
				return
			}
			status := spec.status
			if status == 0 {
				status = http.StatusOK
			}
			responseBody := body
			if spec.body != "" {
				responseBody = spec.body
			}
			w.WriteHeader(status)
			_, _ = io.WriteString(w, responseBody)
		}))
		server.Config.ErrorLog = log.New(io.Discard, "", 0)
		if opts.tls {
			server.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
			server.StartTLS()
		} else {
			server.Start()
		}
		t.Cleanup(server.Close)
		return server
	}
	control := endpoint("/api/health", &f.controlCalls, false, opts.control, `{"ok":true,"private":"`+checkPrivateBody+`"}`)
	gateway := endpoint("/readyz", &f.gatewayCalls, false, opts.gateway, `{"status":"ready","private":"`+checkPrivateBody+`"}`)
	local := endpoint("/v1/models", &f.modelCalls, true, opts.upstream, `{"data":[{"id":"fixture-model"},{"id":"`+checkUndeclaredModel+`"}]}`)
	f.config = connectorclient.Config{
		ControlURL: control.URL, GatewayURL: gateway.URL, UpstreamURL: local.URL + "/v1",
		Models: []string{"fixture-model"}, APIKeyEnv: "NEXUS_CONNECTOR_CLI_UPSTREAM_KEY", AllowHTTPDevelopment: !opts.tls,
	}
	if opts.trustTLS {
		// httptest's private certificate is shared by these three endpoints.
		// Only this explicit CA file makes it trusted by the real CLI process.
		f.config.CAFile = filepath.Join(t.TempDir(), "private-check-ca.pem")
		ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: control.Certificate().Raw})
		if err := os.WriteFile(f.config.CAFile, ca, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func assertCheckCLIReport(t *testing.T, output string, f *checkCLIFixture) checkCLIReport {
	t.Helper()
	assertCheckCLIPrivateOutput(t, output, f)
	first, last := strings.IndexByte(output, '{'), strings.LastIndexByte(output, '}')
	if first < 0 || last < first {
		t.Fatalf("check did not return a JSON report: %s", output)
	}
	raw := []byte(output[first : last+1])
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 5 {
		t.Fatalf("check report fields = %d, want five", len(fields))
	}
	for _, name := range []string{"controlPlane", "gateway", "upstream", "models", "ok"} {
		if _, ok := fields[name]; !ok {
			t.Fatalf("check report missing %s", name)
		}
	}
	var report checkCLIReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if string(fields["ok"]) != "true" && string(fields["ok"]) != "false" {
		t.Fatal("check report ok is not a boolean")
	}
	var models []map[string]json.RawMessage
	if err := json.Unmarshal(fields["models"], &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != len(f.config.Models) {
		t.Fatal("check did not retain the configured model list")
	}
	for i, model := range models {
		if len(model) != 2 || model["id"] == nil || (string(model["available"]) != "true" && string(model["available"]) != "false") || report.Models[i].ID != f.config.Models[i] {
			t.Fatal("check model report changed the allowlist or contains missing or extra fields")
		}
	}
	outside := strings.TrimSpace(output[:first] + output[last+1:])
	if report.OK && outside != "" || !report.OK && outside != "connector check failed; review the report" {
		t.Fatalf("check report was accompanied by unexpected output: %s", outside)
	}
	for _, stage := range []string{report.ControlPlane, report.Gateway, report.Upstream} {
		switch stage {
		case "ok", "unavailable", "unauthorized", "invalid_response", "not_ready", "tls_verification_failed", "timeout", "canceled":
		default:
			t.Fatalf("unsupported stage code: %q", stage)
		}
	}
	return report
}

func TestConnectorCheckNetworkHealthyWithoutIdentity(t *testing.T) {
	f := newCheckCLIFixture(t)
	report, _ := runCheckCLI(t, f, 0)
	assertCheckCLIStages(t, report, "ok", "ok", "ok", true)
	assertCheckCLIThreeGETs(t, f)
}

func assertCheckCLIPrivateOutput(t *testing.T, output string, f *checkCLIFixture, privatePaths ...string) {
	t.Helper()
	values := []string{checkPrivateBody, checkPrivateHeader, checkUndeclaredModel, cliIdentitySecret, cliLeaseSecret, cliUpstreamSecret, cliPrivatePrompt}
	for _, raw := range []string{f.config.ControlURL, f.config.GatewayURL, f.config.UpstreamURL} {
		values = append(values, raw)
		if parsed, err := url.Parse(raw); err == nil && parsed.Host != "" {
			values = append(values, parsed.Host)
		}
	}
	values = append(values, f.config.CAFile)
	values = append(values, privatePaths...)
	for _, value := range values {
		if value != "" && strings.Contains(output, value) {
			t.Fatal("check disclosed a private response, credential, path or endpoint")
		}
	}
}

type checkCLIFileState struct {
	hash    [sha256.Size]byte
	mode    os.FileMode
	modTime time.Time
}

func checkCLIFiles(t *testing.T, dir string) map[string]checkCLIFileState {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := make(map[string]checkCLIFileState, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("check fixture directory contains an unexpected file")
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		state[entry.Name()] = checkCLIFileState{sha256.Sum256(data), info.Mode(), info.ModTime()}
	}
	return state
}

func assertCheckCLIConfigFile(t *testing.T, p *cliProcess, config connectorclient.Config) {
	t.Helper()
	for i, arg := range p.cmd.Args {
		if arg == "--config" && i+1 < len(p.cmd.Args) {
			path := p.cmd.Args[i+1]
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil || len(entries) != 1 || entries[0].Name() != "connector.json" {
				t.Fatal("check wrote additional files beside its configuration")
			}
			want, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != string(want) {
				t.Fatal("check modified its configuration")
			}
			return
		}
	}
	t.Fatal("CLI helper did not expose its configuration path")
}

func runCheckCLI(t *testing.T, f *checkCLIFixture, code int, identityPaths ...string) (checkCLIReport, string) {
	t.Helper()
	identityPath := filepath.Join(t.TempDir(), "PRIVATE_MISSING_CHECK_IDENTITY")
	if len(identityPaths) > 0 {
		identityPath = identityPaths[0]
	}
	dir := filepath.Dir(identityPath)
	before := checkCLIFiles(t, dir)
	var caBefore map[string]checkCLIFileState
	if f.config.CAFile != "" {
		caBefore = checkCLIFiles(t, filepath.Dir(f.config.CAFile))
	}
	p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "check", nil, identityPath)
	output := p.wait(t, code)
	assertCheckCLIPrivateOutput(t, output, f, identityPath, filepath.Base(identityPath))
	if !reflect.DeepEqual(before, checkCLIFiles(t, dir)) {
		t.Fatal("check changed an identity or wrote another local file")
	}
	if caBefore != nil && !reflect.DeepEqual(caBefore, checkCLIFiles(t, filepath.Dir(f.config.CAFile))) {
		t.Fatal("check changed its private CA file")
	}
	assertCheckCLIConfigFile(t, p, f.config)
	return assertCheckCLIReport(t, output, f), output
}

func assertCheckCLIStages(t *testing.T, report checkCLIReport, control, gateway, upstream string, available ...bool) {
	t.Helper()
	wantOK := control == "ok" && gateway == "ok" && upstream == "ok"
	if report.ControlPlane != control || report.Gateway != gateway || report.Upstream != upstream || len(report.Models) != len(available) {
		t.Fatalf("check report = %+v, want stages %s/%s/%s", report, control, gateway, upstream)
	}
	for i, want := range available {
		wantOK = wantOK && want
		if report.Models[i].Available != want {
			t.Fatalf("configured model %d availability = %t, want %t", i, report.Models[i].Available, want)
		}
	}
	if report.OK != wantOK {
		t.Fatalf("overall check ok = %t, want %t", report.OK, wantOK)
	}
}

func assertCheckCLIThreeGETs(t *testing.T, f *checkCLIFixture) {
	t.Helper()
	if f.controlCalls.Load() != 1 || f.gatewayCalls.Load() != 1 || f.modelCalls.Load() != 1 || f.otherCalls.Load() != 0 {
		t.Fatalf("check did not issue exactly its three read-only GET probes: control=%d gateway=%d models=%d other=%d", f.controlCalls.Load(), f.gatewayCalls.Load(), f.modelCalls.Load(), f.otherCalls.Load())
	}
}

func TestConnectorCheckNetworkPreservesPrivateIdentity(t *testing.T) {
	f := newCheckCLIFixture(t)
	dir := t.TempDir()
	identityPath := filepath.Join(dir, "PRIVATE_EXISTING_CHECK_IDENTITY")
	// Invalid identity JSON proves this diagnostic does not load an identity.
	if err := os.WriteFile(identityPath, []byte(cliIdentitySecret), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "private-canary"), []byte(cliPrivatePrompt), 0600); err != nil {
		t.Fatal(err)
	}
	report, _ := runCheckCLI(t, f, 0, identityPath)
	assertCheckCLIStages(t, report, "ok", "ok", "ok", true)
	assertCheckCLIThreeGETs(t, f)
}

func TestConnectorCheckNetworkMissingConfiguredModel(t *testing.T) {
	f := newCheckCLIFixture(t)
	f.config.Models = []string{"fixture-model", "configured-missing"}
	report, _ := runCheckCLI(t, f, 1)
	assertCheckCLIStages(t, report, "ok", "ok", "ok", true, false)
	assertCheckCLIThreeGETs(t, f)
}

func TestConnectorCheckNetworkRemoteUnhealthy(t *testing.T) {
	f := newCheckCLIFixture(t, checkCLIOptions{control: checkCLIResponse{status: http.StatusServiceUnavailable, body: checkPrivateBody}, gateway: checkCLIResponse{body: `{"status":"not_ready","private":"` + checkPrivateBody + `"}`}})
	report, _ := runCheckCLI(t, f, 1)
	assertCheckCLIStages(t, report, "not_ready", "not_ready", "ok", true)
	assertCheckCLIThreeGETs(t, f)
}

func TestConnectorCheckNetworkLocalUnauthorized(t *testing.T) {
	f := newCheckCLIFixture(t, checkCLIOptions{upstream: checkCLIResponse{status: http.StatusUnauthorized, body: checkPrivateBody}})
	report, _ := runCheckCLI(t, f, 1)
	assertCheckCLIStages(t, report, "ok", "ok", "unauthorized", false)
	assertCheckCLIThreeGETs(t, f)
}

func TestConnectorCheckNetworkPrivateTLS(t *testing.T) {
	for _, trust := range []bool{true, false} {
		name := "untrusted"
		if trust {
			name = "configured_CA"
		}
		t.Run(name, func(t *testing.T) {
			f := newCheckCLIFixture(t, checkCLIOptions{tls: true, trustTLS: trust})
			code := 1
			if trust {
				code = 0
			}
			report, _ := runCheckCLI(t, f, code)
			if trust {
				assertCheckCLIStages(t, report, "ok", "ok", "ok", true)
				assertCheckCLIThreeGETs(t, f)
			} else {
				assertCheckCLIStages(t, report, "tls_verification_failed", "tls_verification_failed", "tls_verification_failed", false)
				if f.controlCalls.Load()+f.gatewayCalls.Load()+f.modelCalls.Load()+f.otherCalls.Load() != 0 {
					t.Fatal("untrusted private TLS reached an HTTP handler")
				}
			}
		})
	}
}

func TestConnectorCheckNetworkDoesNotFollowRedirect(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirected.Add(1)
		_, _ = io.WriteString(w, checkPrivateBody)
	}))
	t.Cleanup(destination.Close)
	f := newCheckCLIFixture(t, checkCLIOptions{upstream: checkCLIResponse{redirect: destination.URL + "/private-models"}})
	report, output := runCheckCLI(t, f, 1)
	assertCheckCLIStages(t, report, "ok", "ok", "unavailable", false)
	assertCheckCLIThreeGETs(t, f)
	if redirected.Load() != 0 || strings.Contains(output, destination.URL) {
		t.Fatal("check followed or disclosed the untrusted redirect")
	}
}

func TestConnectorCheckNetworkInvalidConfigIsStatic(t *testing.T) {
	f := newCheckCLIFixture(t)
	f.config.Models = nil
	dir := t.TempDir()
	identityPath := filepath.Join(dir, "PRIVATE_INVALID_CHECK_IDENTITY")
	p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "check", nil, identityPath)
	output := p.wait(t, 1)
	assertCheckCLIPrivateOutput(t, output, f, identityPath)
	if strings.TrimSpace(output) != "explicit local model allowlist required" || strings.ContainsAny(output, "{}") {
		t.Fatalf("invalid config did not return only its static error: %s", output)
	}
	if f.controlCalls.Load()+f.gatewayCalls.Load()+f.modelCalls.Load()+f.otherCalls.Load() != 0 || len(checkCLIFiles(t, dir)) != 0 {
		t.Fatal("invalid configuration contacted a service or wrote a file")
	}
	assertCheckCLIConfigFile(t, p, f.config)
}

func TestConnectorCheckNetworkSignalCancelsStartedProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Go cannot deliver Unix SIGTERM to a Windows child process; Linux CI exercises the signal contract")
	}
	started := make(chan struct{}, 3)
	canceled := make(chan struct{}, 1)
	ready := func(http.ResponseWriter, *http.Request) bool {
		started <- struct{}{}
		return false
	}
	blocked := func(_ http.ResponseWriter, r *http.Request) bool {
		started <- struct{}{}
		<-r.Context().Done()
		canceled <- struct{}{}
		return true
	}
	f := newCheckCLIFixture(t, checkCLIOptions{control: checkCLIResponse{before: blocked}, gateway: checkCLIResponse{before: ready}, upstream: checkCLIResponse{before: ready}})
	dir := t.TempDir()
	identityPath := filepath.Join(dir, "PRIVATE_CANCELED_CHECK_IDENTITY")
	p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "check", nil, identityPath)
	for i := 0; i < 3; i++ {
		select {
		case <-started:
		case <-p.done:
			t.Fatalf("check exited before all probes started: %v; output: %s", p.err, p.output.String())
		case <-p.ctx.Done():
			t.Fatal("check did not start its probes within the process deadline")
		}
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if output := p.wait(t, 0); output != "" {
		t.Fatalf("caller cancellation emitted a report or error: %s", output)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("signal did not cancel the active HTTP probe")
	}
	assertCheckCLIThreeGETs(t, f)
	if len(checkCLIFiles(t, dir)) != 0 {
		t.Fatal("canceled check wrote an identity or another file")
	}
	assertCheckCLIConfigFile(t, p, f.config)
}
