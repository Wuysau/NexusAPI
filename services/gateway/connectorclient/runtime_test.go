package connectorclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type runtimeTransport func(*http.Request) (*http.Response, error)

func (f runtimeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func runtimeResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func runtimeClient(t *testing.T, transport runtimeTransport) (*Client, Identity) {
	t.Helper()
	c, err := New(configFixture())
	if err != nil {
		t.Fatal(err)
	}
	c.remote = &http.Client{Transport: transport}
	c.local = &http.Client{Transport: runtimeTransport(func(*http.Request) (*http.Response, error) {
		return runtimeResponse(200, `{"data":[{"id":"qwen2.5:7b"}]}`), nil
	})}
	return c, Identity{ControlURL: c.config.ControlURL, Credential: "nxidentity_fixture"}
}

func runtimeLease(duration time.Duration) string {
	raw, _ := json.Marshal(lease{Token: "nxlease_fixture", ExpiresAt: time.Now().Add(duration)})
	return string(raw)
}

func TestRunLeaseExpiryDoesNotWaitForRenewalInterval(t *testing.T) {
	var renewals atomic.Int32
	c, identity := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/connector/lease" {
			if renewals.Add(1) == 1 {
				return runtimeResponse(200, runtimeLease(100*time.Millisecond)), nil
			}
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	defer cancel()
	if err := c.Run(ctx, identity); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("lease expiry must stop Run with its specific error: %v", err)
	}
	if ctx.Err() != nil {
		t.Fatal("Run waited for caller cancellation instead of the lease deadline")
	}
}

func TestRunMalformedPollResponsesAreBounded(t *testing.T) {
	for _, body := range []string{`{`, `{}`} {
		t.Run(body, func(t *testing.T) {
			var polls atomic.Int32
			c, identity := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/api/connector/lease" {
					return runtimeResponse(200, runtimeLease(time.Minute)), nil
				}
				polls.Add(1)
				return runtimeResponse(200, body), nil
			})
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := c.Run(ctx, identity); err != nil {
				t.Fatal(err)
			}
			if count := polls.Load(); count != 1 {
				t.Fatalf("malformed response retried without backoff: %d polls", count)
			}
		})
	}
}

func TestRunFastEmptyPollResponsesAreBounded(t *testing.T) {
	var polls atomic.Int32
	c, identity := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/connector/lease" {
			return runtimeResponse(200, runtimeLease(time.Minute)), nil
		}
		polls.Add(1)
		return runtimeResponse(http.StatusNoContent, ""), nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := c.Run(ctx, identity); err != nil || polls.Load() != 1 {
		t.Fatalf("rapid empty response bypassed backoff: err=%v polls=%d", err, polls.Load())
	}
}

func TestDecodeBoundedJSONRejectsIncompleteAndTrailingResponses(t *testing.T) {
	for _, body := range []string{`{"ok":true}{}`, `{"ok":true}junk`, `{"ok":`, `{"ok":true}` + strings.Repeat(" ", 32)} {
		var out map[string]any
		if err := decodeBoundedJSON(strings.NewReader(body), 20, &out); !errors.Is(err, errRemote) {
			t.Fatalf("invalid or oversized full response accepted: %q", body)
		}
	}
	var out map[string]any
	if err := decodeBoundedJSON(strings.NewReader(`{"ok":true}`), 11, &out); err != nil || out["ok"] != true {
		t.Fatalf("complete JSON at the limit rejected: %v", err)
	}
}

func TestPollValidatesEnvelopeBeforeExecution(t *testing.T) {
	valid := job{ID: "req_00000000000000000000000000000001", Model: "qwen2.5:7b", Body: json.RawMessage(`{"model":"qwen2.5:7b"}`), Deadline: time.Now().Add(time.Minute)}
	for _, tc := range []struct {
		name string
		edit func(*job)
	}{
		{"missing ID", func(j *job) { j.ID = "" }},
		{"path ID", func(j *job) { j.ID = "../secret" }},
		{"missing model", func(j *job) { j.Model = "" }},
		{"unconfigured model", func(j *job) { j.Model = "other"; j.Body = json.RawMessage(`{"model":"other"}`) }},
		{"mismatched body", func(j *job) { j.Body = json.RawMessage(`{"model":"other"}`) }},
		{"missing body", func(j *job) { j.Body = nil }},
		{"null body", func(j *job) { j.Body = json.RawMessage(`null`) }},
		{"expired deadline", func(j *job) { j.Deadline = time.Now().Add(-time.Second) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			j := valid
			tc.edit(&j)
			raw, _ := json.Marshal(j)
			c, _ := runtimeClient(t, func(*http.Request) (*http.Response, error) { return runtimeResponse(200, string(raw)), nil })
			if _, empty, err := c.poll(context.Background(), "lease"); empty || !errors.Is(err, errRemote) {
				t.Fatal("invalid job was accepted for execution")
			}
		})
	}
	raw, _ := json.Marshal(valid)
	for _, body := range []string{string(raw) + `{}`, string(raw) + strings.Repeat(" ", 2<<20)} {
		c, _ := runtimeClient(t, func(*http.Request) (*http.Response, error) { return runtimeResponse(200, body), nil })
		if _, _, err := c.poll(context.Background(), "lease"); !errors.Is(err, errRemote) {
			t.Fatal("job with trailing or oversized response accepted")
		}
	}
	// Additive protocol fields do not make a fully valid job unusable.
	body := strings.TrimSuffix(string(raw), "}") + `,"futureProtocolField":true}`
	c, _ := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 35*time.Second {
			t.Error("poll body has no bounded request deadline")
		}
		return runtimeResponse(200, body), nil
	})
	if j, empty, err := c.poll(context.Background(), "lease"); err != nil || empty || j.ID != valid.ID {
		t.Fatalf("valid job rejected: %v", err)
	}
}

func TestPairIsSingleAttemptAndOnlyLeaseAuthDenialIsTerminal(t *testing.T) {
	for _, status := range []int{401, 403, 429, 500} {
		var calls atomic.Int32
		c, _ := runtimeClient(t, func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return runtimeResponse(status, "private-token-and-prompt"), nil
		})
		if _, err := c.Pair(context.Background(), "nxpair_fixture"); !errors.Is(err, errRemote) || calls.Load() != 1 {
			t.Fatalf("one-time pairing changed retry/error behavior: %v calls=%d", err, calls.Load())
		}
		var out lease
		err := c.remoteJSON(context.Background(), "/api/connector/lease", "nxidentity_fixture", nil, &out)
		want := errRemote
		if status == 401 || status == 403 {
			want = ErrAuthorizationRejected
		}
		if !errors.Is(err, want) || strings.Contains(err.Error(), "private") {
			t.Fatalf("incorrect or unsanitized lease error for status %d: %v", status, err)
		}
	}
}

func TestCallerCancellationDuringInitialRenewalIsGraceful(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c, identity := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
		cancel()
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	defer cancel()
	if err := c.Run(ctx, identity); err != nil {
		t.Fatalf("initial caller cancellation was reported as failure: %v", err)
	}
}

func TestRenewalCannotReviveExpiredLease(t *testing.T) {
	c, identity := runtimeClient(t, func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		// Simulate a response delivered by a transport despite cancellation.
		return runtimeResponse(200, runtimeLease(time.Minute)), nil
	})
	before := lease{Token: "old-token", ExpiresAt: time.Now().Add(20 * time.Millisecond)}
	c.lease = before
	if err := c.renew(context.Background(), identity, true); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("late successful response revived an expired lease: %v", err)
	}
	if got := c.currentLease(); got != before {
		t.Fatal("late renewal overwrote the expired lease")
	}
}

func TestWatchLeaseRechecksCurrentExpiryAfterOldTimerFires(t *testing.T) {
	c, _ := runtimeClient(t, nil)
	c.lease = lease{Token: "token", ExpiresAt: time.Now().Add(40 * time.Millisecond)}
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	changed := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() { c.watchLease(ctx, cancel, changed); close(done) }()
	// Deliberately omit a notification to exercise rechecking after the old
	// deadline, even when renewal notification and timer delivery race.
	c.mu.Lock()
	c.lease.ExpiresAt = time.Now().Add(time.Second)
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		t.Fatalf("old timer expired a renewed lease: %v", context.Cause(ctx))
	case <-time.After(80 * time.Millisecond):
	}
	c.mu.Lock()
	c.lease.ExpiresAt = time.Now().Add(-time.Millisecond)
	c.mu.Unlock()
	changed <- struct{}{}
	select {
	case <-done:
		if !errors.Is(context.Cause(ctx), ErrLeaseExpired) {
			t.Fatal("current expired lease was not canceled")
		}
	case <-time.After(time.Second):
		t.Fatal("lease update did not wake watchdog")
	}
}

func TestActiveLeaseDoesNotCancelFromStaleSnapshot(t *testing.T) {
	c, _ := runtimeClient(t, nil)
	c.lease = lease{Token: "old-token", ExpiresAt: time.Now().Add(-time.Second)}
	stale := c.currentLease()
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	renewed := lease{Token: "new-token", ExpiresAt: time.Now().Add(time.Minute)}
	c.mu.Lock()
	c.lease = renewed
	c.mu.Unlock()
	if time.Now().Before(stale.ExpiresAt) {
		t.Fatal("fixture must reproduce an expired earlier snapshot")
	}
	// Both poll dispatch and the watchdog use this synchronized check before
	// canceling. A renewal published between snapshot and check wins.
	if current, active := c.activeLease(cancel); !active || current != renewed || ctx.Err() != nil {
		t.Fatal("expired stale snapshot canceled a valid current lease")
	}
}

func TestRenewalDelayIsEarlyAndBounded(t *testing.T) {
	if got := renewalDelay(time.Now().Add(90 * time.Second)); got != 20*time.Second {
		t.Fatalf("ordinary lease renewal changed: %v", got)
	}
	if got := renewalDelay(time.Now().Add(300 * time.Millisecond)); got < 90*time.Millisecond || got > 100*time.Millisecond {
		t.Fatalf("short lease is not renewed early: %v", got)
	}
	if got := renewalDelay(time.Now()); got != 10*time.Millisecond {
		t.Fatalf("nearly expired grants can cause a tight renewal loop: %v", got)
	}
}
