package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const uploadCancelLease = "nxlease_upload-fixture"
const uploadCancelPrivate = "private-upload-fixture"

type uploadCancelResponse struct {
	response *http.Response
	err      error
}

type uploadCancelHTTPResult struct {
	status int
	body   string
	err    error
	conn   httptrace.GotConnInfo
}

// The observer wraps the real HTTP request body; its Read still blocks on the
// actual socket. It detects cleanup that remains active after ServeHTTP exits.
type uploadCancelBody struct {
	io.ReadCloser
	reading chan struct{}
	active  atomic.Int32
	late    atomic.Int32
	done    atomic.Bool
}

func (b *uploadCancelBody) Read(p []byte) (int, error) {
	select {
	case b.reading <- struct{}{}:
	default:
	}
	return b.ReadCloser.Read(p)
}

func (b *uploadCancelBody) Close() error {
	if b.done.Load() {
		b.late.Add(1)
	}
	b.active.Add(1)
	defer b.active.Add(-1)
	return b.ReadCloser.Close()
}

type uploadCancelWriter struct {
	http.ResponseWriter
	body       *uploadCancelBody
	late       atomic.Int32
	expired    chan struct{}
	expireOnce sync.Once
	endGate    <-chan struct{}
}

func (w *uploadCancelWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *uploadCancelWriter) SetReadDeadline(deadline time.Time) error {
	if w.body.done.Load() {
		w.late.Add(1)
	}
	err := http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
	if !deadline.IsZero() && !deadline.After(time.Now()) {
		w.expireOnce.Do(func() { close(w.expired) })
	}
	return err
}

func (w *uploadCancelWriter) WriteHeader(status int) {
	if status == http.StatusNoContent && w.endGate != nil {
		// Make EOF consumption/Body.Close precede the upload acknowledgment.
		// A cleanup deadline, if any, must act while this handler still owns w.
		<-w.endGate
		select {
		case <-w.expired:
		case <-time.After(50 * time.Millisecond):
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

type uploadCancelHandled struct {
	body   *uploadCancelBody
	writer *uploadCancelWriter
	active int32
}

type uploadCancelFixture struct {
	hub        *ConnectorHub
	session    *connectorSession
	channel    SnapshotChannel
	server     *httptest.Server
	client     *http.Client
	protocol   int
	logs       *connectorRetryLogs
	authCalls  atomic.Int32
	entered    chan *uploadCancelBody
	handled    chan uploadCancelHandled
	endGates   sync.Map
	healthGate chan struct{}
	healthSeen chan struct{}
	healthGone chan struct{}
	healthMu   sync.Mutex
}

func newUploadCancelFixture(t *testing.T, protocol int) *uploadCancelFixture {
	t.Helper()
	f := &uploadCancelFixture{protocol: protocol, logs: &connectorRetryLogs{}, entered: make(chan *uploadCancelBody, 1), handled: make(chan uploadCancelHandled, 1)}
	f.channel = SnapshotChannel{ID: "upload-channel", ConnectionID: "upload-connection", TenantID: testTenantID, ProjectID: "project-test", Models: []string{testModel}}
	grant := connectorGrant{LeaseID: "upload-lease", ConnectorID: "upload-connector", ConnectionID: f.channel.ConnectionID, TenantID: testTenantID, ExpiresAt: time.Now().Add(time.Minute), Models: f.channel.Models}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.authCalls.Add(1)
		var input connectorAuth
		if r.Method != http.MethodPost || r.URL.Path != "/api/internal/gateway/connector" || r.Header.Get("Authorization") != "Bearer upload-internal-fixture" || json.NewDecoder(r.Body).Decode(&input) != nil || input.LeaseToken != uploadCancelLease {
			t.Error("upload fixture escaped its authenticated control-plane boundary")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(grant)
	}))
	t.Cleanup(cp.Close)
	f.hub = NewConnectorHub(cp.URL, "upload-internal-fixture")
	// A prior authenticated poll has established this single session. Per-call
	// authorization and the subsequent result upload use their real HTTP paths.
	f.session = &connectorSession{token: uploadCancelLease, grant: grant, queue: make(chan *connectorJob, 1), seen: time.Now(), polling: 1}
	f.hub.sessions[f.channel.ConnectionID] = f.session
	f.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != protocol {
			t.Errorf("upload used HTTP/%d, want HTTP/%d", r.ProtoMajor, protocol)
		}
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			f.healthMu.Lock()
			gate, seen, gone := f.healthGate, f.healthSeen, f.healthGone
			f.healthMu.Unlock()
			if seen != nil {
				close(seen)
				select {
				case <-gate:
				case <-r.Context().Done():
					close(gone)
					return
				}
			}
			_, _ = io.WriteString(w, "healthy")
			return
		}
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/connector/result/req_") {
			t.Error("unexpected upload fixture endpoint")
			http.NotFound(w, r)
			return
		}
		body := &uploadCancelBody{ReadCloser: r.Body, reading: make(chan struct{}, 8)}
		r.Body = body
		writer := &uploadCancelWriter{ResponseWriter: w, body: body, expired: make(chan struct{})}
		if gate, ok := f.endGates.Load(r.URL.Path); ok {
			writer.endGate = gate.(chan struct{})
		}
		f.entered <- body
		f.hub.ServeHTTP(writer, r)
		body.done.Store(true)
		f.handled <- uploadCancelHandled{body, writer, body.active.Load()}
	}))
	f.server.Config.ErrorLog = log.New(f.logs, "", 0)
	if protocol == 2 {
		f.server.EnableHTTP2 = true
		f.server.StartTLS()
	} else {
		f.server.Start()
	}
	t.Cleanup(f.server.Close)
	f.client = f.server.Client()
	t.Cleanup(f.client.CloseIdleConnections)
	t.Cleanup(f.hub.client.CloseIdleConnections)
	return f
}

func (f *uploadCancelFixture) claim(t *testing.T, ctx context.Context) (*connectorJob, <-chan uploadCancelResponse) {
	t.Helper()
	transport := connectorTransport{hub: f.hub, channel: &f.channel, identity: &Identity{TenantID: testTenantID, ProjectID: "project-test", OrganizationID: testOrgID, KeyID: testKeyID}, model: testModel}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://connector.invalid/v1/chat/completions", strings.NewReader(`{"model":"`+testModel+`","messages":[{"role":"user","content":"`+uploadCancelPrivate+`"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	responses := make(chan uploadCancelResponse, 1)
	go func() {
		response, err := transport.RoundTrip(r)
		responses <- uploadCancelResponse{response, err}
	}()
	select {
	case job := <-f.session.queue:
		return job, responses
	case <-ctx.Done():
		t.Fatal("authorized connector request did not enter the job queue")
		return nil, nil
	}
}

func (f *uploadCancelFixture) upload(t *testing.T, ctx context.Context, job *connectorJob, body io.Reader) <-chan uploadCancelHTTPResult {
	t.Helper()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, f.server.URL+"/connector/result/"+job.ID, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+uploadCancelLease)
	r.Header.Set("Content-Type", "application/x-ndjson")
	return f.do(r)
}

func (f *uploadCancelFixture) do(r *http.Request) <-chan uploadCancelHTTPResult {
	result := make(chan uploadCancelHTTPResult, 1)
	connections := make(chan httptrace.GotConnInfo, 1)
	r = r.WithContext(httptrace.WithClientTrace(r.Context(), &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		select {
		case connections <- info:
		default:
		}
	}}))
	go func() {
		response, err := f.client.Do(r)
		got := uploadCancelHTTPResult{err: err}
		select {
		case got.conn = <-connections:
		default:
		}
		if response != nil {
			got.status = response.StatusCode
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			got.body = string(body)
			if readErr != nil {
				got.err = readErr
			}
		}
		result <- got
	}()
	return result
}

func awaitUploadCancel[T any](t *testing.T, ch <-chan T, label string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatalf("%s did not finish within its cleanup bound", label)
		var zero T
		return zero
	}
}

func assertUploadCancelFinished(t *testing.T, f *uploadCancelFixture) bool {
	t.Helper()
	select {
	case handled := <-f.handled:
		if handled.active != 0 || handled.body.active.Load() != 0 || handled.body.late.Load() != 0 || handled.writer.late.Load() != 0 {
			t.Error("upload returned with body cleanup active or used request state after returning")
		}
		return true
	case <-time.After(300 * time.Millisecond):
		t.Error("canceled job retained its HTTP upload handler while the upload stayed open")
		return false
	}
}

func TestConnectorUploadCancellationReleasesStalledHTTP(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, cause := range []string{"caller_cancel", "deadline"} {
			phases := []string{"before_metadata", "after_metadata", "partial_frame", "backpressure"}
			if cause == "deadline" {
				// The actual job/socket deadline already expires without a new
				// cancellation trigger. One body-read control per protocol suffices.
				phases = []string{"after_metadata"}
			}
			for _, phase := range phases {
				t.Run(fmt.Sprintf("http%d/%s/%s", protocol, cause, phase), func(t *testing.T) {
					f := newUploadCancelFixture(t, protocol)
					guard, stopGuard := context.WithTimeout(context.Background(), 8*time.Second)
					defer stopGuard()
					ctx, cancel := context.WithCancel(guard)
					if cause == "deadline" {
						cancel()
						ctx, cancel = context.WithTimeout(guard, time.Second)
					}
					defer cancel()
					job, responses := f.claim(t, ctx)
					pr, pw := io.Pipe()
					defer pr.Close()
					defer pw.Close()
					uploaded := f.upload(t, guard, job, pr)
					observed := awaitUploadCancel(t, f.entered, "authenticated upload entry")
					awaitUploadCancel(t, observed.reading, "real socket body read")
					var response *http.Response
					if phase != "before_metadata" {
						frames := "{\"type\":\"meta\",\"status\":200}\n"
						if phase == "partial_frame" {
							frames += `{"type":"data","data":"unfinished`
						}
						if phase == "backpressure" {
							raw, _ := json.Marshal(connectorFrame{Type: "data", Data: bytes.Repeat([]byte("x"), 4096)})
							frames += string(raw) + "\n"
						}
						if _, err := io.WriteString(pw, frames); err != nil {
							t.Fatal(err)
						}
						got := awaitUploadCancel(t, responses, "metadata publication")
						if got.err != nil || got.response == nil || got.response.StatusCode != http.StatusOK {
							t.Fatal("valid metadata did not reconstruct an HTTP response")
						}
						response = got.response
						defer response.Body.Close()
						if phase == "backpressure" {
							var one [1]byte
							if n, err := response.Body.Read(one[:]); n != 1 || err != nil || one[0] != 'x' {
								t.Fatal("fixture did not reach an actual pipe write with unread data remaining")
							}
						}
					}
					if cause == "caller_cancel" {
						cancel()
					}
					<-ctx.Done()
					finished := assertUploadCancelFinished(t, f)
					if response == nil {
						got := awaitUploadCancel(t, responses, "canceled pre-metadata RoundTrip")
						if got.response != nil || !errors.Is(got.err, ctx.Err()) {
							t.Fatal("pre-metadata cancellation lost its actual context cause")
						}
					} else {
						body, err := io.ReadAll(response.Body)
						if err == nil || len(body) != 0 {
							t.Fatal("canceled partial upload manufactured body data or successful EOF")
						}
					}
					// Release the deliberately open client body even on OLD RED, then
					// join the upload and any handler that failed the prompt bound.
					_ = pw.Close()
					_ = pr.Close()
					got := awaitUploadCancel(t, uploaded, "HTTP upload cleanup")
					if !finished {
						awaitUploadCancel(t, f.handled, "released OLD upload handler")
					}
					if f.authCalls.Load() != 2 || strings.Contains(got.body+f.logs.String(), uploadCancelPrivate) {
						t.Fatal("cancellation repeated authorization or disclosed private request data")
					}
				})
			}
		}
	}
}

func TestConnectorUploadTerminalCauseSurvivesCleanup(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, terminal := range []string{"end", "timeout", "unavailable"} {
			t.Run(fmt.Sprintf("http%d/%s", protocol, terminal), func(t *testing.T) {
				f := newUploadCancelFixture(t, protocol)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				job, responses := f.claim(t, ctx)
				last := `{"type":"end"}`
				var want error
				if terminal != "end" {
					last = `{"type":"error","code":"` + terminal + `"}`
					want = errConnectorUnavailable
					if terminal == "timeout" {
						want = context.DeadlineExceeded
					}
				}
				frames := "{\"type\":\"meta\",\"status\":200}\n" + last + "\n"
				uploaded := f.upload(t, ctx, job, strings.NewReader(frames))
				got := awaitUploadCancel(t, responses, "terminal response metadata")
				if got.err != nil || got.response == nil {
					t.Fatal("terminal fixture did not publish valid metadata")
				}
				defer got.response.Body.Close()
				awaitUploadCancel(t, f.handled, "terminal handler exit")
				// Read only after the handler has finished. EOF and the original
				// timeout/unavailable errors must survive its deferred cleanup.
				body, err := io.ReadAll(got.response.Body)
				_ = got.response.Body.Close()
				if len(body) != 0 || !errors.Is(err, want) {
					t.Fatalf("terminal cause changed after cleanup: err=%v, want %v", err, want)
				}
				result := awaitUploadCancel(t, uploaded, "terminal HTTP upload")
				if result.err != nil || terminal == "end" && result.status != http.StatusNoContent {
					t.Fatalf("terminal upload failed: status=%d err=%v", result.status, result.err)
				}
				if f.authCalls.Load() != 2 || strings.Contains(result.body+f.logs.String(), uploadCancelPrivate) {
					t.Fatal("terminal cleanup repeated authorization or disclosed private request data")
				}
			})
		}
	}
}

func TestConnectorUploadCompletedRequestKeepsHTTP1Connection(t *testing.T) {
	f := newUploadCancelFixture(t, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var previous net.Conn
	for iteration := 0; iteration < 8; iteration++ {
		job, responses := f.claim(t, ctx)
		immediateClose := iteration%2 == 0
		var endGate chan struct{}
		var releaseEnd func()
		if immediateClose {
			endGate = make(chan struct{})
			var endOnce sync.Once
			releaseEnd = func() { endOnce.Do(func() { close(endGate) }) }
			t.Cleanup(releaseEnd)
			f.endGates.Store("/connector/result/"+job.ID, endGate)
		}
		uploaded := f.upload(t, ctx, job, strings.NewReader("{\"type\":\"meta\",\"status\":200}\n{\"type\":\"end\"}\n"))
		awaitUploadCancel(t, f.entered, "completed upload entry")
		got := awaitUploadCancel(t, responses, "completed response metadata")
		if got.err != nil || got.response == nil {
			t.Fatal("completed fixture did not publish its response")
		}
		body, err := io.ReadAll(got.response.Body)
		if len(body) != 0 || err != nil {
			t.Fatal("completed upload lost normal EOF")
		}
		if immediateClose {
			_ = got.response.Body.Close()
			releaseEnd()
		}
		awaitUploadCancel(t, f.handled, "completed upload handler")
		result := awaitUploadCancel(t, uploaded, "completed upload acknowledgment")
		if result.err != nil || result.status != http.StatusNoContent || result.conn.Conn == nil || previous != nil && (!result.conn.Reused || result.conn.Conn != previous) {
			t.Fatalf("normal completion broke physical connection reuse: status=%d err=%v reused=%t", result.status, result.err, result.conn.Reused)
		}
		f.healthMu.Lock()
		f.healthGate, f.healthSeen, f.healthGone = make(chan struct{}), make(chan struct{}), make(chan struct{})
		f.healthMu.Unlock()
		health, _ := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/health", nil)
		healthDone := f.do(health)
		awaitUploadCancel(t, f.healthSeen, "next keepalive request")
		if !immediateClose {
			// Cancel the old completed job while this next request owns the
			// same socket. A late old watcher must not expire its read deadline.
			_ = got.response.Body.Close()
		}
		select {
		case <-f.healthGone:
			t.Error("late completed-job cleanup canceled the next request")
		case <-time.After(25 * time.Millisecond):
		}
		close(f.healthGate)
		healthResult := awaitUploadCancel(t, healthDone, "next healthy keepalive response")
		if healthResult.err != nil || healthResult.status != http.StatusOK || healthResult.body != "healthy" || !healthResult.conn.Reused || healthResult.conn.Conn != result.conn.Conn {
			t.Fatalf("next request lost the proven keepalive socket: status=%d err=%v reused=%t", healthResult.status, healthResult.err, healthResult.conn.Reused)
		}
		previous = healthResult.conn.Conn
	}
	if f.authCalls.Load() != 16 || strings.Contains(f.logs.String(), uploadCancelPrivate) {
		t.Fatal("completed uploads repeated authorization or disclosed private request data")
	}
}
