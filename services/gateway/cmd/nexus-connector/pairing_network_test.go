package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"nexus/gateway/connectorclient"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

const networkPairingSecret = "nxpair_PRIVATE_NETWORK_PAIRING_TOKEN"

func pairingNetworkEndpoint(t *testing.T, handle http.HandlerFunc) (connectorclient.Config, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/connector/pair" {
			t.Errorf("unexpected pairing request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+networkPairingSecret {
			t.Error("pairing did not use its one-time credential")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		_ = r.Body.Close()
		handle(w, r)
	}))
	t.Cleanup(server.Close)
	return connectorclient.Config{
		ControlURL: server.URL, GatewayURL: server.URL, UpstreamURL: "http://127.0.0.1:1/v1",
		Models: []string{"fixture-model"}, AllowHTTPDevelopment: true,
	}, calls
}

func pairingNetworkResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(connectorclient.Identity{
		ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant",
		Credential: cliIdentitySecret,
	})
}

func runPairingNetworkCLI(t *testing.T, config connectorclient.Config, path string, wantCode int) string {
	t.Helper()
	p := startConnectorCLIAction(t, config, connectorclient.Identity{}, "pair", strings.NewReader(networkPairingSecret+"\n"), path)
	output := p.wait(t, wantCode)
	if strings.Contains(output, networkPairingSecret) {
		t.Fatal("CLI output disclosed the one-time pairing credential")
	}
	return output
}

func assertPairingPlaceholder(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Errorf("pairing contacted the server before reserving its destination: %v", err)
		return
	}
	if !info.Mode().IsRegular() || info.Size() != 0 {
		t.Error("pairing reservation was not an empty regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Errorf("pairing reservation permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestPairingNetworkReservesDestinationBeforeRemoteAuthorization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	config, calls := pairingNetworkEndpoint(t, func(w http.ResponseWriter, _ *http.Request) {
		assertPairingPlaceholder(t, path)
		pairingNetworkResponse(w)
	})
	output := runPairingNetworkCLI(t, config, path, 0)
	if calls.Load() != 1 || !strings.Contains(output, "Identity saved locally") {
		t.Fatalf("pairing did not complete exactly once: calls=%d", calls.Load())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved connectorclient.Identity
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("saved identity was not complete JSON: %v", err)
	}
	want := connectorclient.Identity{
		ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant",
		Credential: cliIdentitySecret, ControlURL: config.ControlURL,
	}
	if saved != want {
		t.Fatal("saved identity did not preserve the paired identity and control origin")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Errorf("saved identity permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestPairingNetworkInvalidParentDoesNotConsumeToken(t *testing.T) {
	for _, existingParentFile := range []bool{false, true} {
		name := "missing parent"
		if existingParentFile {
			name = "parent is a file"
		}
		t.Run(name, func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "parent")
			if existingParentFile {
				if err := os.WriteFile(parent, []byte("preserve parent bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			config, calls := pairingNetworkEndpoint(t, func(w http.ResponseWriter, _ *http.Request) { pairingNetworkResponse(w) })
			runPairingNetworkCLI(t, config, filepath.Join(parent, "identity.json"), 1)
			if calls.Load() != 0 {
				t.Fatalf("unusable destination consumed a one-time token: %d Pair calls", calls.Load())
			}
			if existingParentFile {
				if raw, err := os.ReadFile(parent); err != nil || string(raw) != "preserve parent bytes" {
					t.Fatal("pairing changed the existing parent file")
				}
			}
		})
	}
}

func TestPairingNetworkFailureIsSingleAttemptAndCleansOnlyReservation(t *testing.T) {
	for _, mode := range []string{"unauthorized", "unavailable", "truncated response", "connection lost", "empty identity", "missing identity binding", "noncanonical credential"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "identity.json")
			unrelated := filepath.Join(dir, "existing-identity.json")
			if err := os.WriteFile(unrelated, []byte("preserve unrelated identity"), 0600); err != nil {
				t.Fatal(err)
			}
			config, calls := pairingNetworkEndpoint(t, func(w http.ResponseWriter, _ *http.Request) {
				assertPairingPlaceholder(t, path)
				switch mode {
				case "unauthorized":
					http.Error(w, networkPairingSecret+cliIdentitySecret, http.StatusUnauthorized)
				case "unavailable":
					http.Error(w, networkPairingSecret+cliIdentitySecret, http.StatusServiceUnavailable)
				case "truncated response":
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"credential":"`+cliIdentitySecret)
				case "empty identity":
					_, _ = io.WriteString(w, `{}`)
				case "missing identity binding":
					_ = json.NewEncoder(w).Encode(connectorclient.Identity{ConnectorID: "fixture-connector", Credential: cliIdentitySecret})
				case "noncanonical credential":
					_ = json.NewEncoder(w).Encode(connectorclient.Identity{
						ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant",
						Credential: "nxidentity_" + strings.Repeat("A", 42) + "B",
					})
				case "connection lost":
					// The server has received the token but its response is lost.
					// It may already have consumed the credential: retry is unsafe.
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Errorf("could not simulate lost pairing response: %v", err)
						return
					}
					_ = connection.Close()
				}
			})
			runPairingNetworkCLI(t, config, path, 1)
			if calls.Load() != 1 {
				t.Fatalf("ambiguous pairing failure was retried: %d Pair calls", calls.Load())
			}
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				t.Fatalf("failed pairing left its empty reservation behind: %v", err)
			}
			if raw, err := os.ReadFile(unrelated); err != nil || string(raw) != "preserve unrelated identity" {
				t.Fatal("failed pairing changed an unrelated identity file")
			}
		})
	}
}

func TestPairingNetworkPreservesChangedReservation(t *testing.T) {
	for _, success := range []bool{false, true} {
		name := "remote failure"
		if success {
			name = "remote success"
		}
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "identity.json")
			const externalContent = "identity content saved by another process"
			config, calls := pairingNetworkEndpoint(t, func(w http.ResponseWriter, _ *http.Request) {
				assertPairingPlaceholder(t, path)
				// Modify the existing inode while the CLI awaits authorization.
				// SameFile alone must not permit overwriting or deleting this data.
				if err := os.WriteFile(path, []byte(externalContent), 0600); err != nil {
					t.Errorf("could not modify the pending reservation: %v", err)
					http.Error(w, "fixture failure", http.StatusServiceUnavailable)
					return
				}
				if success {
					pairingNetworkResponse(w)
				} else {
					http.Error(w, "authorization failed", http.StatusUnauthorized)
				}
			})
			runPairingNetworkCLI(t, config, path, 1)
			if calls.Load() != 1 {
				t.Fatalf("changed destination caused a pairing replay: %d calls", calls.Load())
			}
			if raw, err := os.ReadFile(path); err != nil || string(raw) != externalContent {
				t.Fatal("pairing overwrote or removed content added to its reservation")
			}
		})
	}
}

func TestPairingNetworkSignalCancelsStartedAuthorization(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Go cannot deliver Unix SIGTERM to a Windows child process; Linux CI exercises the signal contract")
	}
	path := filepath.Join(t.TempDir(), "identity.json")
	started, canceled := make(chan struct{}, 1), make(chan struct{}, 1)
	config, calls := pairingNetworkEndpoint(t, func(w http.ResponseWriter, r *http.Request) {
		assertPairingPlaceholder(t, path)
		select {
		case started <- struct{}{}:
		default:
		}
		<-r.Context().Done()
		select {
		case canceled <- struct{}{}:
		default:
		}
	})
	p := startConnectorCLIAction(t, config, connectorclient.Identity{}, "pair", strings.NewReader(networkPairingSecret+"\n"), path)
	select {
	case <-started:
	case <-p.done:
		t.Fatal("CLI exited before its pairing request reached the server")
	case <-p.ctx.Done():
		t.Fatal("CLI did not start pairing within the process deadline")
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if output := p.wait(t, 0); strings.Contains(output, networkPairingSecret) {
		t.Fatal("canceled CLI disclosed the pairing credential")
	}
	select {
	case <-canceled:
	case <-p.ctx.Done():
		t.Fatal("CLI cancellation did not release the active pairing HTTP request")
	}
	if calls.Load() != 1 {
		t.Fatalf("canceled pairing was replayed: %d calls", calls.Load())
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("canceled pairing left its empty reservation: %v", err)
	}
}
