package main

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestGatewayStartupFailureClosesInitializedResources(t *testing.T) {
	var closed []string
	startupErr := errors.New("startup failed before listener construction")
	err := func() error {
		cleanup := &gatewayCleanup{}
		defer cleanup.closeStartup()
		for _, name := range []string{"control_transport", "credentials", "store", "limiter", "upstream_transport", "telemetry"} {
			cleanup.add(func() { closed = append(closed, name) })
		}
		return startupErr
	}()
	if !errors.Is(err, startupErr) {
		t.Fatal(err)
	}
	want := []string{"telemetry", "upstream_transport", "limiter", "store", "credentials", "control_transport"}
	if !reflect.DeepEqual(closed, want) {
		t.Fatalf("startup resource cleanup = %v, want %v", closed, want)
	}
}

func TestGatewayListenerFailureClosesTransferredResources(t *testing.T) {
	for _, tls := range []bool{false, true} {
		t.Run(map[bool]string{false: "http", true: "https"}[tls], func(t *testing.T) {
			var closes atomic.Int32
			err := func() error {
				cleanup := &gatewayCleanup{}
				defer cleanup.closeStartup()
				cleanup.add(func() { closes.Add(1) })
				server := NewServer("127.0.0.1:invalid", nil, 16*1024, discardLogger())
				cleanup.transferTo(server)
				var serveErr error
				if tls {
					server.http.Addr = "127.0.0.1:0"
					serveErr = server.http.ListenAndServeTLS(filepath.Join(t.TempDir(), "missing.crt"), filepath.Join(t.TempDir(), "missing.key"))
				} else {
					serveErr = server.ListenAndServe()
				}
				if serveErr == nil {
					t.Fatal("listener fixture did not fail")
				}
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				return finishGatewayShutdown(ctx, server, serveErr)
			}()
			if err == nil || closes.Load() != 1 {
				t.Fatalf("listener failure did not close exactly once: err=%v closes=%d", err, closes.Load())
			}
		})
	}
}

func TestGatewayDeferredCleanupDoesNotCloseIncompleteDrain(t *testing.T) {
	release := make(chan struct{})
	done := make(chan struct{})
	server, baseURL, _ := startLifecycleServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		<-release
	}))
	server.cleanupTimeout = 20 * time.Millisecond
	t.Cleanup(func() {
		close(release)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("incomplete drain fixture did not exit")
		}
	})
	client := &http.Client{Timeout: time.Second}
	t.Cleanup(client.CloseIdleConnections)
	response, err := client.Get(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	var closed atomic.Int32
	started := time.Now()
	err = func() error {
		cleanup := &gatewayCleanup{}
		defer cleanup.closeStartup() // same defer as run(), after Shutdown returns
		cleanup.add(func() { closed.Add(1) })
		cleanup.transferTo(server)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		return finishGatewayShutdown(ctx, server, nil)
	}()
	if !errors.Is(err, ErrShutdownIncomplete) || closed.Load() != 0 {
		t.Fatalf("incomplete main shutdown closed request dependencies: err=%v closed=%d", err, closed.Load())
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("main cleanup extended emergency deadline: %s", elapsed)
	}
}

func TestGatewayTransferredCleanupClosesOnceAfterSuccessfulDrain(t *testing.T) {
	cleanup := &gatewayCleanup{}
	var closed atomic.Int32
	cleanup.add(func() { closed.Add(1) })
	server := NewServer("127.0.0.1:0", nil, 16*1024, discardLogger())
	cleanup.transferTo(server)
	cleanup.closeStartup()
	if closed.Load() != 0 {
		t.Fatal("startup defer bypassed Server ownership")
	}
	if err := finishGatewayShutdown(context.Background(), server, http.ErrServerClosed); err != nil {
		t.Fatal(err)
	}
	cleanup.closeStartup()
	if err := finishGatewayShutdown(context.Background(), server, nil); err != nil {
		t.Fatal(err)
	}
	if closed.Load() != 1 {
		t.Fatalf("normal main shutdown closed %d times", closed.Load())
	}
}
