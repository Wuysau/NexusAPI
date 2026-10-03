package main

import (
	"context"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

const singletonStartupSQL = "SELECT pg_try_advisory_lock(782349201,1)"

// The peer implements the default pgx prepared-query protocol for this one lock
// statement and simple Ping. It has no database or application credentials.
type singletonStartupPeer struct {
	listener net.Listener
	mode     string
	mu       sync.Mutex
	conns    map[net.Conn]bool
	workers  sync.WaitGroup
	accepted chan struct{}
	started  chan struct{}
	queried  chan struct{}
	ended    chan struct{}
	acceptDo sync.Once
	startDo  sync.Once
	queryDo  sync.Once
	endDo    sync.Once
	done     chan struct{}
	invalid  atomic.Bool
	queries  atomic.Int32
	pings    atomic.Int32
	cancels  atomic.Int32
}

func newSingletonStartupPeer(t *testing.T, mode string) *singletonStartupPeer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("synthetic singleton peer unavailable")
	}
	p := &singletonStartupPeer{
		listener: listener, mode: mode, conns: make(map[net.Conn]bool),
		accepted: make(chan struct{}), started: make(chan struct{}),
		queried: make(chan struct{}), ended: make(chan struct{}), done: make(chan struct{}),
	}
	go func() {
		defer close(p.done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			p.acceptDo.Do(func() { close(p.accepted) })
			p.mu.Lock()
			p.conns[conn] = true
			p.mu.Unlock()
			p.workers.Add(1)
			go p.serve(conn)
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		singletonStartupWait(t, p.done, 2*time.Second, "peer listener join")
		p.mu.Lock()
		for conn := range p.conns {
			_ = conn.Close()
		}
		p.mu.Unlock()
		joined := make(chan struct{})
		go func() { p.workers.Wait(); close(joined) }()
		singletonStartupWait(t, joined, 2*time.Second, "peer worker join")
		if p.invalid.Load() {
			t.Error("synthetic singleton peer observed unexpected protocol traffic")
		}
	})
	return p
}

func (p *singletonStartupPeer) serve(conn net.Conn) {
	mainConnection := false
	defer p.workers.Done()
	defer func() {
		_ = conn.Close()
		p.mu.Lock()
		delete(p.conns, conn)
		p.mu.Unlock()
		if mainConnection {
			p.endDo.Do(func() { close(p.ended) })
		}
	}()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	backend := pgproto3.NewBackend(conn, conn)
	backend.SetMaxBodyLen(2048)
	startup, err := backend.ReceiveStartupMessage() // Startup is capped at 10 KiB by pgproto3.
	if err != nil {
		return
	}
	switch startup := startup.(type) {
	case *pgproto3.CancelRequest:
		if startup.ProcessID != 17 || startup.SecretKey != 23 {
			p.invalid.Store(true)
		}
		p.cancels.Add(1)
		return // EOF lets pgx's asynchronous cancellation cleanup continue.
	case *pgproto3.StartupMessage:
		mainConnection = true
	default:
		p.invalid.Store(true)
		return
	}
	p.startDo.Do(func() { close(p.started) })
	if p.mode == "startup_stall" {
		var extra [1]byte
		if n, _ := conn.Read(extra[:]); n != 0 {
			p.invalid.Store(true)
		}
		return
	}
	backend.Send(&pgproto3.AuthenticationOk{})
	backend.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
	backend.Send(&pgproto3.BackendKeyData{ProcessID: 17, SecretKey: 23})
	backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if backend.Flush() != nil {
		return
	}
	var statement string
	var resultFormat int16
	stalled := false
	for {
		message, err := backend.Receive()
		if err != nil {
			return
		}
		switch message := message.(type) {
		case *pgproto3.Parse:
			if message.Query != singletonStartupSQL || len(message.ParameterOIDs) != 0 {
				p.invalid.Store(true)
				return
			}
			statement = message.Name
			backend.Send(&pgproto3.ParseComplete{})
		case *pgproto3.Describe:
			if message.ObjectType == 'S' && message.Name == statement {
				backend.Send(&pgproto3.ParameterDescription{})
			} else if message.ObjectType != 'P' || message.Name != "" {
				p.invalid.Store(true)
				return
			}
			format := resultFormat
			if message.ObjectType == 'S' {
				format = pgproto3.TextFormat
			}
			backend.Send(&pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{{
				Name: []byte("pg_try_advisory_lock"), DataTypeOID: 16, DataTypeSize: 1,
				TypeModifier: -1, Format: format,
			}}})
		case *pgproto3.Bind:
			if message.PreparedStatement != statement || message.DestinationPortal != "" || len(message.Parameters) != 0 || len(message.ResultFormatCodes) > 1 {
				p.invalid.Store(true)
				return
			}
			resultFormat = pgproto3.TextFormat
			if len(message.ResultFormatCodes) == 1 {
				resultFormat = message.ResultFormatCodes[0]
			}
			if resultFormat != pgproto3.TextFormat && resultFormat != pgproto3.BinaryFormat {
				p.invalid.Store(true)
				return
			}
			backend.Send(&pgproto3.BindComplete{})
		case *pgproto3.Execute:
			if message.Portal != "" || message.MaxRows != 0 {
				p.invalid.Store(true)
				return
			}
			p.queries.Add(1)
			p.queryDo.Do(func() { close(p.queried) })
			stalled = p.mode == "query_stall"
			if !stalled {
				value := []byte{'t'}
				if p.mode == "occupied" {
					value[0] = 'f'
				}
				if resultFormat == pgproto3.BinaryFormat {
					value[0] = 1
					if p.mode == "occupied" {
						value[0] = 0
					}
				}
				backend.Send(&pgproto3.DataRow{Values: [][]byte{value}})
				backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")})
			}
		case *pgproto3.Sync:
			if !stalled {
				backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
				if backend.Flush() != nil {
					return
				}
			}
		case *pgproto3.Query:
			if message.String != "-- ping" {
				p.invalid.Store(true)
				return
			}
			p.pings.Add(1)
			backend.Send(&pgproto3.EmptyQueryResponse{})
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
			if backend.Flush() != nil {
				return
			}
		case *pgproto3.Terminate:
			return
		default:
			p.invalid.Store(true)
			return
		}
	}
}

func singletonStartupURL(t *testing.T, p *singletonStartupPeer) string {
	t.Helper()
	dir := t.TempDir()
	service, pass := filepath.Join(dir, "service.conf"), filepath.Join(dir, "pgpass")
	if os.WriteFile(service, []byte("[singleton]\nhost=127.0.0.1\n"), 0600) != nil || os.WriteFile(pass, nil, 0600) != nil {
		t.Fatal("synthetic singleton driver configuration unavailable")
	}
	u := &url.URL{Scheme: "postgres", Host: p.listener.Addr().String(), User: url.UserPassword("synthetic", "synthetic"), Path: "/singleton"}
	// Explicit values avoid private service/pass files and inherited connection
	// timeouts. The default pgx query protocol remains unchanged.
	u.RawQuery = (url.Values{
		"sslmode": {"disable"}, "service": {"singleton"}, "servicefile": {service},
		"passfile": {pass}, "connect_timeout": {"0"}, "target_session_attrs": {"any"},
		"default_query_exec_mode": {"cache_statement"},
	}).Encode()
	return u.String()
}

type singletonStartupCall struct {
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	closeLock func()
	err       error
	stops     atomic.Int32
	closeOnce sync.Once
}

func startSingletonStartupCall(t *testing.T, p *singletonStartupPeer) *singletonStartupCall {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	call := &singletonStartupCall{ctx: ctx, cancel: cancel, done: make(chan struct{})}
	address := singletonStartupURL(t, p)
	go func() {
		call.closeLock, call.err = connectorSingleton(ctx, address, func() { call.stops.Add(1); cancel() })
		close(call.done)
	}()
	t.Cleanup(func() {
		cancel()
		singletonStartupWait(t, call.done, 2*time.Second, "singleton invocation join")
		call.close(t)
	})
	return call
}

func (c *singletonStartupCall) close(t *testing.T) {
	t.Helper()
	c.closeOnce.Do(func() {
		if c.closeLock != nil {
			done := make(chan struct{})
			go func() { c.closeLock(); close(done) }()
			singletonStartupWait(t, done, 2*time.Second, "singleton lifetime close join")
		}
	})
}

func singletonStartupWait(t *testing.T, done <-chan struct{}, timeout time.Duration, label string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal(label + " did not complete")
	}
}

func assertSingletonStartupFailure(t *testing.T, p *singletonStartupPeer, call *singletonStartupCall, message string) {
	t.Helper()
	if call.err == nil || call.err.Error() != message || call.closeLock != nil || call.stops.Load() != 0 {
		t.Fatal("failed singleton acquisition changed the static error or lifetime behavior")
	}
	singletonStartupWait(t, p.ended, 2*time.Second, "failed acquisition peer connection close")
}

func TestConnectorSingletonStartupBound(t *testing.T) {
	for _, mode := range []string{"startup_stall", "query_stall"} {
		t.Run(mode, func(t *testing.T) {
			peer := newSingletonStartupPeer(t, mode)
			call := startSingletonStartupCall(t, peer)
			phase := peer.started
			message := "connector singleton database unavailable"
			if mode == "query_stall" {
				phase = peer.queried
				message = "connector transport requires exactly one Gateway; singleton lock is held"
			}
			singletonStartupWait(t, phase, time.Second, "actual stalled acquisition phase")
			select {
			case <-call.done:
				if call.ctx.Err() != nil {
					t.Fatal("startup timeout canceled the lifetime parent context")
				}
				assertSingletonStartupFailure(t, peer, call, message)
			case <-time.After(readinessTimeout + 500*time.Millisecond):
				call.cancel()
				singletonStartupWait(t, call.done, 2*time.Second, "OLD acquisition cancellation cleanup")
				assertSingletonStartupFailure(t, peer, call, message)
				t.Fatal("singleton acquisition exceeded its startup deadline")
			}
		})
	}
}

func TestConnectorSingletonStartupParentCancellation(t *testing.T) {
	for _, mode := range []string{"startup_stall", "query_stall"} {
		t.Run(mode, func(t *testing.T) {
			peer := newSingletonStartupPeer(t, mode)
			call := startSingletonStartupCall(t, peer)
			phase := peer.started
			message := "connector singleton database unavailable"
			if mode == "query_stall" {
				phase = peer.queried
				message = "connector transport requires exactly one Gateway; singleton lock is held"
			}
			singletonStartupWait(t, phase, time.Second, "actual parent-canceled acquisition phase")
			call.cancel()
			singletonStartupWait(t, call.done, time.Second, "parent-canceled singleton invocation")
			assertSingletonStartupFailure(t, peer, call, message)
		})
	}
}

func TestConnectorSingletonStartupOccupiedLock(t *testing.T) {
	peer := newSingletonStartupPeer(t, "occupied")
	call := startSingletonStartupCall(t, peer)
	singletonStartupWait(t, call.done, time.Second, "occupied lock rejection")
	assertSingletonStartupFailure(t, peer, call, "connector transport requires exactly one Gateway; singleton lock is held")
	if peer.queries.Load() != 1 || peer.pings.Load() != 0 {
		t.Fatal("occupied lock rejection retried acquisition or started a lifetime heartbeat")
	}
}

func TestConnectorSingletonStartupLifetimeSurvivesAcquisitionDeadline(t *testing.T) {
	peer := newSingletonStartupPeer(t, "success")
	call := startSingletonStartupCall(t, peer)
	singletonStartupWait(t, call.done, time.Second, "successful singleton acquisition")
	if call.err != nil || call.closeLock == nil {
		t.Fatal("actual singleton lock acquisition failed")
	}
	deadline := time.NewTimer(readinessTimeout + 2*time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	// The third real Ping occurs after the two-second acquisition budget. This
	// catches accidentally deriving the lifetime lease from the startup context.
	for peer.pings.Load() < 3 {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("singleton heartbeat did not survive the startup acquisition deadline")
		}
	}
	if call.ctx.Err() != nil || call.stops.Load() != 0 || peer.queries.Load() != 1 {
		t.Fatal("successful singleton lifetime canceled its parent or reacquired the lock")
	}
	call.close(t)
	singletonStartupWait(t, peer.ended, time.Second, "successful singleton peer connection close")
	if call.ctx.Err() != nil || call.stops.Load() != 0 {
		t.Fatal("normal lifetime close canceled the Gateway parent")
	}
}
