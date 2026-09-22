package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func poolGet(t *testing.T, client *http.Client, target string) {
	t.Helper()
	resp, err := client.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
}

func TestLocalCredentialPoolReuseAcrossResolutionsAndRevocation(t *testing.T) {
	var connections atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	dir, ref, envelope := localCredentialFixture(t, server.URL)
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	var client *http.Client
	deadlines := map[time.Time]bool{}
	for i := 0; i < 3; i++ {
		c, err := r.Resolve(context.Background(), ref)
		if err != nil {
			t.Fatal(err)
		}
		deadlines[c.AuthorizationExpiresAt] = true
		client, err = r.BoundClient(ref, c)
		if err != nil {
			t.Fatal(err)
		}
		poolGet(t, client, server.URL)
	}
	if connections.Load() != int32(len(deadlines)) {
		t.Fatalf("equivalent fresh resolutions opened %d connections, want %d", connections.Load(), len(deadlines))
	}
	envelope["fingerprint"] = strings.Repeat("0", 64)
	writeLocalFixture(t, dir, ref, envelope)
	if resp, err := client.Get(server.URL); err == nil {
		_ = resp.Body.Close()
		t.Fatal("revoked grant used idle connection")
	}
	if connections.Load() != int32(len(deadlines)) {
		t.Fatal("revoked grant dialed")
	}
}

func TestVaultCredentialPoolReusesGuardedConnectionAndRejectsExpiry(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	var connections atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true // The resolver must configure the isolated clones for reuse.
	transport.TLSClientConfig.ServerName = server.Certificate().DNSNames[0]
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		connections.Add(1)
		conn, err := (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		if err != nil {
			return nil, err
		}
		return guardSecretConnection(ctx, conn)
	}
	r.outbound = transport
	c, err := r.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	client, err := r.BoundClient(fixtureRef, c)
	if err != nil {
		t.Fatal(err)
	}
	poolGet(t, client, "https://api.example.com/v1/models")
	poolGet(t, client, "https://api.example.com/v1/models")
	if connections.Load() != 1 {
		t.Fatalf("opened %d guarded connections, want 1", connections.Load())
	}
	r.now = func() time.Time { return c.AuthorizationExpiresAt.Add(time.Second) }
	if resp, err := client.Get("https://api.example.com/v1/models"); err == nil {
		_ = resp.Body.Close()
		t.Fatal("expired grant used idle connection")
	}
	if connections.Load() != 1 {
		t.Fatal("expired grant dialed")
	}
}

func TestCredentialPoolIsolatesEveryAuthorizationDimension(t *testing.T) {
	p := newCredentialTransportPool()
	defer func() { _ = p.Close() }()
	key := credentialPoolKey{Reference: CredentialRef{TenantID: "a", CredentialID: "b", CredentialVersion: 1, ProviderID: "p", Mode: "byok", BaseURL: "https://api.example.com/v1", Protocol: "openai", Model: "m"}, Binding: "encrypted-digest", Target: "https://api.example.com", Policy: "vault-public-v1", Deadline: time.Now().Add(time.Minute), GrantDeadline: time.Now().Add(time.Minute)}
	first, err := p.acquire(key, &http.Transport{})
	if err != nil {
		t.Fatal(err)
	}
	same, err := p.acquire(key, &http.Transport{})
	if err != nil || same != first {
		t.Fatal("same immutable grant did not reuse transport")
	}
	for _, field := range []string{"tenant", "credential", "version", "provider", "mode", "base", "protocol", "model", "binding", "deadline", "grantDeadline", "target", "policy"} {
		t.Run(field, func(t *testing.T) {
			changed := key
			switch field {
			case "tenant":
				changed.Reference.TenantID += "x"
			case "credential":
				changed.Reference.CredentialID += "x"
			case "version":
				changed.Reference.CredentialVersion++
			case "provider":
				changed.Reference.ProviderID += "x"
			case "mode":
				changed.Reference.Mode = "managed"
			case "base":
				changed.Reference.BaseURL += "/other"
			case "protocol":
				changed.Reference.Protocol = "anthropic"
			case "model":
				changed.Reference.Model += "x"
			case "binding":
				changed.Binding += "x"
			case "deadline":
				changed.Deadline = changed.Deadline.Add(time.Second)
			case "grantDeadline":
				changed.GrantDeadline = changed.GrantDeadline.Add(time.Second)
			case "target":
				changed.Target = "https://other.example.com"
			case "policy":
				changed.Policy += "x"
			}
			entry, err := p.acquire(changed, &http.Transport{})
			if err != nil || entry == first {
				t.Fatal("authorization domains shared a transport")
			}
		})
	}
}

func TestLocalCredentialPoolChecksRevocationAtReusedSocketWrite(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	dir, ref, envelope := localCredentialFixture(t, server.URL)
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	c, err := r.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	client, err := r.BoundClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	poolGet(t, client, server.URL)
	var reused atomic.Bool
	trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if info.Reused {
			reused.Store(true)
		}
		envelope["fingerprint"] = strings.Repeat("0", 64)
		writeLocalFixture(t, dir, ref, envelope)
	}}
	req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), http.MethodPost, server.URL, strings.NewReader("synthetic"))
	resp, err := client.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err == nil || !reused.Load() || calls.Load() != 1 {
		t.Fatalf("revoked authorization crossed reused socket write boundary: err=%v reused=%v calls=%d", err, reused.Load(), calls.Load())
	}
}

func TestCredentialPoolBoundedLifecycleAndShutdown(t *testing.T) {
	p := newCredentialTransportPool()
	p.limit = 2
	key := credentialPoolKey{Binding: "a", Deadline: time.Now().Add(time.Minute)}
	first, err := p.acquire(key, &http.Transport{})
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []string{"b", "c", "d"} {
		key.Binding = binding
		if _, err := p.acquire(key, &http.Transport{}); err != nil {
			t.Fatal(err)
		}
	}
	if len(p.entries) != 2 || !first.retired.Load() {
		t.Fatal("pool did not bound and retire old transports")
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if len(p.entries) != 0 || p.timer != nil {
		t.Fatal("shutdown retained pool entries or timer")
	}
	if _, err := p.acquire(key, &http.Transport{}); err == nil {
		t.Fatal("shutdown allowed new transport")
	}

	p = newCredentialTransportPool()
	defer func() { _ = p.Close() }()
	key.Deadline = time.Now().Add(20 * time.Millisecond)
	entry, err := p.acquire(key, &http.Transport{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !entry.retired.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) != 0 || !entry.retired.Load() || p.timer != nil {
		t.Fatal("expired pool was not reclaimed without another request")
	}
}

func TestCredentialPoolEvictsOldestWhenClockTicksTie(t *testing.T) {
	// Wall-clock resolution must not decide which grant is least recently used.
	// Repeated independent pools also exercise Go's randomized map iteration.
	for i := 0; i < 32; i++ {
		p := newCredentialTransportPool()
		p.limit = 2
		key := credentialPoolKey{Binding: "a", Deadline: time.Now().Add(time.Minute)}
		first, err := p.acquire(key, &http.Transport{})
		if err != nil {
			t.Fatal(err)
		}
		key.Binding = "b"
		second, err := p.acquire(key, &http.Transport{})
		if err != nil {
			t.Fatal(err)
		}
		p.mu.Lock()
		second.used = first.used
		p.mu.Unlock()
		key.Binding = "c"
		_, err = p.acquire(key, &http.Transport{})
		if err != nil {
			t.Fatal(err)
		}
		retiredFirst, retiredSecond := first.retired.Load(), second.retired.Load()
		_ = p.Close()
		if !retiredFirst || retiredSecond {
			t.Fatal("equal clock ticks evicted a newer grant")
		}
	}
}

func TestCredentialGrantWindowsNeverExtendMaximumLifetime(t *testing.T) {
	start := time.Now().Truncate(15 * time.Second)
	for _, offset := range []time.Duration{0, time.Nanosecond, 14 * time.Second, 15*time.Second - time.Nanosecond} {
		now := start.Add(offset)
		expires := credentialGrantExpiry(now)
		if expires != start.Add(30*time.Second) || expires.Sub(now) > 30*time.Second || expires.Sub(now) <= 15*time.Second {
			t.Fatal("grant window exceeded bounded immutable deadline")
		}
	}
}

func TestLocalCredentialPoolSeparatesDeadlinesAndRejectsExpiredReusedWrite(t *testing.T) {
	var connections, calls atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	dir, ref, _ := localCredentialFixture(t, server.URL)
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	c, err := r.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.BoundClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	var firstConn net.Conn
	firstTrace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { firstConn = info.Conn }}
	firstReq, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), firstTrace), http.MethodGet, server.URL, nil)
	firstResponse, err := first.Do(firstReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, firstResponse.Body)
	_ = firstResponse.Body.Close()
	c.AuthorizationExpiresAt = time.Now().Add(250 * time.Millisecond)
	second, err := r.BoundClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	poolGet(t, second, server.URL)
	if connections.Load() != 2 {
		t.Fatal("different deadlines reused one authorization closure")
	}
	var reused atomic.Bool
	trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if info.Reused {
			reused.Store(true)
		}
		time.Sleep(time.Until(c.AuthorizationExpiresAt) + 5*time.Millisecond)
	}}
	req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), http.MethodPost, server.URL, strings.NewReader("synthetic"))
	resp, err := second.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err == nil || !reused.Load() || calls.Load() != 2 {
		t.Fatal("expired grant crossed reused socket write boundary")
	}
	// The older grant still has its own valid socket and callback.
	var validReused bool
	validTrace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { validReused = info.Reused && info.Conn == firstConn }}
	validReq, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), validTrace), http.MethodGet, server.URL, nil)
	validResponse, err := first.Do(validReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, validResponse.Body)
	_ = validResponse.Body.Close()
	if !validReused {
		t.Fatal("expiring another grant closed a valid pool")
	}
}

func TestVaultCredentialPoolChecksRevocationAtReusedSocketWrite(t *testing.T) {
	f := newRegistryFixture(t)
	r, err := NewVaultCredentialResolver(f.config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = server.Certificate().DNSNames[0]
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		if err != nil {
			return nil, err
		}
		return guardSecretConnection(ctx, conn)
	}
	r.outbound = transport
	c, err := r.Resolve(context.Background(), fixtureRef)
	if err != nil {
		t.Fatal(err)
	}
	client, err := r.BoundClient(fixtureRef, c)
	if err != nil {
		t.Fatal(err)
	}
	poolGet(t, client, "https://api.example.com/v1/models")
	var reused atomic.Bool
	trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if info.Reused {
			reused.Store(true)
		}
		f.payload.RegistryVersion++
		f.payload.RevocationEpoch++
		f.payload.Entries = []RegistryEntry{}
		f.write()
	}}
	req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), http.MethodPost, "https://api.example.com/v1/models", strings.NewReader("synthetic"))
	resp, err := client.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err == nil || !reused.Load() || calls.Load() != 1 {
		t.Fatal("revoked Vault grant crossed reused socket write boundary")
	}
}

func TestCredentialPoolEvictionClosesActiveConnectionAfterBodyCompletion(t *testing.T) {
	finish := make(chan struct{})
	closed := make(chan struct{}, 2)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/stream" {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-finish
			_, _ = io.WriteString(w, "done")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closed <- struct{}{}
		}
	}
	server.Start()
	defer server.Close()
	var finishOnce atomic.Bool
	defer func() {
		if finishOnce.CompareAndSwap(false, true) {
			close(finish)
		}
	}()
	dir, ref, _ := localCredentialFixture(t, server.URL)
	r, err := NewLocalCredentialResolver(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	r.pool.limit = 1
	c, err := r.Resolve(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.BoundClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	response, err := first.Get(server.URL + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	c.AuthorizationExpiresAt = c.AuthorizationExpiresAt.Add(-time.Second)
	second, err := r.BoundClient(ref, c)
	if err != nil {
		t.Fatal(err)
	}
	poolGet(t, second, server.URL+"/other")
	if finishOnce.CompareAndSwap(false, true) {
		close(finish)
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("evicted active transport retained its connection after body completion")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown retained an idle connection")
	}
}
