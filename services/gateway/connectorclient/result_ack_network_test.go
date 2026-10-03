package connectorclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const resultAckPayload = streamTimeoutPrefix + "data: [DONE]\n\n"

func resultAckTLSClient(t *testing.T, h2 bool, control, gateway, inference http.HandlerFunc) (*Client, Identity) {
	t.Helper()
	ca, logs := newLocalTLSAuthority(t), &localTLSLogs{}
	protocol, maxVersion := 1, uint16(tls.VersionTLS12)
	if h2 {
		protocol, maxVersion = 2, 0
	}
	verified := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.TLS == nil || r.ProtoMajor != protocol || r.TLS.Version < tls.VersionTLS12 {
				t.Error("result acknowledgment fixture did not use the required TLS protocol")
			}
			next(w, r)
		}
	}
	cp := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), h2, maxVersion, logs, verified(control))
	gw := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), h2, maxVersion, logs, verified(gateway))
	local := localTLSServer(t, ca.leaf(t, "127.0.0.1", false), h2, maxVersion, logs, verified(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("remote lease credential reached local inference")
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"}]}`)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Error("result acknowledgment fixture escaped the local endpoint boundary")
			http.NotFound(w, r)
			return
		}
		var body struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil || json.Unmarshal(raw, &body) != nil || body.Model != "qwen2.5:7b" || !body.Stream {
			t.Error("result acknowledgment handling changed the local request")
		}
		inference(w, r)
	}))
	cfg := configFixture()
	cfg.ControlURL, cfg.GatewayURL, cfg.UpstreamURL = cp.URL, gw.URL, local.URL+"/v1"
	cfg.CAFile, cfg.AllowHTTPDevelopment = localTLSCAFile(t, ca), false
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.remote.CloseIdleConnections)
	t.Cleanup(client.local.CloseIdleConnections)
	return client, Identity{ConnectorID: "connector-ack", ConnectionID: "connection-ack", TenantID: "tenant-ack",
		ControlURL: cp.URL, Credential: "nxidentity_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
}

func resultAckReadUpload(t *testing.T, r *http.Request) []frame {
	t.Helper()
	if r.Method != http.MethodPost || !validJobID(strings.TrimPrefix(r.URL.Path, "/connector/result/")) ||
		r.Header.Get("Authorization") != "Bearer "+networkLeaseToken || r.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Error("result upload escaped its job, token, or framing boundary")
	}
	decoder := json.NewDecoder(r.Body)
	var frames []frame
	for {
		var next frame
		err := decoder.Decode(&next)
		if err == io.EOF {
			return frames
		}
		if err != nil {
			t.Error("result upload did not complete before its acknowledgment")
			return frames
		}
		frames = append(frames, next)
	}
}

func resultAckCheckUpload(t *testing.T, frames []frame) {
	t.Helper()
	if len(frames) < 3 || frames[0].Type != "meta" || frames[0].Status != http.StatusOK || frames[0].Code != "" ||
		frames[len(frames)-1].Type != "end" || frames[len(frames)-1].Code != "" || len(frames[len(frames)-1].Data) != 0 {
		t.Error("result acknowledgment preceded a complete metadata/data/end upload")
		return
	}
	var data bytes.Buffer
	for _, next := range frames[1 : len(frames)-1] {
		if next.Type != "data" || next.Code != "" {
			t.Error("result acknowledgment handling changed upload frame order")
		}
		data.Write(next.Data)
	}
	if data.String() != resultAckPayload {
		t.Error("result acknowledgment handling changed the completed local response")
	}
}

func resultAckWrite(t *testing.T, w http.ResponseWriter, mode string) {
	t.Helper()
	switch mode {
	case "normal_204":
		w.WriteHeader(http.StatusNoContent)
	case "finite_error":
		http.Error(w, "private-ack-diagnostic", http.StatusBadGateway)
	default:
		w.Header().Set("Content-Length", "1024")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "{")
	}
	if http.NewResponseController(w).Flush() != nil {
		t.Error("fixture could not flush acknowledgment headers")
	}
}

func resultAckWait(t *testing.T, done <-chan struct{}, what string) bool {
	t.Helper()
	select {
	case <-done:
		return true
	case <-time.After(750 * time.Millisecond):
		t.Errorf("%s remained blocked after acknowledgment headers", what)
		return false
	}
}

func TestResultAcknowledgmentCompletedUpload(t *testing.T) {
	for _, protocol := range []string{"http1_tls", "http2_tls"} {
		t.Run(protocol, func(t *testing.T) {
			for _, mode := range []string{"normal_204", "finite_error", "stalled_error", "parent_cancel"} {
				t.Run(mode, func(t *testing.T) {
					var calls, uploads atomic.Int32
					ackStarted, ackEnded, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
					finish := sync.OnceFunc(func() { close(release) })
					captured := make(chan []frame, 1)
					client, _ := resultAckTLSClient(t, protocol == "http2_tls", http.NotFound, func(w http.ResponseWriter, r *http.Request) {
						if strings.HasPrefix(r.URL.Path, "/connector/cancel/") {
							if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+networkLeaseToken {
								t.Error("cancel watcher lost its existing authorization boundary")
							}
							<-r.Context().Done()
							return
						}
						defer close(ackEnded)
						uploads.Add(1)
						captured <- resultAckReadUpload(t, r)
						resultAckWrite(t, w, mode)
						close(ackStarted)
						if mode == "stalled_error" || mode == "parent_cancel" {
							select {
							case <-release:
							case <-r.Context().Done():
							}
						}
					}, func(w http.ResponseWriter, _ *http.Request) {
						calls.Add(1)
						_, _ = io.WriteString(w, resultAckPayload)
					})
					parent, cancel := context.WithTimeout(context.Background(), 8*time.Second)
					done := make(chan struct{})
					t.Cleanup(func() {
						cancel()
						finish()
						awaitNetworkSignal(t, done, "result acknowledgment worker cleanup")
					})
					go func() {
						defer close(done)
						client.execute(parent, networkLeaseToken, streamTimeoutJob(time.Now().Add(5*time.Second)))
					}()
					awaitNetworkSignal(t, ackStarted, "complete upload and acknowledgment headers")
					resultAckCheckUpload(t, <-captured)
					if mode == "parent_cancel" {
						cancel()
					}
					resultAckWait(t, done, "completed result worker")
					if mode != "parent_cancel" && parent.Err() != nil {
						t.Error("acknowledgment completion depended on caller cancellation")
					}
					finish()
					awaitNetworkSignal(t, done, "completed result worker after fixture release")
					awaitNetworkSignal(t, ackEnded, "acknowledgment endpoint cleanup")
					if calls.Load() != 1 || uploads.Load() != 1 {
						t.Error("acknowledgment handling repeated local inference or its result upload")
					}
				})
			}
		})
	}
}

func TestResultAcknowledgmentReleasesRuntimeWorker(t *testing.T) {
	for _, protocol := range []string{"http1_tls", "http2_tls"} {
		t.Run(protocol, func(t *testing.T) {
			var calls, polls, initialUploads atomic.Int32
			allFour, fifthUploaded, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			ackFlushed := make(chan struct{}, 4)
			finish := sync.OnceFunc(func() { close(release) })
			var mu sync.Mutex
			byID := make(map[string]int)
			client, identity := resultAckTLSClient(t, protocol == "http2_tls", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/connector/lease" || r.Header.Get("Authorization") != "Bearer nxidentity_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
					t.Error("runtime acknowledgment fixture escaped identity renewal")
				}
				_, _ = io.Copy(io.Discard, r.Body)
				networkLease(w, networkLeaseToken, time.Minute)
			}, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+networkLeaseToken {
					t.Error("runtime acknowledgment handling changed the assigned lease token")
				}
				switch {
				case r.URL.Path == "/connector/poll":
					if r.Method != http.MethodPost {
						t.Error("runtime acknowledgment fixture changed poll method")
					}
					n := polls.Add(1)
					if n > 5 {
						<-r.Context().Done()
						return
					}
					j := streamTimeoutJob(time.Now().Add(10 * time.Second))
					j.ID = fmt.Sprintf("req_%032x", n)
					_ = json.NewEncoder(w).Encode(j)
				case strings.HasPrefix(r.URL.Path, "/connector/cancel/"):
					<-r.Context().Done()
				case strings.HasPrefix(r.URL.Path, "/connector/result/"):
					frames := resultAckReadUpload(t, r)
					resultAckCheckUpload(t, frames)
					id := strings.TrimPrefix(r.URL.Path, "/connector/result/")
					mu.Lock()
					byID[id]++
					mu.Unlock()
					if id == "req_00000000000000000000000000000005" {
						resultAckWrite(t, w, "normal_204")
						close(fifthUploaded)
						return
					}
					if initialUploads.Add(1) == 4 {
						close(allFour)
					}
					// No initial worker receives its ACK until all four have
					// completed their uploads and occupied runtime capacity.
					select {
					case <-allFour:
					case <-r.Context().Done():
						return
					}
					resultAckWrite(t, w, "stalled_error")
					ackFlushed <- struct{}{}
					select {
					case <-release:
					case <-r.Context().Done():
					}
				default:
					t.Error("runtime acknowledgment fixture received an unrelated endpoint")
					http.NotFound(w, r)
				}
			}, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, resultAckPayload)
			})
			parent, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			done := make(chan struct{})
			var runErr error
			t.Cleanup(func() {
				cancel()
				finish()
				awaitNetworkSignal(t, done, "runtime acknowledgment worker cleanup")
			})
			go func() { defer close(done); runErr = client.Run(parent, identity) }()
			awaitNetworkSignal(t, allFour, "four complete uploads occupying runtime workers")
			for range 4 {
				awaitNetworkSignal(t, ackFlushed, "four flushed acknowledgment headers")
			}
			reused := resultAckWait(t, fifthUploaded, "next local job with four completed uploads")
			if parent.Err() != nil {
				t.Error("runtime worker reuse depended on caller cancellation")
			}
			cancel()
			finish()
			awaitNetworkSignal(t, done, "runtime cancellation after acknowledgment handling")
			if runErr != nil {
				t.Error("caller cancellation changed graceful runtime shutdown")
			}
			want := 4
			if reused {
				want = 5
			}
			mu.Lock()
			defer mu.Unlock()
			if int(calls.Load()) != want || len(byID) != want {
				t.Error("acknowledgment handling lost a job or repeated local inference")
			}
			for _, count := range byID {
				if count != 1 {
					t.Error("acknowledgment handling repeated a claimed result upload")
				}
			}
		})
	}
}

func TestResultAcknowledgmentWhileUploadOpenHTTP2(t *testing.T) {
	for _, mode := range []string{"stalled_response", "finite_response"} {
		t.Run(mode, func(t *testing.T) {
			var calls, uploads atomic.Int32
			ackStarted, localCanceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			finish := sync.OnceFunc(func() { close(release) })
			client, _ := resultAckTLSClient(t, true, http.NotFound, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/connector/cancel/") {
					<-r.Context().Done()
					return
				}
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+networkLeaseToken {
					t.Error("early acknowledgment escaped the assigned upload boundary")
				}
				uploads.Add(1)
				decoder := json.NewDecoder(r.Body)
				var meta, data frame
				if decoder.Decode(&meta) != nil || decoder.Decode(&data) != nil || meta.Type != "meta" || meta.Status != http.StatusOK ||
					data.Type != "data" || string(data.Data) != streamTimeoutPrefix {
					t.Error("early acknowledgment fixture did not reach a live partial upload")
				}
				w.Header().Set("Content-Length", "1")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = io.WriteString(w, "{")
				if http.NewResponseController(w).Flush() != nil {
					t.Error("fixture could not flush early response headers and data")
				}
				close(ackStarted)
				if mode == "stalled_response" {
					// Sending the advertised byte does not finish an HTTP/2
					// response. This handler withholds END_STREAM while the
					// local stream and upload producer also remain open.
					select {
					case <-release:
					case <-r.Context().Done():
					}
				}
				// The finite control returns immediately to deliver END_STREAM.
			}, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, streamTimeoutPrefix)
				_ = http.NewResponseController(w).Flush()
				<-r.Context().Done()
				close(localCanceled)
			})
			parent, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			done := make(chan struct{})
			t.Cleanup(func() {
				cancel()
				finish()
				awaitNetworkSignal(t, done, "early acknowledgment worker cleanup")
			})
			go func() {
				defer close(done)
				client.execute(parent, networkLeaseToken, streamTimeoutJob(time.Now().Add(8*time.Second)))
			}()
			awaitNetworkSignal(t, ackStarted, "early HTTP/2 response headers and data")
			resultAckWait(t, done, "HTTP/2 worker with a pending upload producer")
			if parent.Err() != nil {
				t.Error("early acknowledgment completion depended on caller cancellation")
			}
			cancel()
			finish()
			awaitNetworkSignal(t, done, "early acknowledgment cleanup after caller cancellation")
			awaitNetworkSignal(t, localCanceled, "local inference cancellation after early acknowledgment")
			if calls.Load() != 1 || uploads.Load() != 1 {
				t.Error("early acknowledgment handling repeated inference or result upload")
			}
		})
	}
}
