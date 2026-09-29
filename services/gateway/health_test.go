package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type healthPingFunc func(context.Context) error

func (f healthPingFunc) Ping(ctx context.Context) error { return f(ctx) }

func TestHealthProbesUseLiveResultsAndBoundedContexts(t *testing.T) {
	available := false
	ping := healthPingFunc(func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > readinessTimeout {
			t.Error("dependency probe has no bounded deadline")
		}
		if !available {
			return errors.New("private database hostname must not appear")
		}
		return nil
	})
	for _, healthy := range []bool{false, true, false} {
		available = healthy
		checks := probeDependencies(context.Background(), ping, ping)
		if checks["database"] != healthy || checks["redis"] != healthy {
			t.Fatalf("live dependency state not reflected: %+v", checks)
		}
	}
}

func TestHealthProbesRunConcurrently(t *testing.T) {
	firstStarted, secondStarted := make(chan struct{}), make(chan struct{})
	ping := func(started, other chan struct{}) healthPingFunc {
		return func(ctx context.Context) error {
			close(started)
			select {
			case <-other:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	checks := probeDependencies(ctx, ping(firstStarted, secondStarted), ping(secondStarted, firstStarted))
	if !checks["database"] || !checks["redis"] {
		t.Fatalf("checks=%v", checks)
	}
}

func TestReadinessNeedsFreshSnapshot(t *testing.T) {
	now := time.Now()
	h := newHarness(t, harnessOptions{Clock: func() time.Time { return now }})
	check := func(want int) {
		t.Helper()
		r := httptest.NewRecorder()
		h.handler.ServeHTTP(r, httptest.NewRequest("GET", "/readyz", nil))
		if r.Code != want || r.Header().Get("cache-control") != "no-store" {
			t.Fatalf("status=%d headers=%v body=%s", r.Code, r.Header(), r.Body.String())
		}
	}
	check(503)
	warmHealthSnapshot(t, h)
	check(200)
	now = now.Add(24 * time.Hour)
	check(503)
}

func TestReadinessRequiresPlatformDirectoryEvenWithFreshTenant(t *testing.T) {
	now := time.Now()
	h := newHarness(t, harnessOptions{Clock: func() time.Time { return now }, PlatformExpiresIn: time.Minute, ExpiresIn: time.Hour})
	if _, err := h.snapshots.Get(context.Background(), h.tenantID); err != nil {
		t.Fatal(err)
	}
	if h.snapshots.Ready() {
		t.Fatal("tenant-only snapshot cannot authenticate new API keys")
	}
	warmHealthSnapshot(t, h)
	if !h.snapshots.Ready() {
		t.Fatal("fresh platform directory should be ready")
	}
	now = now.Add(2 * time.Minute)
	r := httptest.NewRecorder()
	h.handler.ServeHTTP(r, httptest.NewRequest("GET", "/readyz", nil))
	if r.Code != 503 {
		t.Fatalf("expired directory hidden by fresh tenant: %s", r.Body.String())
	}
}

func warmHealthSnapshot(t *testing.T, h *testHarness) {
	t.Helper()
	if _, err := h.snapshots.Get(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
}

func TestReadinessRequiresDatabaseAndKeepsLiveness(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	warmHealthSnapshot(t, h)
	h.store.Close()
	for _, tc := range []struct {
		path string
		want int
	}{{"/readyz", 503}, {"/healthz", 200}} {
		r := httptest.NewRecorder()
		h.handler.ServeHTTP(r, httptest.NewRequest("GET", tc.path, nil))
		if r.Code != tc.want {
			t.Fatalf("%s: status=%d body=%s", tc.path, r.Code, r.Body.String())
		}
	}
}

func TestReadinessRedisProfileIsExplicit(t *testing.T) {
	for _, environment := range []string{"development", "production"} {
		t.Run(environment, func(t *testing.T) {
			h := newHarness(t, harnessOptions{})
			h.proxy.env.Environment = environment
			warmHealthSnapshot(t, h)
			r := httptest.NewRecorder()
			h.handler.ServeHTTP(r, httptest.NewRequest("GET", "/readyz", nil))
			want := 200
			if environment == "production" {
				want = 503
			}
			if r.Code != want || !strings.Contains(r.Body.String(), `"redis":false`) {
				t.Fatalf("status=%d body=%s", r.Code, r.Body.String())
			}
		})
	}
}

type waitingHealthStore struct{ Store }

func (s waitingHealthStore) Ping(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }

func TestReadinessProbeHonorsRequestDeadline(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	warmHealthSnapshot(t, h)
	handler := NewHTTPRouter(h.proxy, h.snapshots, h.limiter, waitingHealthStore{h.store}, RouteOptions{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	r := httptest.NewRecorder()
	started := time.Now()
	handler.ServeHTTP(r, httptest.NewRequest("GET", "/readyz", nil).WithContext(ctx))
	if r.Code != 503 || time.Since(started) > time.Second {
		t.Fatalf("probe failed to bound dependency failure: status=%d elapsed=%s", r.Code, time.Since(started))
	}
}

func TestPublicVersionOmitsRoutingIdentities(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.breaker.Open(BreakerKey("private-tenant-channel", "private-finetuned-model"))
	r := httptest.NewRecorder()
	h.handler.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/versionz", nil))
	if r.Code != 200 || strings.Contains(r.Body.String(), "private-") || !strings.Contains(r.Body.String(), `"open":1`) {
		t.Fatalf("public diagnostics disclose routing identities or lack summary: %s", r.Body.String())
	}
}
