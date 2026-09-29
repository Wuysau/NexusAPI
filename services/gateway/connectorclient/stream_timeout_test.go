package connectorclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const streamTimeoutPrefix = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"

type streamTimeoutCapture struct {
	raw    []byte
	frames []frame
	err    error
}

type streamTimeoutSink struct {
	calls       atomic.Int32
	dataSeen    chan struct{}
	dataOnce    sync.Once
	captured    chan streamTimeoutCapture
	cancelWatch <-chan struct{}
}

func newStreamTimeoutSink() *streamTimeoutSink {
	return &streamTimeoutSink{dataSeen: make(chan struct{}), captured: make(chan streamTimeoutCapture, 1)}
}

func (s *streamTimeoutSink) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/connector/cancel/") {
		select {
		case <-s.cancelWatch:
			w.WriteHeader(http.StatusGone)
		case <-r.Context().Done():
		}
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/connector/result/") {
		http.NotFound(w, r)
		return
	}
	s.calls.Add(1)
	var raw bytes.Buffer
	decoder := json.NewDecoder(io.TeeReader(r.Body, &raw))
	var capture streamTimeoutCapture
	for {
		var next frame
		if err := decoder.Decode(&next); err != nil {
			capture.err = err
			break
		}
		capture.frames = append(capture.frames, next)
		if next.Type == "data" {
			s.dataOnce.Do(func() { close(s.dataSeen) })
		}
	}
	capture.raw = raw.Bytes()
	select {
	case s.captured <- capture:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

func streamTimeoutJob(deadline time.Time) job {
	return job{ID: "req_00000000000000000000000000000001", Model: "qwen2.5:7b",
		Body: json.RawMessage(`{"model":"qwen2.5:7b","stream":true,"messages":[{"role":"user","content":"hello"}]}`), Deadline: deadline}
}

func streamTimeoutExecute(t *testing.T, client *Client, j job) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	done := make(chan struct{})
	go func() { defer close(done); client.execute(ctx, networkLeaseToken, j) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("stream execution did not finish")
	}
}

func streamTimeoutResult(t *testing.T, sink *streamTimeoutSink) streamTimeoutCapture {
	t.Helper()
	select {
	case capture := <-sink.captured:
		if sink.calls.Load() != 1 {
			t.Fatalf("stream result was uploaded %d times", sink.calls.Load())
		}
		for _, private := range []string{"private-read-error", "127.0.0.1:11434", "/private/model-path"} {
			if bytes.Contains(capture.raw, []byte(private)) {
				t.Fatalf("raw read error leaked into uploaded frames: %s", private)
			}
		}
		return capture
	case <-time.After(2 * time.Second):
		t.Fatal("stream result upload did not finish")
		return streamTimeoutCapture{}
	}
}

func streamTimeoutCheckTerminal(t *testing.T, capture streamTimeoutCapture, wantType, wantCode string) {
	t.Helper()
	if capture.err != io.EOF || len(capture.frames) < 3 {
		t.Fatalf("incomplete stream upload: frames=%+v error=%v", capture.frames, capture.err)
	}
	meta, terminal := capture.frames[0], capture.frames[len(capture.frames)-1]
	var data bytes.Buffer
	for _, next := range capture.frames[1 : len(capture.frames)-1] {
		if next.Type != "data" {
			t.Fatalf("unexpected frame within partial stream: %+v", next)
		}
		data.Write(next.Data)
	}
	if meta.Type != "meta" || meta.Status != http.StatusOK || data.String() != streamTimeoutPrefix {
		t.Fatalf("stream prefix was lost before terminal frame: %+v", capture.frames)
	}
	if terminal.Type != wantType || terminal.Code != wantCode || len(terminal.Data) != 0 {
		t.Fatalf("terminal frame = %+v, want type=%s code=%q", terminal, wantType, wantCode)
	}
}

func TestExecuteReportsLocalStreamingDeadline(t *testing.T) {
	for _, deadlineKind := range []string{"job_deadline", "configured_timeout"} {
		t.Run(deadlineKind, func(t *testing.T) {
			sink := newStreamTimeoutSink()
			var calls atomic.Int32
			canceled := make(chan struct{})
			client, _ := networkClient(t, http.NotFound, sink.serve, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, streamTimeoutPrefix)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(canceled)
			})
			deadline := time.Now().Add(500 * time.Millisecond)
			if deadlineKind == "configured_timeout" {
				client.config.UpstreamTimeoutSeconds = 1
				deadline = time.Now().Add(10 * time.Second)
			}
			streamTimeoutExecute(t, client, streamTimeoutJob(deadline))
			streamTimeoutCheckTerminal(t, streamTimeoutResult(t, sink), "error", "timeout")
			awaitNetworkSignal(t, canceled, "local streaming request cancellation")
			if calls.Load() != 1 {
				t.Fatalf("local timeout replayed inference: %d calls", calls.Load())
			}
		})
	}
}

type streamTimeoutBody struct {
	prefix   *strings.Reader
	terminal func() error
	closed   atomic.Int32
}

func (b *streamTimeoutBody) Read(p []byte) (int, error) {
	if b.prefix.Len() > 0 {
		return b.prefix.Read(p)
	}
	return 0, b.terminal()
}

func (b *streamTimeoutBody) Close() error { b.closed.Add(1); return nil }

func TestExecuteDistinguishesStreamingErrorsFromCancellation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		deadline   bool
		watch      bool
		readError  error
		wantType   string
		wantCode   string
		wantCtxErr error
	}{
		{"wrapped_read_deadline_with_live_context", false, false, fmt.Errorf("private-read-error 127.0.0.1:11434: %w", context.DeadlineExceeded), "error", "timeout", nil},
		{"deadline_context_with_canceled_read", true, false, context.Canceled, "error", "timeout", context.DeadlineExceeded},
		{"connection_reset", false, false, errors.New("private-read-error connection reset 127.0.0.1:11434"), "error", "", nil},
		{"unexpected_eof", false, false, fmt.Errorf("private-read-error /private/model-path: %w", io.ErrUnexpectedEOF), "error", "", nil},
		{"normal_eof", false, false, io.EOF, "end", "", nil},
		{"cancel_watcher", false, true, context.Canceled, "error", "", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := newStreamTimeoutSink()
			readBlocked := make(chan struct{})
			if tc.watch {
				sink.cancelWatch = readBlocked
			}
			client, _ := networkClient(t, http.NotFound, sink.serve, http.NotFound)
			var calls atomic.Int32
			var body *streamTimeoutBody
			observedContext := make(chan error, 1)
			client.local = &http.Client{Transport: runtimeTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
					t.Errorf("unexpected inference request: %s %s", r.Method, r.URL.Path)
				}
				body = &streamTimeoutBody{prefix: strings.NewReader(streamTimeoutPrefix), terminal: func() error {
					close(readBlocked)
					if tc.deadline || tc.watch {
						<-r.Context().Done()
					}
					observedContext <- r.Context().Err()
					return tc.readError
				}}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: body}, nil
			})}
			deadline := time.Now().Add(10 * time.Second)
			if tc.deadline {
				deadline = time.Now().Add(500 * time.Millisecond)
			}
			streamTimeoutExecute(t, client, streamTimeoutJob(deadline))
			streamTimeoutCheckTerminal(t, streamTimeoutResult(t, sink), tc.wantType, tc.wantCode)
			if got := <-observedContext; !errors.Is(got, tc.wantCtxErr) {
				t.Fatalf("fixture did not reach its intended context state: got %v want %v", got, tc.wantCtxErr)
			}
			if calls.Load() != 1 || body.closed.Load() != 1 {
				t.Fatalf("stream failure replayed or leaked body: calls=%d closes=%d", calls.Load(), body.closed.Load())
			}
		})
	}
}

func TestRunStreamingCancellationDoesNotBecomeLocalTimeout(t *testing.T) {
	for _, cancelKind := range []string{"process_cancel", "lease_expiry"} {
		t.Run(cancelKind, func(t *testing.T) {
			sink := newStreamTimeoutSink()
			var polls, renewals, calls atomic.Int32
			canceled := make(chan struct{})
			client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if renewals.Add(1) == 1 {
					duration := time.Minute
					if cancelKind == "lease_expiry" {
						duration = 750 * time.Millisecond
					}
					networkLease(w, networkLeaseToken, duration)
					return
				}
				<-r.Context().Done()
			}, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/connector/poll" {
					if polls.Add(1) == 1 {
						networkJob(w)
						return
					}
					<-r.Context().Done()
					return
				}
				sink.serve(w, r)
			}, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, streamTimeoutPrefix)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(canceled)
			})
			cancel, done := runNetworkClient(t, client, identity)
			awaitNetworkSignal(t, sink.dataSeen, "stream prefix uploaded before runtime cancellation")
			if cancelKind == "process_cancel" {
				cancel()
			}
			select {
			case err := <-done:
				if cancelKind == "lease_expiry" && !errors.Is(err, ErrLeaseExpired) {
					t.Fatalf("lease watcher lost its cancellation cause: %v", err)
				}
				if cancelKind == "process_cancel" && err != nil {
					t.Fatalf("process cancellation changed normal shutdown: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("runtime cancellation did not stop streaming workers")
			}
			awaitNetworkSignal(t, canceled, "local stream stopped with runtime")
			capture := streamTimeoutResult(t, sink)
			// Runtime cancellation also cancels the upload. A terminal frame can
			// be absent; it must never manufacture a local timeout classification.
			for _, next := range capture.frames {
				if next.Code == "timeout" {
					t.Fatalf("%s was mislabeled as local timeout", cancelKind)
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("runtime cancellation replayed local inference: %d calls", calls.Load())
			}
		})
	}
}
