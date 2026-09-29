package main

// HTTP server lifecycle: timeouts, bounded headers, graceful shutdown.
//
// Shutdown order matters. The HTTP server stops accepting first, then in-flight
// streams are given a grace period to finish, and only then are the database
// pool and Redis client closed. Closing the store before the streams finish
// would turn a clean shutdown into lost billing facts.

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"
)

// Terminal persistence has its own ten-second context after request cancellation.
// Give it time to finish before closing the store or other request dependencies.
const defaultShutdownCleanupTimeout = 12 * time.Second

var ErrShutdownIncomplete = errors.New("gateway shutdown cleanup deadline exceeded; active handlers remain")

// Server wraps http.Server with the gateway's lifecycle.
type Server struct {
	http           *http.Server
	logger         *slog.Logger
	cancelRequests context.CancelFunc
	cleanupTimeout time.Duration

	mu              sync.Mutex
	active          int
	draining        bool
	drained         chan struct{}
	shutdownDone    chan struct{}
	shutdownErr     error
	closers         []func()
	resourcesClosed bool
}

// NewServer builds the HTTP server with timeouts appropriate to a streaming
// proxy: no WriteTimeout (a long stream is legitimate and is bounded instead by
// the per-request total duration and the per-write deadline), but a hard
// ReadHeaderTimeout so a slowloris client cannot hold a connection.
func NewServer(addr string, handler http.Handler, maxHeaderBytes int, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	if handler == nil {
		handler = http.DefaultServeMux
	}
	requestCtx, cancelRequests := context.WithCancel(context.Background())
	s := &Server{
		logger:         logger,
		cancelRequests: cancelRequests,
		cleanupTimeout: defaultShutdownCleanupTimeout,
		drained:        make(chan struct{}),
		shutdownDone:   make(chan struct{}),
	}
	s.http = &http.Server{
		Addr:              addr,
		Handler:           s.trackRequests(handler),
		BaseContext:       func(net.Listener) context.Context { return requestCtx },
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	return s
}

// RegisterCloser adds a resource to release after every admitted handler exits.
// Register resources before serving traffic. A registration after successful
// cleanup closes immediately; incomplete emergency cleanup keeps them open.
func (s *Server) RegisterCloser(closer func()) {
	if closer == nil {
		return
	}
	s.mu.Lock()
	if s.resourcesClosed {
		s.mu.Unlock()
		closer()
		return
	}
	s.closers = append(s.closers, closer)
	s.mu.Unlock()
}

func (s *Server) trackRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if s.draining {
			s.mu.Unlock()
			w.Header().Set("connection", "close")
			w.Header().Set("retry-after", "1")
			w.Header().Set("cache-control", "no-store")
			writeAPIError(w, ensureRequestID(r), newAPIError(http.StatusServiceUnavailable, CodeNoHealthyUpstream, TypeServiceUnavail, "Gateway is shutting down."))
			return
		}
		s.active++
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			s.active--
			if s.draining && s.active == 0 {
				close(s.drained)
			}
			s.mu.Unlock()
		}()
		next.ServeHTTP(w, r)
	})
}

// ListenAndServe blocks until the server stops.
func (s *Server) ListenAndServe() error {
	err := s.http.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown stops admission and waits through the caller's grace period. If that
// expires, it cancels request contexts and closes sockets, then allows a separate
// bounded window for detached terminal persistence. Registered resources close
// only after handlers exit. An emergency cleanup timeout returns
// ErrShutdownIncomplete and leaves resources open; the process owner decides how
// to exit. No background waiter closes resources under a still-running handler.
// Concurrent callers wait for the first caller's shutdown, or their own context.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	if s.draining {
		done := s.shutdownDone
		s.mu.Unlock()
		select {
		case <-done:
			return s.shutdownErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.draining = true
	if s.active == 0 {
		close(s.drained)
	}
	s.mu.Unlock()

	err := s.shutdown(ctx)
	s.mu.Lock()
	s.shutdownErr = err
	close(s.shutdownDone)
	s.mu.Unlock()
	return err
}

func (s *Server) shutdown(ctx context.Context) error {
	s.logger.Info("shutting down: draining in-flight requests")
	err := s.http.Shutdown(ctx)
	if err == nil {
		err = s.waitDrained(ctx)
	}
	if err != nil {
		s.logger.Warn("shutdown grace ended: canceling active requests")
		s.cancelRequests()
		closeErr := s.http.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), s.cleanupTimeout)
		defer cancel()
		if cleanupErr := s.waitDrained(cleanupCtx); cleanupErr != nil {
			s.logger.Error("shutdown cleanup incomplete: keeping request dependencies open")
			return errors.Join(err, closeErr, ErrShutdownIncomplete)
		}
		err = errors.Join(err, closeErr)
	} else {
		s.cancelRequests()
	}
	s.mu.Lock()
	s.resourcesClosed = true
	closers := s.closers
	s.closers = nil
	s.mu.Unlock()
	for i := len(closers) - 1; i >= 0; i-- {
		closers[i]()
	}
	return err
}

func (s *Server) waitDrained(ctx context.Context) error {
	select {
	case <-s.drained:
		return nil
	default:
	}
	select {
	case <-s.drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
