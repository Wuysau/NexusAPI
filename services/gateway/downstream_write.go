package main

import (
	"errors"
	"net/http"
	"time"
)

type downstreamWritePhase uint8

const (
	intermediateWrite downstreamWritePhase = iota
	terminalWrite
)

// Bound only the actual write and flush. Leaving an intermediate write deadline
// armed while waiting for another chunk or durable persistence can reset an
// otherwise healthy HTTP/2 stream. Keep terminal deadlines for net/http's final
// protocol flush after the handler returns. A failed write is never reopened.
func (p *Proxy) withDownstreamWriteDeadline(w http.ResponseWriter, phase downstreamWritePhase, operation func() error) error {
	controller := http.NewResponseController(w)
	armed := false
	if p.limits.IdleTimeout > 0 {
		err := controller.SetWriteDeadline(time.Now().Add(p.limits.IdleTimeout))
		if err != nil && !errors.Is(err, http.ErrNotSupported) {
			return &downstreamWriteError{err}
		}
		armed = err == nil
	}
	if err := operation(); err != nil {
		return &downstreamWriteError{err}
	}
	if armed && phase == intermediateWrite {
		if err := controller.SetWriteDeadline(time.Time{}); err != nil {
			return &downstreamWriteError{err}
		}
	}
	return nil
}

// Plain JSON writers need not implement Flusher (for example an in-memory
// adapter). Real HTTP writers flush before a successful write deadline clears.
func flushBufferedResponse(w http.ResponseWriter) error {
	err := http.NewResponseController(w).Flush()
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}
