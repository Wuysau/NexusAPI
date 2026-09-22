package main

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const credentialPoolLimit = 64
const credentialPoolIdle = 15 * time.Second

// Fresh decryption still happens for every Resolve. Only the authorization
// deadline is shared within an issuance window; a grant lasts at most 30 seconds.
// This permits equivalent grants to share connections without storing plaintext.
func credentialGrantExpiry(now time.Time) time.Time {
	return now.Truncate(15 * time.Second).Add(30 * time.Second)
}

type credentialPoolKey struct {
	Reference               CredentialRef
	Binding, Target, Policy string
	Deadline                time.Time
	GrantDeadline           time.Time
}

type credentialPoolEntry struct {
	transport     *http.Transport
	expires, used time.Time
	sequence      uint64
	retired       atomic.Bool
}

// Each transport owns exactly one immutable authorization context. In
// particular, HTTP/2 multiplexing and cross-grant socket reuse are disabled:
// the socket's final-write callback must always describe its current request.
type credentialTransportPool struct {
	mu       sync.Mutex
	entries  map[[32]byte]*credentialPoolEntry
	timer    *time.Timer
	closed   bool
	limit    int
	sequence uint64
}

func newCredentialTransportPool() *credentialTransportPool {
	return &credentialTransportPool{entries: make(map[[32]byte]*credentialPoolEntry), limit: credentialPoolLimit}
}

func (p *credentialTransportPool) retire(key [32]byte, entry *credentialPoolEntry) {
	delete(p.entries, key)
	entry.retired.Store(true)
	entry.transport.CloseIdleConnections()
}

func (p *credentialTransportPool) sweep(now time.Time) {
	for key, entry := range p.entries {
		if !now.Before(entry.expires) || !now.Before(entry.used.Add(credentialPoolIdle)) {
			p.retire(key, entry)
		}
	}
}

func (p *credentialTransportPool) schedule(now time.Time) {
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.closed || len(p.entries) == 0 {
		return
	}
	next := now.Add(credentialPoolIdle)
	for _, entry := range p.entries {
		if entry.expires.Before(next) {
			next = entry.expires
		}
		if idle := entry.used.Add(credentialPoolIdle); idle.Before(next) {
			next = idle
		}
	}
	p.timer = time.AfterFunc(time.Until(next), func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.sweep(time.Now())
		p.schedule(time.Now())
	})
}

func (p *credentialTransportPool) acquire(key credentialPoolKey, template *http.Transport) (*credentialPoolEntry, error) {
	raw, err := json.Marshal(key)
	if err != nil {
		return nil, errSecretPolicy
	}
	digest := sha256.Sum256(raw)
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if p.closed || template == nil || !now.Before(key.Deadline) {
		return nil, errSecretPolicy
	}
	p.sweep(now)
	p.sequence++
	if entry := p.entries[digest]; entry != nil {
		entry.used = now
		entry.sequence = p.sequence
		p.schedule(now)
		return entry, nil
	}
	if len(p.entries) >= p.limit {
		var oldestKey [32]byte
		var oldest *credentialPoolEntry
		for k, e := range p.entries {
			if oldest == nil || e.sequence < oldest.sequence {
				oldestKey, oldest = k, e
			}
		}
		if oldest != nil {
			p.retire(oldestKey, oldest)
		}
	}
	transport := template.Clone()
	transport.DisableKeepAlives = false
	transport.MaxIdleConns = 2
	transport.MaxIdleConnsPerHost = 2
	transport.MaxConnsPerHost = 16
	transport.IdleConnTimeout = credentialPoolIdle
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	if transport.TLSClientConfig != nil {
		transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	}
	entry := &credentialPoolEntry{transport: transport, expires: key.Deadline, used: now, sequence: p.sequence}
	p.entries[digest] = entry
	p.schedule(now)
	return entry, nil
}

func (p *credentialTransportPool) roundTrip(key credentialPoolKey, template *http.Transport, req *http.Request) (*http.Response, error) {
	entry, err := p.acquire(key, template)
	if err != nil {
		return nil, err
	}
	response, err := entry.transport.RoundTrip(req)
	if err != nil {
		if entry.retired.Load() {
			entry.transport.CloseIdleConnections()
		}
		return nil, err
	}
	response.Body = &credentialPoolBody{ReadCloser: response.Body, entry: entry}
	return response, nil
}

type credentialPoolBody struct {
	io.ReadCloser
	entry *credentialPoolEntry
	once  sync.Once
}

func (b *credentialPoolBody) release() {
	b.once.Do(func() {
		if b.entry.retired.Load() {
			b.entry.transport.CloseIdleConnections()
		}
	})
}

func (b *credentialPoolBody) Read(buf []byte) (int, error) {
	n, err := b.ReadCloser.Read(buf)
	if err != nil {
		b.release()
	}
	return n, err
}

func (b *credentialPoolBody) Close() error {
	err := b.ReadCloser.Close()
	b.release()
	return err
}

func (p *credentialTransportPool) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	for key, entry := range p.entries {
		p.retire(key, entry)
	}
	return nil
}
