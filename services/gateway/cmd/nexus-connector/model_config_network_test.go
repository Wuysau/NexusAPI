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
	"sync/atomic"
	"testing"
	"time"
)

type connectorModelIDSample struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type connectorModelIDSamples struct {
	Valid   []connectorModelIDSample `json:"valid"`
	Invalid []connectorModelIDSample `json:"invalid"`
}

func loadConnectorModelIDSamples(t *testing.T) connectorModelIDSamples {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "connector-model-ids.json"))
	if err != nil {
		t.Fatal(err)
	}
	var samples connectorModelIDSamples
	if err := json.Unmarshal(raw, &samples); err != nil || len(samples.Valid) == 0 || len(samples.Invalid) == 0 {
		t.Fatal("shared connector model samples are unavailable or incomplete")
	}
	return samples
}

func TestConnectorCLIModelConfigurationSharedSamples(t *testing.T) {
	samples := loadConnectorModelIDSamples(t)
	for _, group := range []struct {
		name    string
		samples []connectorModelIDSample
		valid   bool
	}{{"valid", samples.Valid, true}, {"invalid", samples.Invalid, false}} {
		for _, sample := range group.samples {
			t.Run(group.name+"/"+sample.Name, func(t *testing.T) {
				// New is the CLI's actual configuration interface. These samples
				// are also consumed by the existing control-plane modelIDs tests.
				config := connectorclient.Config{ControlURL: "https://control.example.invalid", GatewayURL: "https://gateway.example.invalid", UpstreamURL: "http://127.0.0.1:1/v1", Models: []string{sample.ID}}
				client, err := connectorclient.New(config)
				if group.valid {
					if err != nil || client == nil {
						t.Fatalf("approved custom model configuration rejected: %v", err)
					}
				} else if err == nil || client != nil || err.Error() != "invalid model ID" {
					t.Fatal("unapprovable model did not fail configuration with the static error")
				}
			})
		}
	}
}

const modelConfigPairToken = "nxpair_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

type modelConfigNetworkFixture struct {
	config                     connectorclient.Config
	pairCalls, leaseCalls      atomic.Int32
	modelCalls, pollCalls      atomic.Int32
	controlCalls, gatewayCalls atomic.Int32
	otherCalls                 atomic.Int32
	consumed                   atomic.Bool
}

func newModelConfigNetworkFixture(t *testing.T, models []string, valid bool) *modelConfigNetworkFixture {
	t.Helper()
	f := &modelConfigNetworkFixture{}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "" {
			f.otherCalls.Add(1)
			http.Error(w, "unexpected local request", http.StatusBadRequest)
			return
		}
		f.modelCalls.Add(1)
		// Discover configured IDs exactly, including the invalid counterexamples.
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": models[0]}}})
	}))
	t.Cleanup(local.Close)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health", "/readyz":
			if r.Method != http.MethodGet || r.Header.Get("Authorization") != "" {
				f.otherCalls.Add(1)
				http.Error(w, "unexpected health request", http.StatusBadRequest)
				return
			}
			if r.URL.Path == "/api/health" {
				f.controlCalls.Add(1)
				_, _ = io.WriteString(w, `{"ok":true}`)
			} else {
				f.gatewayCalls.Add(1)
				_, _ = io.WriteString(w, `{"status":"ready"}`)
			}
		case "/api/connector/pair":
			f.pairCalls.Add(1)
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+modelConfigPairToken || !f.consumed.CompareAndSwap(false, true) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			_, _ = io.Copy(io.Discard, r.Body)
			pairingNetworkResponse(w)
		case "/api/connector/lease":
			ordinal := f.leaseCalls.Add(1)
			var input struct {
				ReadyModels []string `json:"readyModels"`
			}
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+cliIdentitySecret || json.NewDecoder(r.Body).Decode(&input) != nil || !reflect.DeepEqual(input.ReadyModels, models) {
				t.Error("lease changed the exact discovered configured models")
				http.Error(w, "unexpected lease request", http.StatusBadRequest)
				return
			}
			if !valid {
				http.Error(w, "invalid_models private-model-config-diagnostic", http.StatusBadRequest)
				return
			}
			if ordinal > 1 {
				// End the valid process after an accepted lease and actual poll,
				// without relying on platform-specific subprocess signals.
				http.Error(w, "fixture identity revoked", http.StatusUnauthorized)
				return
			}
			writeCLILease(w, time.Second)
		case "/connector/poll":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+cliLeaseSecret {
				f.otherCalls.Add(1)
				http.Error(w, "unexpected poll request", http.StatusBadRequest)
				return
			}
			f.pollCalls.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			f.otherCalls.Add(1)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(remote.Close)
	f.config = connectorclient.Config{ControlURL: remote.URL, GatewayURL: remote.URL, UpstreamURL: local.URL + "/v1", Models: models, AllowHTTPDevelopment: true}
	return f
}

func (f *modelConfigNetworkFixture) noNetwork() bool {
	return f.pairCalls.Load()+f.leaseCalls.Load()+f.modelCalls.Load()+f.pollCalls.Load()+f.controlCalls.Load()+f.gatewayCalls.Load()+f.otherCalls.Load() == 0 && !f.consumed.Load()
}

func modelConfigActualCLIOutput(t *testing.T, p *cliProcess) (int, string) {
	t.Helper()
	<-p.done
	code := p.cmd.ProcessState.ExitCode()
	output := p.wait(t, code)
	if strings.Contains(output, modelConfigPairToken) || strings.Contains(output, "private-model-config-diagnostic") {
		t.Fatal("CLI disclosed a synthetic credential or private remote diagnostic")
	}
	return code, output
}

func TestConnectorCLIModelConfigurationInvalidPair(t *testing.T) {
	samples := loadConnectorModelIDSamples(t)
	for _, sample := range samples.Invalid {
		if sample.Name != "leading_hyphen" && sample.Name != "embedded_nul" && sample.Name != "unicode" {
			continue
		}
		t.Run(sample.Name, func(t *testing.T) {
			f := newModelConfigNetworkFixture(t, []string{sample.ID}, false)
			dir := t.TempDir()
			path, canary := filepath.Join(dir, "identity.json"), filepath.Join(dir, "canary.txt")
			if err := os.WriteFile(canary, []byte("preserve unrelated file"), 0600); err != nil {
				t.Fatal(err)
			}
			p := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "pair", strings.NewReader(modelConfigPairToken+"\n"), path)
			code, output := modelConfigActualCLIOutput(t, p)
			_, identityErr := os.Lstat(path)
			if code != 1 || strings.TrimSpace(output) != "invalid model ID" || !f.noNetwork() || !os.IsNotExist(identityErr) {
				t.Errorf("invalid model reached pairing side effects: exit=%d pair=%d consumed=%t identity_saved=%t", code, f.pairCalls.Load(), f.consumed.Load(), identityErr == nil)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 1 || entries[0].Name() != "canary.txt" {
				t.Error("invalid configuration created an identity or reservation file")
			}
			if raw, err := os.ReadFile(canary); err != nil || string(raw) != "preserve unrelated file" {
				t.Fatal("invalid configuration changed an unrelated file")
			}
		})
	}
}

func TestConnectorCLIModelConfigurationEarlyCheckAndRun(t *testing.T) {
	var invalid connectorModelIDSample
	for _, sample := range loadConnectorModelIDSamples(t).Invalid {
		if sample.Name == "backslash" {
			invalid = sample
		}
	}
	if invalid.Name == "" {
		t.Fatal("missing shared backslash counterexample")
	}
	for _, action := range []string{"check", "run"} {
		t.Run(action, func(t *testing.T) {
			f := newModelConfigNetworkFixture(t, []string{invalid.ID}, false)
			path := filepath.Join(t.TempDir(), "existing-identity.json")
			identity := connectorclient.Identity{ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant", Credential: cliIdentitySecret, ControlURL: f.config.ControlURL}
			raw, _ := json.Marshal(identity)
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			code, output := modelConfigActualCLIOutput(t, startConnectorCLIAction(t, f.config, connectorclient.Identity{}, action, nil, path))
			if code != 1 || strings.TrimSpace(output) != "invalid model ID" || !f.noNetwork() {
				t.Fatal("invalid model configuration did not fail before check or run network activity")
			}
			if after, err := os.ReadFile(path); err != nil || !reflect.DeepEqual(raw, after) {
				t.Fatal("configuration rejection changed the existing private identity")
			}
		})
	}
}

func TestConnectorCLIModelConfigurationHealthyCustom(t *testing.T) {
	var custom connectorModelIDSample
	for _, sample := range loadConnectorModelIDSamples(t).Valid {
		if sample.Name == "arbitrary_custom" {
			custom = sample
		}
	}
	if custom.Name == "" {
		t.Fatal("missing shared custom model control")
	}
	for _, duplicate := range []bool{false, true} {
		name, models := "custom", []string{custom.ID}
		if duplicate {
			name, models = "duplicates", []string{custom.ID, custom.ID}
		}
		t.Run(name, func(t *testing.T) {
			f := newModelConfigNetworkFixture(t, models, true)
			path := filepath.Join(t.TempDir(), "identity.json")
			pairOutput := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "pair", strings.NewReader(modelConfigPairToken+"\n"), path).wait(t, 0)
			if f.pairCalls.Load() != 1 || !f.consumed.Load() || !strings.Contains(pairOutput, "Identity saved locally") || strings.Contains(pairOutput, modelConfigPairToken) {
				t.Fatal("valid custom model did not preserve single-attempt pairing")
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal("valid pairing did not save an identity")
			}
			checkOutput := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "check", nil, path).wait(t, 0)
			report := assertCheckCLIReport(t, checkOutput, &checkCLIFixture{config: f.config})
			if !report.OK || f.controlCalls.Load() != 1 || f.gatewayCalls.Load() != 1 || f.modelCalls.Load() != 1 || f.leaseCalls.Load() != 0 || f.pollCalls.Load() != 0 {
				t.Fatal("valid custom model did not preserve the three healthy check GETs")
			}
			f.modelCalls.Store(0)
			runOutput := startConnectorCLIAction(t, f.config, connectorclient.Identity{}, "run", nil, path).wait(t, 1)
			if f.leaseCalls.Load() != 2 || f.modelCalls.Load() != 2 || f.pollCalls.Load() < 1 || f.otherCalls.Load() != 0 || !strings.Contains(runOutput, "connector identity authorization rejected") {
				t.Fatal("valid custom model did not obtain a lease and poll before fixture revocation")
			}
			if after, err := os.ReadFile(path); err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("healthy check or run changed the paired identity")
			}
		})
	}
}
