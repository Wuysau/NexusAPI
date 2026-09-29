package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
)

// gatewayCleanup owns resources during startup, then transfers them to Server.
// Setup is single-threaded and finishes before serving requests. Once transferred,
// a deferred startup cleanup must not close dependencies under active handlers,
// including when an emergency drain returns ErrShutdownIncomplete.
type gatewayCleanup struct {
	closers     []func()
	transferred bool
	once        sync.Once
}

func (c *gatewayCleanup) add(closer func()) {
	if closer != nil {
		c.closers = append(c.closers, closer)
	}
}

func (c *gatewayCleanup) close() {
	c.once.Do(func() {
		for i := len(c.closers) - 1; i >= 0; i-- {
			c.closers[i]()
		}
	})
}

func (c *gatewayCleanup) closeStartup() {
	if !c.transferred {
		c.close()
	}
}

func (c *gatewayCleanup) transferTo(server *Server) {
	server.RegisterCloser(c.close)
	c.transferred = true
}

// Listener failures also pass through shutdown: ownership has already moved to
// Server before ListenAndServe/ListenAndServeTLS starts, so simply returning the
// listener error would leave initialized resources open.
func finishGatewayShutdown(ctx context.Context, server *Server, serveErr error) error {
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	if err := server.Shutdown(ctx); err != nil {
		return errors.Join(serveErr, fmt.Errorf("graceful shutdown: %w", err))
	}
	return serveErr
}
