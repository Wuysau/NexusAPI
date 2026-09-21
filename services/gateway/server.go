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
	"net/http"
	"sync"
	"time"
)

// Server wraps http.Server with the gateway's lifecycle.
type Server struct {
	http     *http.Server
	logger   *slog.Logger
	closers  []func()
	closeMux sync.Once
}

// NewServer builds the HTTP server with timeouts appropriate to a streaming
// proxy: no WriteTimeout (a long stream is legitimate and is bounded instead by
// the per-request total duration and the per-write deadline), but a hard
// ReadHeaderTimeout so a slowloris client cannot hold a connection.
func NewServer(addr string, handler http.Handler, maxHeaderBytes int, logger *slog.Logger) *Server {
	return &Server{
		http: &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			IdleTimeout:       120 * time.Second,
			MaxHeaderBytes:    maxHeaderBytes,
			ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		},
		logger: logger,
	}
}

// RegisterCloser adds a resource to release after shutdown.
func (s *Server) RegisterCloser(closer func()) { s.closers = append(s.closers, closer) }

// ListenAndServe blocks until the server stops.
func (s *Server) ListenAndServe() error {
	err := s.http.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown drains in-flight requests and then releases registered resources.
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("shutting down: draining in-flight requests")
	err := s.http.Shutdown(ctx)
	s.closeMux.Do(func() {
		for i := len(s.closers) - 1; i >= 0; i-- {
			s.closers[i]()
		}
	})
	return err
}
