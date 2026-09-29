package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"nexus/gateway/connectorclient"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const cliHelperEnvironment = "NEXUS_CONNECTOR_CLI_HELPER_PROCESS"

// Run the real CLI entry point in a subprocess so os.Exit and signal handling
// cannot be mistaken for a successful return from the client library.
func TestConnectorCLIHelperProcess(t *testing.T) {
	if os.Getenv(cliHelperEnvironment) != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{"nexus-connector"}, os.Args[i+1:]...)
			main()
			os.Exit(0)
		}
	}
	fmt.Fprintln(os.Stderr, "CLI helper arguments missing")
	os.Exit(2)
}

type cliProcess struct {
	cmd    *exec.Cmd
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	err    error
	output cliOutput
}

func startConnectorCLI(t *testing.T, config connectorclient.Config, identity connectorclient.Identity) *cliProcess {
	t.Helper()
	return startConnectorCLIAction(t, config, identity, "run", nil)
}

// The prompt channel synchronizes a signal test with the real blocking stdin
// read, without racing the subprocess's stdout/stderr copier.
type cliOutput struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	prompt   chan struct{}
	prompted sync.Once
}

func (o *cliOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n, err := o.buffer.Write(p)
	if strings.Contains(o.buffer.String(), "Paste one-time pairing token") {
		o.prompted.Do(func() { close(o.prompt) })
	}
	return n, err
}

func (o *cliOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buffer.String()
}

func startConnectorCLIAction(t *testing.T, config connectorclient.Config, identity connectorclient.Identity, action string, stdin io.Reader) *cliProcess {
	t.Helper()
	dir := t.TempDir()
	writeFixture := func(name string, value any) string {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	configPath := writeFixture("connector.json", config)
	identityPath := writeFixture("identity.json", identity)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	p := &cliProcess{ctx: ctx, cancel: cancel, done: make(chan struct{}), output: cliOutput{prompt: make(chan struct{})}}
	p.cmd = exec.CommandContext(ctx, executable, "-test.run=^TestConnectorCLIHelperProcess$", "--", action, "--config", configPath, "--identity", identityPath)
	p.cmd.Env = append(os.Environ(), cliHelperEnvironment+"=1", "NEXUS_CONNECTOR_CLI_UPSTREAM_KEY="+cliUpstreamSecret)
	p.cmd.Stdin = stdin
	p.cmd.Stdout, p.cmd.Stderr = &p.output, &p.output
	p.cmd.WaitDelay = time.Second
	if err := p.cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	go func() {
		p.err = p.cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		cancel()
		<-p.done
	})
	return p
}

func (p *cliProcess) wait(t *testing.T, wantCode int) string {
	t.Helper()
	<-p.done
	if p.ctx.Err() != nil {
		t.Fatalf("CLI exceeded its process deadline: %v; output: %s", p.ctx.Err(), p.output.String())
	}
	if p.cmd.ProcessState.ExitCode() != wantCode {
		t.Fatalf("CLI exit = %d, want %d: %v; output: %s", p.cmd.ProcessState.ExitCode(), wantCode, p.err, p.output.String())
	}
	output := p.output.String()
	for _, secret := range []string{cliIdentitySecret, cliLeaseSecret, cliUpstreamSecret, cliPrivatePrompt} {
		if strings.Contains(output, secret) {
			t.Fatal("CLI output disclosed a private fixture value")
		}
	}
	return output
}

const (
	cliIdentitySecret = "nxidentity_PRIVATE_CLI_IDENTITY"
	cliLeaseSecret    = "nxlease_PRIVATE_CLI_LEASE"
	cliUpstreamSecret = "PRIVATE_CLI_UPSTREAM_KEY"
	cliPrivatePrompt  = "PRIVATE_CLI_PROMPT_BODY"
)

type cliFixture struct {
	config     connectorclient.Config
	identity   connectorclient.Identity
	leaseCalls atomic.Int32
	pollCalls  atomic.Int32
	pairCalls  atomic.Int32
	polling    chan struct{}
}

func newCLIFixture(t *testing.T, leaseHandler func(http.ResponseWriter, *http.Request, int32)) *cliFixture {
	t.Helper()
	f := &cliFixture{polling: make(chan struct{})}
	var firstPoll sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer "+cliUpstreamSecret {
			http.Error(w, "unexpected upstream request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":[{"id":"fixture-model"}]}`)
	}))
	t.Cleanup(upstream.Close)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/connector/pair":
			f.pairCalls.Add(1)
			rejectCLILease(w, http.StatusUnauthorized)
		case "/api/connector/lease":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+cliIdentitySecret {
				http.Error(w, "unexpected identity", http.StatusBadRequest)
				return
			}
			leaseHandler(w, r, f.leaseCalls.Add(1))
		case "/connector/poll":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+cliLeaseSecret {
				http.Error(w, "unexpected lease", http.StatusBadRequest)
				return
			}
			f.pollCalls.Add(1)
			firstPoll.Do(func() { close(f.polling) })
			// A real blocked HTTP poll must be released by expiry or a user signal.
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(remote.Close)
	f.config = connectorclient.Config{
		ControlURL: remote.URL, GatewayURL: remote.URL, UpstreamURL: upstream.URL + "/v1",
		Models: []string{"fixture-model"}, APIKeyEnv: "NEXUS_CONNECTOR_CLI_UPSTREAM_KEY", AllowHTTPDevelopment: true,
	}
	f.identity = connectorclient.Identity{
		ConnectorID: "fixture-connector", ConnectionID: "fixture-connection", TenantID: "fixture-tenant",
		Credential: cliIdentitySecret, ControlURL: remote.URL,
	}
	return f
}

func writeCLILease(w http.ResponseWriter, lifetime time.Duration) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"leaseToken": cliLeaseSecret, "expiresAt": time.Now().Add(lifetime)})
}

func rejectCLILease(w http.ResponseWriter, status int) {
	// Remote failures may contain sensitive information. The CLI must never
	// repeat their body, including when main prints Run's returned error.
	http.Error(w, strings.Join([]string{cliIdentitySecret, cliLeaseSecret, cliUpstreamSecret, cliPrivatePrompt}, " "), status)
}

func TestConnectorCLIInitialAuthorizationFailure(t *testing.T) {
	f := newCLIFixture(t, func(w http.ResponseWriter, _ *http.Request, _ int32) {
		rejectCLILease(w, http.StatusUnauthorized)
	})
	output := startConnectorCLI(t, f.config, f.identity).wait(t, 1)
	if !strings.Contains(output, "connector identity authorization rejected") {
		t.Fatalf("CLI omitted the sanitized authorization reason: %s", output)
	}
	if f.leaseCalls.Load() != 1 || f.pollCalls.Load() != 0 {
		t.Fatalf("rejected identity reached polling: lease calls %d, poll calls %d", f.leaseCalls.Load(), f.pollCalls.Load())
	}
}

func TestConnectorCLILeaseExpiryExitsFailure(t *testing.T) {
	f := newCLIFixture(t, func(w http.ResponseWriter, _ *http.Request, call int32) {
		if call == 1 {
			writeCLILease(w, 600*time.Millisecond)
			return
		}
		rejectCLILease(w, http.StatusServiceUnavailable)
	})
	output := startConnectorCLI(t, f.config, f.identity).wait(t, 1)
	if !strings.Contains(output, "connector lease expired") {
		t.Fatalf("CLI omitted the sanitized lease expiry reason: %s", output)
	}
	if f.leaseCalls.Load() < 2 || f.pollCalls.Load() != 1 {
		t.Fatalf("did not exercise renewal failure during a live poll: lease calls %d, poll calls %d", f.leaseCalls.Load(), f.pollCalls.Load())
	}
}

func TestConnectorCLIGracefulSignalExitsSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Go cannot deliver Unix SIGTERM to a Windows child process; Linux CI exercises the signal contract")
	}
	f := newCLIFixture(t, func(w http.ResponseWriter, _ *http.Request, _ int32) {
		writeCLILease(w, time.Minute)
	})
	p := startConnectorCLI(t, f.config, f.identity)
	select {
	case <-f.polling:
	case <-p.done:
		t.Fatalf("CLI exited before polling: %v; output: %s", p.err, p.output.String())
	case <-p.ctx.Done():
		t.Fatal("CLI did not begin polling within the process deadline")
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	output := p.wait(t, 0)
	if strings.Contains(output, "expired") || strings.Contains(output, "rejected") {
		t.Fatalf("graceful signal reported a lifecycle failure: %s", output)
	}
}

func TestConnectorCLIPairInputSignalExitsSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Go cannot deliver Unix SIGTERM to a Windows child process; Linux CI exercises the signal contract")
	}
	f := newCLIFixture(t, func(w http.ResponseWriter, _ *http.Request, _ int32) {
		rejectCLILease(w, http.StatusUnauthorized)
	})
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		input.Close()
		writer.Close()
	})
	p := startConnectorCLIAction(t, f.config, f.identity, "pair", input)
	select {
	case <-p.output.prompt:
	case <-p.done:
		t.Fatalf("CLI exited before requesting pairing input: %v; output: %s", p.err, p.output.String())
	case <-p.ctx.Done():
		t.Fatal("CLI did not request pairing input within the process deadline")
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	p.wait(t, 0)
	if f.pairCalls.Load() != 0 || f.leaseCalls.Load() != 0 || f.pollCalls.Load() != 0 {
		t.Fatal("canceled pairing contacted the remote service")
	}
}

type observedPairingInput struct {
	*os.File
	reading chan struct{}
	closed  chan struct{}
}

func (r *observedPairingInput) Read(p []byte) (int, error) {
	close(r.reading)
	return r.File.Read(p)
}

func (r *observedPairingInput) Close() error {
	err := r.File.Close()
	close(r.closed)
	return err
}

func TestReadPairingTokenCancellationClosesRedirectedInput(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer writer.Close()
	observed := &observedPairingInput{File: input, reading: make(chan struct{}), closed: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		token, err := readPairingToken(ctx, observed)
		if token != "" {
			done <- fmt.Errorf("canceled input returned a token")
			return
		}
		done <- err
	}()
	select {
	case <-observed.reading:
	case <-time.After(time.Second):
		t.Fatal("pairing did not begin reading redirected input")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("pairing cancellation = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled pairing waited for stdin")
	}
	select {
	case <-observed.closed:
	case <-time.After(time.Second):
		t.Fatal("redirected input remained open after cancellation")
	}
}

func TestReadPairingTokenNormalInput(t *testing.T) {
	for _, token := range []string{"nxpair_fixture\n", "nxpair_fixture"} {
		got, err := readPairingToken(context.Background(), io.NopCloser(strings.NewReader(token)))
		if got != token || (err != nil && !errors.Is(err, io.EOF)) {
			t.Fatalf("normal pairing input changed: got %q, %v", got, err)
		}
	}
}
