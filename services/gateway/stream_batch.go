package main

import (
	"net/http"
	"time"
)

// Flush the first semantic output immediately, then coalesce tiny frames for
// at most 10ms or 16KiB. All writes stay on the relay goroutine; no writer races.
type streamBatch struct {
	p          *Proxy
	w          http.ResponseWriter
	controller *http.ResponseController
	timer      *time.Timer
	pending    []byte
	first      bool
}

func newStreamBatch(p *Proxy, w http.ResponseWriter) *streamBatch {
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	return &streamBatch{p: p, w: w, controller: http.NewResponseController(w), timer: timer, first: true}
}
func (b *streamBatch) close() { b.timer.Stop() }
func (b *streamBatch) emit(frame []byte, immediate bool) error {
	if immediate || b.first || len(frame) >= 16<<10 {
		if err := b.flush(); err != nil {
			return err
		}
		b.first = false
		return b.p.writeSSE(b.controller, b.w, frame)
	}
	if len(b.pending)+len(frame) > 16<<10 {
		if err := b.flush(); err != nil {
			return err
		}
	}
	if len(b.pending) == 0 {
		b.timer.Reset(10 * time.Millisecond)
	}
	b.pending = append(b.pending, frame...)
	return nil
}
func (b *streamBatch) flush() error {
	b.timer.Stop()
	if len(b.pending) == 0 {
		return nil
	}
	err := b.p.writeSSE(b.controller, b.w, b.pending)
	b.pending = b.pending[:0]
	return err
}
