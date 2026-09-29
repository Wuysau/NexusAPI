package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestHTTPSnapshotEnforcesCompleteBodyLimit(t *testing.T) {
	v := loadBundleVector(t)
	const limit = 8 << 20
	for _, transport := range []string{"content-length", "chunked", "gzip"} {
		for _, size := range []int{limit - 1, limit, limit + 1} {
			t.Run(transport+"/"+strconv.Itoa(size), func(t *testing.T) {
				body := append(append([]byte(nil), v.Envelope...), bytes.Repeat([]byte(" "), size-len(v.Envelope))...)
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch transport {
					case "content-length":
						w.Header().Set("Content-Length", strconv.Itoa(len(body)))
					case "chunked":
						w.(http.Flusher).Flush()
					case "gzip":
						w.Header().Set("Content-Encoding", "gzip")
						z := gzip.NewWriter(w)
						_, _ = z.Write(body)
						_ = z.Close()
						return
					}
					_, _ = w.Write(body)
				}))
				defer srv.Close()
				cache := newTestCache(t, v, &HTTPSnapshotSource{BaseURL: srv.URL, Client: srv.Client()}, time.Hour, nil)
				cache.cfg.FetchTimeout = 5 * time.Second
				state, err := cache.Get(context.Background(), v.ExpectedTenant)
				if size <= limit {
					if err != nil || state == nil || !state.Fresh(cache.now()) {
						t.Fatalf("complete snapshot within the size limit was rejected: %v", err)
					}
				} else if err == nil || state != nil || cache.entryFor(v.ExpectedTenant).state.Load() != nil {
					t.Fatalf("oversized response was truncated and accepted: state=%p err=%v", state, err)
				}
			})
		}
	}
}

func TestHTTPSnapshotRejectsTrailingData(t *testing.T) {
	v := loadBundleVector(t)
	for _, tail := range []string{` {"second":"document"}`, " malformed tail"} {
		for _, chunked := range []bool{false, true} {
			t.Run(tail+"/chunked="+strconv.FormatBool(chunked), func(t *testing.T) {
				body := append(append([]byte(nil), v.Envelope...), []byte(tail)...)
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if chunked {
						w.(http.Flusher).Flush()
					} else {
						w.Header().Set("Content-Length", strconv.Itoa(len(body)))
					}
					_, _ = w.Write(body)
				}))
				defer srv.Close()
				cache := newTestCache(t, v, &HTTPSnapshotSource{BaseURL: srv.URL, Client: srv.Client()}, time.Hour, nil)
				state, err := cache.Get(context.Background(), v.ExpectedTenant)
				if err == nil || state != nil || cache.entryFor(v.ExpectedTenant).state.Load() != nil {
					t.Fatalf("malformed complete response must not publish its valid prefix: %v", err)
				}
			})
		}
	}
}

type endlessSnapshotBody struct {
	read   int
	closed bool
}

func (b *endlessSnapshotBody) Read(p []byte) (int, error) {
	clear(p)
	b.read += len(p)
	return len(p), nil
}

func (b *endlessSnapshotBody) Close() error { b.closed = true; return nil }

func TestHTTPSnapshotStopsAndClosesOversizedBody(t *testing.T) {
	body := &endlessSnapshotBody{}
	source := &HTTPSnapshotSource{BaseURL: "https://control.example", Client: &http.Client{
		Transport: catalogTransportFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: body, Header: make(http.Header)}, nil
		}),
	}}
	got, err := source.Fetch(context.Background(), "")
	if err == nil || got != nil || !body.closed || body.read > (8<<20)+1 {
		t.Fatalf("unbounded source must fail with bounded reads and close its body: bytes=%d closed=%t err=%v", body.read, body.closed, err)
	}
}
