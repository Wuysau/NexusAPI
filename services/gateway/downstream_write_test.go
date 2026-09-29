package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

type deadlineSequenceWriter struct {
	header                               http.Header
	events                               []string
	deadlines                            []time.Time
	body                                 []byte
	setErr, clearErr, writeErr, flushErr error
}

func (w *deadlineSequenceWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *deadlineSequenceWriter) WriteHeader(int) {}

func (w *deadlineSequenceWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	if deadline.IsZero() {
		w.events = append(w.events, "clear")
		return w.clearErr
	}
	w.events = append(w.events, "set")
	return w.setErr
}

func (w *deadlineSequenceWriter) Write(body []byte) (int, error) {
	w.events = append(w.events, "write")
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	w.body = append(w.body, body...)
	return len(body), nil
}

func (w *deadlineSequenceWriter) FlushError() error {
	w.events = append(w.events, "flush")
	return w.flushErr
}

func TestDownstreamDeadlineLifecycle(t *testing.T) {
	failure := errors.New("synthetic downstream failure")
	for _, tc := range []struct {
		name      string
		phase     downstreamWritePhase
		writer    deadlineSequenceWriter
		want      []string
		wantError error
	}{
		{"intermediate success", intermediateWrite, deadlineSequenceWriter{}, []string{"set", "write", "flush", "clear"}, nil},
		{"terminal success", terminalWrite, deadlineSequenceWriter{}, []string{"set", "write", "flush"}, nil},
		{"set failure", intermediateWrite, deadlineSequenceWriter{setErr: failure}, []string{"set"}, failure},
		{"terminal set failure", terminalWrite, deadlineSequenceWriter{setErr: failure}, []string{"set"}, failure},
		{"write failure", intermediateWrite, deadlineSequenceWriter{writeErr: failure}, []string{"set", "write"}, failure},
		{"flush failure", intermediateWrite, deadlineSequenceWriter{flushErr: failure}, []string{"set", "write", "flush"}, failure},
		{"terminal flush failure", terminalWrite, deadlineSequenceWriter{flushErr: failure}, []string{"set", "write", "flush"}, failure},
		{"clear failure", intermediateWrite, deadlineSequenceWriter{clearErr: failure}, []string{"set", "write", "flush", "clear"}, failure},
		{"unsupported deadline", intermediateWrite, deadlineSequenceWriter{setErr: http.ErrNotSupported}, []string{"set", "write", "flush"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy := &Proxy{limits: Limits{IdleTimeout: time.Second}}
			writer := &tc.writer
			started := time.Now()
			err := proxy.withDownstreamWriteDeadline(writer, tc.phase, func() error {
				if _, err := writer.Write([]byte("fixture")); err != nil {
					return err
				}
				return flushBufferedResponse(writer)
			})
			if !errors.Is(err, tc.wantError) || !slices.Equal(writer.events, tc.want) {
				t.Fatalf("deadline lifecycle changed: err=%v events=%v want=%v", err, writer.events, tc.want)
			}
			if tc.wantError != nil {
				var downstream *downstreamWriteError
				if !errors.As(err, &downstream) {
					t.Fatal("downstream failure lost its classification")
				}
			}
			if len(writer.deadlines) < 1 || !writer.deadlines[0].After(started) || writer.deadlines[0].After(time.Now().Add(time.Second)) {
				t.Fatal("write did not arm a fresh bounded deadline")
			}
			if tc.wantError == nil && string(writer.body) != "fixture" {
				t.Fatal("successful write lost its response body")
			}
		})
	}
}

func TestDownstreamSSESelectsIntermediateAndTerminalDeadlines(t *testing.T) {
	proxy := &Proxy{limits: Limits{IdleTimeout: time.Second}}
	writer := &deadlineSequenceWriter{}
	if err := proxy.writeSSE(http.NewResponseController(writer), writer, []byte("data: chunk\n\n")); err != nil {
		t.Fatal(err)
	}
	if err := proxy.writeFinalSSE(writer, []byte("data: [DONE]\n\n")); err != nil {
		t.Fatal(err)
	}
	if want := []string{"set", "write", "flush", "clear", "set", "write", "flush"}; !slices.Equal(writer.events, want) {
		t.Fatalf("SSE wire operations use the wrong deadline phase: %v", writer.events)
	}
	writer = &deadlineSequenceWriter{}
	proxy.writeStreamError(writer, "req_fixture", errInternal())
	if !slices.Equal(writer.events, []string{"set", "write", "flush"}) {
		t.Fatalf("terminal stream error removed its protocol-finish deadline: %v", writer.events)
	}
}

func TestDownstreamWriterWithoutDeadlineSupportRemainsCompatible(t *testing.T) {
	proxy := &Proxy{limits: Limits{IdleTimeout: time.Second}}
	for _, phase := range []downstreamWritePhase{intermediateWrite, terminalWrite} {
		writer := httptest.NewRecorder()
		err := proxy.withDownstreamWriteDeadline(writer, phase, func() error {
			if _, err := writer.Write([]byte("fixture")); err != nil {
				return err
			}
			return flushBufferedResponse(writer)
		})
		if err != nil || writer.Body.String() != "fixture" || !writer.Flushed {
			t.Fatalf("in-memory writer was rejected: err=%v body=%q flushed=%v", err, writer.Body.String(), writer.Flushed)
		}
	}
}

func TestDownstreamZeroTimeoutDoesNotModifyWriterDeadlines(t *testing.T) {
	proxy := &Proxy{}
	writer := &deadlineSequenceWriter{}
	err := proxy.withDownstreamWriteDeadline(writer, intermediateWrite, func() error {
		if _, err := writer.Write([]byte("fixture")); err != nil {
			return err
		}
		return flushBufferedResponse(writer)
	})
	if err != nil || !slices.Equal(writer.events, []string{"write", "flush"}) {
		t.Fatalf("disabled timeout changed writer deadline: err=%v events=%v", err, writer.events)
	}
}
