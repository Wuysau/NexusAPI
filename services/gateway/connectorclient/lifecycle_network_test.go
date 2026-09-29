package connectorclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const networkLeaseToken = "nxlease_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func networkLease(w http.ResponseWriter, token string, duration time.Duration) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"leaseToken": token, "expiresAt": time.Now().Add(duration)})
}

func networkJob(w http.ResponseWriter) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(job{ID: "req_00000000000000000000000000000001", Model: "qwen2.5:7b",
		Body: json.RawMessage(`{"model":"qwen2.5:7b","stream":true,"messages":[{"role":"user","content":"private-fixture-prompt"}]}`), Deadline: time.Now().Add(10 * time.Second)})
}

func networkClient(t *testing.T, control, gateway, inference http.HandlerFunc) (*Client, Identity) {
	t.Helper()
	cp := httptest.NewServer(control)
	t.Cleanup(cp.Close)
	gw := httptest.NewServer(gateway)
	t.Cleanup(gw.Close)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"}]}`)
			return
		}
		if r.URL.Path != "/v1/chat/completions" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		inference(w, r)
	}))
	t.Cleanup(local.Close)
	config := configFixture()
	config.ControlURL, config.GatewayURL, config.UpstreamURL = cp.URL, gw.URL, local.URL+"/v1"
	config.AllowHTTPDevelopment = true
	client, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.remote.CloseIdleConnections)
	t.Cleanup(client.local.CloseIdleConnections)
	return client, Identity{ConnectorID: "connector-network", ConnectionID: "connection-network", TenantID: "tenant-network",
		ControlURL: cp.URL, Credential: "nxidentity_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
}

func runNetworkClient(t *testing.T, client *Client, identity Identity) (context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx, identity); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("connector Run or worker did not exit after cancellation")
		}
	})
	return cancel, done
}

func awaitNetworkSignal(t *testing.T, signal <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func blockedInferenceGateway(polls *atomic.Int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/connector/poll" && polls.Add(1) == 1 {
			networkJob(w)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}
}

func TestNetworkLeaseExpiryCancelsInferenceDuringBlockedRenewal(t *testing.T) {
	var renewals, polls atomic.Int32
	renewalBlocked, inferenceStarted, inferenceCanceled := make(chan struct{}), make(chan struct{}), make(chan struct{})
	client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if renewals.Add(1) == 1 {
			networkLease(w, networkLeaseToken, 450*time.Millisecond)
			return
		}
		if renewals.Load() == 2 {
			close(renewalBlocked)
		}
		<-r.Context().Done()
	}, blockedInferenceGateway(&polls), func(w http.ResponseWriter, r *http.Request) {
		close(inferenceStarted)
		<-r.Context().Done()
		close(inferenceCanceled)
	})
	_, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, inferenceStarted, "active local inference")
	awaitNetworkSignal(t, renewalBlocked, "blocked renewal before lease expiry")
	select {
	case err := <-done:
		if !errors.Is(err, ErrLeaseExpired) {
			t.Fatalf("lease expiry was reported as a normal exit: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked renewal extended execution past the known lease deadline")
	}
	awaitNetworkSignal(t, inferenceCanceled, "local cancellation at lease expiry")
}

func TestNetworkControlAuthorizationRejectsImmediatelyAndCancelsInference(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var renewals, polls atomic.Int32
			started, canceled, denied := make(chan struct{}), make(chan struct{}), make(chan struct{})
			client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if renewals.Add(1) == 1 {
					networkLease(w, networkLeaseToken, 1500*time.Millisecond)
					return
				}
				if renewals.Load() == 2 {
					close(denied)
				}
				http.Error(w, "private-fixture-secret private-fixture-prompt", status)
			}, blockedInferenceGateway(&polls), func(w http.ResponseWriter, r *http.Request) {
				close(started)
				<-r.Context().Done()
				close(canceled)
			})
			_, done := runNetworkClient(t, client, identity)
			awaitNetworkSignal(t, started, "active local inference")
			awaitNetworkSignal(t, denied, "Control Plane identity denial")
			select {
			case err := <-done:
				if !errors.Is(err, ErrAuthorizationRejected) || strings.Contains(err.Error(), "private-fixture") {
					t.Fatalf("authorization denial was hidden or leaked a remote body: %v", err)
				}
			case <-time.After(350 * time.Millisecond):
				t.Fatal("identity denial kept running until lease expiration")
			}
			awaitNetworkSignal(t, canceled, "inference cancellation after identity denial")
		})
	}
}

func TestNetworkGatewayUnauthorizedIsTransientWhileIdentityRenews(t *testing.T) {
	var polls, calls atomic.Int32
	uploaded := make(chan struct{})
	client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		networkLease(w, networkLeaseToken, 2*time.Second)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/connector/poll":
			switch polls.Add(1) {
			case 1:
				http.Error(w, "connector unauthorized", http.StatusUnauthorized)
			case 2:
				networkJob(w)
			default:
				<-r.Context().Done()
			}
		case strings.HasPrefix(r.URL.Path, "/connector/result/"):
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusNoContent)
			close(uploaded)
		default:
			<-r.Context().Done()
		}
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	cancel, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, uploaded, "successful result after transient Gateway 401")
	select {
	case err := <-done:
		t.Fatalf("Gateway 401 terminated a valid connector identity: %v", err)
	default:
	}
	cancel()
	if err := <-done; err != nil || calls.Load() != 1 {
		t.Fatalf("cancel after recovery failed or replayed: err=%v calls=%d", err, calls.Load())
	}
}

func TestNetworkFailedResultUploadNeverReexecutesLocalJob(t *testing.T) {
	var polls, calls, uploads atomic.Int32
	failedUpload := make(chan struct{})
	client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		networkLease(w, networkLeaseToken, 2*time.Second)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/connector/poll":
			if polls.Add(1) == 1 {
				networkJob(w)
				return
			}
			<-r.Context().Done()
		case strings.HasPrefix(r.URL.Path, "/connector/result/"):
			_, _ = io.Copy(io.Discard, r.Body)
			if uploads.Add(1) == 1 {
				close(failedUpload)
			}
			http.Error(w, "private-fixture-secret", http.StatusServiceUnavailable)
		default:
			<-r.Context().Done()
		}
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	cancel, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, failedUpload, "failed result upload")
	// Keep the runtime alive through a reconnect retry interval. A transport
	// recovery must neither repeat the model call nor retry a claimed upload.
	select {
	case err := <-done:
		t.Fatalf("job transport failure unexpectedly stopped polling: %v", err)
	case <-time.After(350 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil || calls.Load() != 1 || uploads.Load() != 1 {
		t.Fatalf("failed upload replayed: err=%v local_calls=%d uploads=%d", err, calls.Load(), uploads.Load())
	}
}

func TestNetworkMalformedSuccessfulPollUsesBackoff(t *testing.T) {
	for _, body := range []string{`{"id":"private-fixture-secret",`, `{}`} {
		t.Run(body, func(t *testing.T) {
			var polls, calls atomic.Int32
			started := make(chan struct{})
			client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				networkLease(w, networkLeaseToken, 2*time.Second)
			}, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/connector/poll" {
					if polls.Add(1) == 1 {
						close(started)
					}
					_, _ = io.WriteString(w, body)
					return
				}
				http.NotFound(w, r)
			}, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
			cancel, done := runNetworkClient(t, client, identity)
			awaitNetworkSignal(t, started, "malformed poll response")
			select {
			case err := <-done:
				t.Fatalf("malformed poll bypassed recoverable transport policy: %v", err)
			case <-time.After(350 * time.Millisecond):
			}
			cancel()
			if err := <-done; err != nil || polls.Load() > 8 || calls.Load() != 0 {
				t.Fatalf("malformed 200 response caused tight polling or execution: err=%v polls=%d local_calls=%d", err, polls.Load(), calls.Load())
			}
		})
	}
}

func TestNetworkStalePollFailureCannotReplaceRenewedToken(t *testing.T) {
	const rotatedToken = "nxlease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var renewals, calls atomic.Int32
	var client *Client
	uploaded := make(chan struct{})
	var mu sync.Mutex
	var tokens []string
	var identity Identity
	client, identity = networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if renewals.Add(1) == 1 {
			networkLease(w, networkLeaseToken, 600*time.Millisecond)
			return
		}
		networkLease(w, rotatedToken, 2*time.Second)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/connector/poll":
			token := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
			mu.Lock()
			tokens = append(tokens, token)
			ordinal := len(tokens)
			mu.Unlock()
			if ordinal == 1 {
				ticker := time.NewTicker(time.Millisecond)
				defer ticker.Stop()
				for client.currentLease().Token != rotatedToken {
					select {
					case <-r.Context().Done():
						return
					case <-ticker.C:
					}
				}
				http.Error(w, "old lease no longer valid", http.StatusUnauthorized)
				return
			}
			if ordinal == 2 {
				if token != rotatedToken {
					t.Errorf("stale response replaced the latest token: %q", token)
				}
				networkJob(w)
				return
			}
			<-r.Context().Done()
		case strings.HasPrefix(r.URL.Path, "/connector/result/"):
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusNoContent)
			close(uploaded)
		default:
			<-r.Context().Done()
		}
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	cancel, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, uploaded, "new-token job after stale poll rejection")
	cancel()
	if err := <-done; err != nil || calls.Load() != 1 {
		t.Fatalf("rotated-token recovery failed or replayed: err=%v local_calls=%d", err, calls.Load())
	}
}

func TestNetworkStalledPollBodyTimesOutWhileLeaseKeepsRenewing(t *testing.T) {
	var renewals, polls, calls atomic.Int32
	bodyCanceled, uploaded := make(chan struct{}), make(chan struct{})
	client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		renewals.Add(1)
		networkLease(w, networkLeaseToken, 600*time.Millisecond)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/connector/poll":
			switch polls.Add(1) {
			case 1:
				w.Header().Set("content-type", "application/json")
				_, _ = io.WriteString(w, "{")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(bodyCanceled)
			case 2:
				networkJob(w)
			default:
				<-r.Context().Done()
			}
		case strings.HasPrefix(r.URL.Path, "/connector/result/"):
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusNoContent)
			close(uploaded)
		default:
			<-r.Context().Done()
		}
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	client.pollTimeout = 80 * time.Millisecond
	cancel, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, bodyCanceled, "bounded poll response body cancellation")
	awaitNetworkSignal(t, uploaded, "new job after stalled body timeout")
	if renewals.Load() < 2 || !time.Now().Before(client.currentLease().ExpiresAt) {
		t.Fatal("fixture did not keep the connector lease alive during poll recovery")
	}
	cancel()
	if err := <-done; err != nil || calls.Load() != 1 {
		t.Fatalf("poll body timeout stopped valid runtime or replayed: err=%v local_calls=%d", err, calls.Load())
	}
}

func TestNetworkImmediateCancelWatchSuccessIsPaced(t *testing.T) {
	var polls, watches, calls atomic.Int32
	started, canceled := make(chan struct{}), make(chan struct{})
	client, identity := networkClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		networkLease(w, networkLeaseToken, 2*time.Second)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/connector/poll":
			if polls.Add(1) == 1 {
				networkJob(w)
				return
			}
			<-r.Context().Done()
		case strings.HasPrefix(r.URL.Path, "/connector/cancel/"):
			watches.Add(1)
			w.WriteHeader(http.StatusAccepted)
		default:
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusNoContent)
		}
	}, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(started)
		<-r.Context().Done()
		close(canceled)
	})
	cancel, done := runNetworkClient(t, client, identity)
	awaitNetworkSignal(t, started, "active inference with immediate 202 watch replies")
	select {
	case <-canceled:
		t.Fatal("successful cancel watch response canceled the job")
	case <-time.After(350 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil || watches.Load() < 1 || watches.Load() > 2 || calls.Load() != 1 {
		t.Fatalf("202 watch was unpaced or replayed: err=%v watches=%d local_calls=%d", err, watches.Load(), calls.Load())
	}
	awaitNetworkSignal(t, canceled, "canceling the paced watch and active inference")
}
