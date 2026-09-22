package main

import (
	"context"
	"time"

	"nexus/gateway/provider"
)

type chunkResult struct {
	chunk provider.CanonicalChunk
	err   error
}

// A single reader and a one-item queue bound work for the entire request.
// Closing the provider body interrupts a blocked network read on cancellation.
type chunkReader struct {
	results chan chunkResult
	ctx     context.Context
	cancel  context.CancelFunc
	stream  provider.Stream
	timer   *time.Timer
	idle    time.Duration
	flushAt <-chan time.Time
	flush   func() error
}

func newChunkReader(ctx context.Context, stream provider.Stream, idle time.Duration) *chunkReader {
	ctx, cancel := context.WithCancel(ctx)
	r := &chunkReader{results: make(chan chunkResult), ctx: ctx, cancel: cancel, stream: stream, idle: idle}
	if idle > 0 {
		r.timer = time.NewTimer(idle)
		r.timer.Stop()
	}
	go func() {
		for {
			c, e := stream.Next()
			select {
			case r.results <- chunkResult{c, e}:
			case <-ctx.Done():
				return
			}
			if e != nil || c.Done {
				return
			}
		}
	}()
	return r
}
func (r *chunkReader) close() {
	r.cancel()
	_ = r.stream.Close()
	if r.timer != nil {
		r.timer.Stop()
	}
}
func (r *chunkReader) next() (provider.CanonicalChunk, error) {
	var deadline <-chan time.Time
	if r.timer != nil {
		r.timer.Reset(r.idle)
		deadline = r.timer.C
		defer func() {
			if !r.timer.Stop() {
				select {
				case <-r.timer.C:
				default:
				}
			}
		}()
	}
	for {
		select {
		case v := <-r.results:
			return v.chunk, v.err
		case <-r.ctx.Done():
			return provider.CanonicalChunk{}, r.ctx.Err()
		case <-deadline:
			return provider.CanonicalChunk{}, errUpstreamIdle
		case <-r.flushAt:
			if err := r.flush(); err != nil {
				return provider.CanonicalChunk{}, err
			}
		}
	}
}
