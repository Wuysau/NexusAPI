package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"nexus/gateway/connectorclient"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func endpointCLIConfig(t *testing.T, target, suffix string) *modelConfigNetworkFixture {
	t.Helper()
	f := &modelConfigNetworkFixture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			f.controlCalls.Add(1)
			_, _ = io.WriteString(w, `{"ok":true}`)
		case "/readyz":
			f.gatewayCalls.Add(1)
			_, _ = io.WriteString(w, `{"status":"ready"}`)
		case "/v1/models":
			f.modelCalls.Add(1)
			_, _ = io.WriteString(w, `{"data":[{"id":"fixture-model"}]}`)
		case "/api/connector/pair":
			f.pairCalls.Add(1)
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+modelConfigPairToken || !f.consumed.CompareAndSwap(false, true) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			pairingNetworkResponse(w)
		case "/api/connector/lease":
			// Invalid run configurations must never reach this handler. If old
			// production does, reject immediately without interpreting readiness.
			f.leaseCalls.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
		case "/connector/poll":
			f.pollCalls.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			f.otherCalls.Add(1)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	f.config = connectorclient.Config{ControlURL: server.URL, GatewayURL: server.URL, UpstreamURL: server.URL + "/v1", Models: []string{"fixture-model"}, AllowHTTPDevelopment: true}
	switch target {
	case "control":
		f.config.ControlURL += suffix
	case "gateway":
		f.config.GatewayURL += suffix
	case "upstream":
		f.config.UpstreamURL += suffix
	default:
		t.Fatal("unknown fixture target")
	}
	return f
}

func endpointCLIIdentityDir(t *testing.T, f *modelConfigNetworkFixture, existing bool) (string, map[string]checkCLIFileState) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "identity.json")
	if err := os.WriteFile(filepath.Join(dir, "canary.txt"), []byte("preserve unrelated file"), 0600); err != nil {
		t.Fatal(err)
	}
	if existing {
		raw, err := json.Marshal(connectorclient.Identity{ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant", Credential: cliIdentitySecret, ControlURL: f.config.ControlURL})
		if err != nil || os.WriteFile(path, raw, 0600) != nil {
			t.Fatal("could not create synthetic private identity")
		}
	}
	return path, checkCLIFiles(t, dir)
}

func assertEndpointCLIEarlyRejection(t *testing.T, p *cliProcess, f *modelConfigNetworkFixture, target, identityPath string, before map[string]checkCLIFileState) {
	t.Helper()
	code, output := modelConfigActualCLIOutput(t, p)
	want := "remote URL must be an HTTPS origin"
	if target == "upstream" {
		want = "upstream must be an explicit private IP OpenAI /v1 endpoint"
	}
	assertCheckCLIPrivateOutput(t, output, &checkCLIFixture{config: f.config}, identityPath)
	assertCheckCLIConfigFile(t, p, f.config)
	if code != 1 || strings.TrimSpace(output) != want || !f.noNetwork() {
		t.Errorf("URL component did not fail before CLI network/input activity: exit=%d requests=%d pair_consumed=%t", code,
			f.pairCalls.Load()+f.leaseCalls.Load()+f.modelCalls.Load()+f.pollCalls.Load()+f.controlCalls.Load()+f.gatewayCalls.Load()+f.otherCalls.Load(), f.consumed.Load())
	}
	if !reflect.DeepEqual(before, checkCLIFiles(t, filepath.Dir(identityPath))) {
		t.Error("invalid endpoint configuration created or changed an identity or unrelated file")
	}
}

func TestConnectorCLIEndpointConfigurationRejectsBeforeActions(t *testing.T) {
	for _, target := range []string{"control", "gateway", "upstream"} {
		for _, suffix := range []struct{ name, value string }{{"empty_query", "?"}, {"empty_fragment", "#"}} {
			for _, action := range []string{"check", "pair", "run"} {
				t.Run(target+"/"+suffix.name+"/"+action, func(t *testing.T) {
					f := endpointCLIConfig(t, target, suffix.value)
					path, before := endpointCLIIdentityDir(t, f, action != "pair")
					var input io.Reader
					if action == "pair" {
						input = strings.NewReader(modelConfigPairToken + "\n")
					}
					p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, action, input, path)
					assertEndpointCLIEarlyRejection(t, p, f, target, path, before)
				})
			}
		}
	}
}

func TestConnectorCLIEndpointConfigurationRejectsBeforePairInput(t *testing.T) {
	f := endpointCLIConfig(t, "upstream", "#")
	path, before := endpointCLIIdentityDir(t, f, false)
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = writer.Close() })
	p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "pair", input, path)
	select {
	case <-p.done:
		assertEndpointCLIEarlyRejection(t, p, f, "upstream", path, before)
	case <-p.output.prompt:
		// A deterministic old-production failure: the pipe remains open and
		// empty, so only early validation can let this process exit normally.
		p.cancel()
		<-p.done
		t.Fatal("invalid endpoint reached the pairing prompt before reading an open stdin pipe")
	case <-time.After(2 * time.Second):
		p.cancel()
		<-p.done
		t.Fatal("invalid endpoint did not exit before blocked pairing input")
	}
}

func TestConnectorCLIEndpointConfigurationHealthySpelling(t *testing.T) {
	for _, tc := range []struct{ name, path string }{
		{"literal_slashes", "/v1///"}, {"escaped_slash", "/v1%2f"}, {"escaped_digit", "/v%31"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newModelConfigNetworkFixture(t, []string{"fixture-model"}, true)
			f.config.ControlURL += "/"
			f.config.GatewayURL += "/"
			f.config.UpstreamURL = strings.TrimSuffix(f.config.UpstreamURL, "/v1") + tc.path
			path, _ := endpointCLIIdentityDir(t, f, false)
			pairOutput := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "pair", strings.NewReader(modelConfigPairToken+"\n"), path).wait(t, 0)
			if f.pairCalls.Load() != 1 || !f.consumed.Load() || !strings.Contains(pairOutput, "Identity saved locally") || strings.Contains(pairOutput, modelConfigPairToken) {
				t.Fatal("healthy endpoint spelling did not preserve single-attempt pairing")
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal("healthy pairing did not save an identity")
			}
			var identity connectorclient.Identity
			if json.Unmarshal(raw, &identity) != nil || identity.ControlURL != f.config.ControlURL {
				t.Fatal("accepted remote origin changed its exact identity binding")
			}
			before := checkCLIFiles(t, filepath.Dir(path))
			output := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "check", nil, path).wait(t, 0)
			report := assertCheckCLIReport(t, output, &checkCLIFixture{config: f.config})
			if !report.OK || f.controlCalls.Load() != 1 || f.gatewayCalls.Load() != 1 || f.modelCalls.Load() != 1 || f.leaseCalls.Load() != 0 || f.pollCalls.Load() != 0 {
				t.Fatal("healthy spelling did not preserve the three fixed check GETs")
			}
			f.modelCalls.Store(0)
			output = startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "run", nil, path).wait(t, 1)
			if f.leaseCalls.Load() != 2 || f.modelCalls.Load() != 2 || f.pollCalls.Load() < 1 || f.otherCalls.Load() != 0 || !strings.Contains(output, "connector identity authorization rejected") {
				t.Fatal("healthy spelling did not discover, lease and poll before fixture revocation")
			}
			if !reflect.DeepEqual(before, checkCLIFiles(t, filepath.Dir(path))) {
				t.Fatal("check or run changed the paired identity or unrelated file")
			}
		})
	}
}
