package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgxpool"
)

const storeProbeCanary = "synthetic-store-probe-private-diagnostic"

// This bounded peer speaks just Startup, Ping and cancellation. It never opens
// a real database, reads application credentials or accepts arbitrary queries.
type storeProbePeer struct {
	listener net.Listener
	mode     string
	mu       sync.Mutex
	conns    map[net.Conn]bool
	workers  sync.WaitGroup
	done     chan struct{}
	stopOnce sync.Once
	accepted atomic.Int32
	ssl      atomic.Int32
	errors   atomic.Int32
	queries  atomic.Int32
	invalid  atomic.Bool
	queried  chan struct{}
	queryOne sync.Once
	ended    chan struct{}
	endOne   sync.Once
}

func newStoreProbePeer(t *testing.T, mode string) *storeProbePeer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("synthetic PostgreSQL listener unavailable")
	}
	p := &storeProbePeer{listener: listener, mode: mode, conns: make(map[net.Conn]bool), done: make(chan struct{}), queried: make(chan struct{}), ended: make(chan struct{})}
	go func() {
		defer close(p.done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			p.accepted.Add(1)
			p.mu.Lock()
			p.conns[conn] = true
			p.mu.Unlock()
			p.workers.Add(1)
			go p.serve(conn)
		}
	}()
	t.Cleanup(func() {
		p.stopOnce.Do(func() {
			_ = listener.Close()
			storeProbeWait(t, p.done, "synthetic listener join")
			p.mu.Lock()
			for conn := range p.conns {
				_ = conn.Close()
			}
			p.mu.Unlock()
			joined := make(chan struct{})
			go func() { p.workers.Wait(); close(joined) }()
			storeProbeWait(t, joined, "synthetic peer worker join")
		})
		if p.invalid.Load() {
			t.Error("synthetic peer observed unexpected protocol traffic")
		}
	})
	return p
}

func (p *storeProbePeer) serve(conn net.Conn) {
	defer p.workers.Done()
	defer func() {
		_ = conn.Close()
		p.mu.Lock()
		delete(p.conns, conn)
		p.mu.Unlock()
	}()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	backend := pgproto3.NewBackend(conn, conn)
	backend.SetMaxBodyLen(1024)
	startup, err := backend.ReceiveStartupMessage() // pgproto3 caps Startup at 10 KiB.
	if err != nil {
		return
	}
	switch startup.(type) {
	case *pgproto3.SSLRequest:
		p.ssl.Add(1)
		_, _ = conn.Write([]byte{'N'})
		return
	case *pgproto3.CancelRequest:
		return
	case *pgproto3.StartupMessage:
	default:
		p.invalid.Store(true)
		return
	}
	if p.mode == "reject" {
		backend.Send(&pgproto3.ErrorResponse{Severity: "FATAL", Code: "XX000", Message: storeProbeCanary})
		if backend.Flush() == nil {
			p.errors.Add(1)
		}
		return
	}
	backend.Send(&pgproto3.AuthenticationOk{})
	backend.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
	backend.Send(&pgproto3.BackendKeyData{ProcessID: 1, SecretKey: 1})
	backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if backend.Flush() != nil {
		return
	}
	queried := false
	defer func() {
		if p.mode == "stall" && queried {
			p.endOne.Do(func() { close(p.ended) })
		}
	}()
	for {
		message, err := backend.Receive()
		if err != nil {
			return
		}
		switch message := message.(type) {
		case *pgproto3.Terminate:
			return
		case *pgproto3.Query:
			if message.String != "-- ping" {
				p.invalid.Store(true)
				return
			}
			queried = true
			p.queries.Add(1)
			p.queryOne.Do(func() { close(p.queried) })
			if p.mode != "stall" {
				backend.Send(&pgproto3.EmptyQueryResponse{})
				backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
				if backend.Flush() != nil {
					return
				}
			}
		default:
			p.invalid.Store(true)
			return
		}
	}
}

type storeProbeLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *storeProbeLogs) Write(value []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.Write(value)
}
func (l *storeProbeLogs) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.String()
}

func storeProbeFixture(t *testing.T, peer *storeProbePeer, initiallyHealthy bool) (*PostgresStore, *storeProbeLogs) {
	t.Helper()
	// Explicit synthetic password and owned service/pass files prevent reading a
	// user's pgpass/service files. TLS negotiation is configured in memory only.
	dir := t.TempDir()
	service, pass := filepath.Join(dir, "pg_service.conf"), filepath.Join(dir, "pgpass")
	if os.WriteFile(service, []byte("[probe]\nhost=127.0.0.1\n"), 0600) != nil || os.WriteFile(pass, nil, 0600) != nil {
		t.Fatal("synthetic driver configuration unavailable")
	}
	target := &url.URL{Scheme: "postgres", Host: peer.listener.Addr().String(), User: url.UserPassword("synthetic", "synthetic"), Path: "/probe"}
	query := url.Values{"sslmode": {"disable"}, "service": {"probe"}, "servicefile": {service}, "passfile": {pass}, "target_session_attrs": {"any"}}
	target.RawQuery = query.Encode()
	cfg, err := pgxpool.ParseConfig(target.String())
	if err != nil {
		t.Fatal("synthetic driver configuration invalid")
	}
	cfg.MaxConns, cfg.MinConns, cfg.MinIdleConns = 1, 0, 0
	cfg.HealthCheckPeriod = time.Hour
	cfg.ConnConfig.ConnectTimeout = 500 * time.Millisecond
	cfg.ConnConfig.RuntimeParams = map[string]string{}
	cfg.ConnConfig.TLSConfig = &tls.Config{ServerName: "synthetic.invalid", MinVersion: tls.VersionTLS12}
	cfg.ConnConfig.Fallbacks = []*pgconn.FallbackConfig{{Host: cfg.ConnConfig.Host, Port: cfg.ConnConfig.Port}}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("synthetic driver pool unavailable")
	}
	logs := &storeProbeLogs{}
	store := &PostgresStore{pool: pool, logger: slog.New(slog.NewJSONHandler(logs, nil))}
	store.healthy.Store(initiallyHealthy)
	t.Cleanup(func() {
		closed := make(chan struct{})
		go func() { store.Close(); close(closed) }()
		storeProbeWait(t, closed, "synthetic driver pool close")
	})
	return store, logs
}

func storeProbeWait(t *testing.T, done <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal(label + " did not complete")
	}
}
func storeProbeEventually(t *testing.T, condition func() bool, label string) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for !condition() {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal(label + " did not occur")
		}
	}
}
func startStoreProbe(t *testing.T, store *PostgresStore, ctx context.Context, cancel context.CancelFunc, interval time.Duration) func() {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); store.RunHealthProbe(ctx, interval) }()
	stop := sync.OnceFunc(func() { cancel(); storeProbeWait(t, done, "health probe cancellation join") })
	t.Cleanup(stop)
	return stop
}

func TestStoreHealthProbeKeepsDriverDiagnosticsPrivate(t *testing.T) {
	peer := newStoreProbePeer(t, "reject")
	store, logs := storeProbeFixture(t, peer, true)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	err := store.Ping(ctx)
	cancel()
	if err == nil || !strings.Contains(err.Error(), storeProbeCanary) || peer.ssl.Load() == 0 {
		t.Fatal("actual driver did not observe the synthetic startup error after SSL refusal")
	}
	if !store.Healthy() || logs.text() != "" {
		t.Fatal("direct Ping changed cached health or logged diagnostics")
	}
	ctx, cancel = context.WithCancel(context.Background())
	stop := startStoreProbe(t, store, ctx, cancel, 80*time.Millisecond)
	storeProbeEventually(t, func() bool { return !store.Healthy() && peer.errors.Load() >= 3 }, "repeated real probe failure")
	stop()
	logged := logs.text()
	if strings.Count(logged, "outbox unreachable") != 1 {
		t.Fatal("repeated failure did not retain a single health transition diagnostic")
	}
	if strings.Contains(logged, storeProbeCanary) || strings.Contains(logged, "127.0.0.1") || strings.Contains(logged, "synthetic") {
		t.Fatal("health transition log exposed raw driver diagnostics")
	}
}

func TestStoreHealthProbePreCanceledContextDoesNoIO(t *testing.T) {
	peer := newStoreProbePeer(t, "ok")
	store, logs := storeProbeFixture(t, peer, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	startStoreProbe(t, store, ctx, cancel, 0)()
	if peer.accepted.Load() != 0 || store.Healthy() || logs.text() != "" {
		t.Fatal("pre-canceled probe performed I/O or changed cached state")
	}
}

func TestStoreHealthProbeSuccessAndNormalStop(t *testing.T) {
	peer := newStoreProbePeer(t, "ok")
	store, logs := storeProbeFixture(t, peer, false)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	if store.Ping(ctx) != nil {
		cancel()
		t.Fatal("actual synthetic Ping failed")
	}
	cancel()
	if store.Healthy() || peer.queries.Load() != 1 {
		t.Fatal("direct Ping changed cached health or used unexpected queries")
	}
	ctx, cancel = context.WithCancel(context.Background())
	stop := startStoreProbe(t, store, ctx, cancel, 80*time.Millisecond)
	storeProbeEventually(t, store.Healthy, "successful cached health refresh")
	stop()
	if peer.queries.Load() < 2 || logs.text() != "" {
		t.Fatal("successful health refresh lacked a real Ping or emitted failure diagnostics")
	}
}

func TestStoreHealthProbeStalledQueryDeadline(t *testing.T) {
	peer := newStoreProbePeer(t, "stall")
	store, _ := storeProbeFixture(t, peer, true)
	ctx, cancel := context.WithCancel(context.Background())
	stop := startStoreProbe(t, store, ctx, cancel, 150*time.Millisecond)
	storeProbeWait(t, peer.queried, "real stalled Ping query")
	storeProbeEventually(t, func() bool { return !store.Healthy() }, "bounded stalled probe failure")
	stop()
	storeProbeWait(t, peer.ended, "deadline interrupted actual query socket")
}

func TestStoreHealthProbeCancelsInFlightQuery(t *testing.T) {
	peer := newStoreProbePeer(t, "stall")
	store, _ := storeProbeFixture(t, peer, true)
	ctx, cancel := context.WithCancel(context.Background())
	stop := startStoreProbe(t, store, ctx, cancel, 250*time.Millisecond)
	storeProbeWait(t, peer.queried, "real in-flight Ping query")
	stop()
	storeProbeWait(t, peer.ended, "parent cancellation interrupted actual query socket")
	if store.Healthy() {
		t.Fatal("canceled in-flight Ping retained a successful cached probe result")
	}
}

var _ io.Writer = (*storeProbeLogs)(nil)
