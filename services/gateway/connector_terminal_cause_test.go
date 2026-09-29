package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConnectorTerminalCauseSurvivesCleanupBeforeRead(t *testing.T) {
	for _, tc := range []struct {
		name  string
		frame string
		want  error
	}{
		{"timeout", `{"type":"error","code":"timeout"}`, context.DeadlineExceeded},
		{"unavailable", `{"type":"error","code":"unavailable"}`, errConnectorUnavailable},
		{"complete", `{"type":"end"}`, nil},
		{"caller_cancellation", "", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			channel := SnapshotChannel{ID: "terminal-channel", ConnectionID: "terminal-connection", TenantID: testTenantID}
			grant := connectorGrant{LeaseID: "terminal-lease", ConnectorID: "terminal-connector", ConnectionID: channel.ConnectionID, TenantID: testTenantID, ExpiresAt: time.Now().Add(time.Minute)}
			cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(grant)
			}))
			defer cp.Close()
			hub := NewConnectorHub(cp.URL, "terminal-internal-fixture")
			session := &connectorSession{token: "nxlease_terminal-fixture", grant: grant, queue: make(chan *connectorJob, 1), seen: time.Now(), polling: 1}
			hub.sessions[channel.ConnectionID] = session
			server := httptest.NewServer(hub)
			defer server.Close()
			guard, stopGuard := context.WithTimeout(context.Background(), 2*time.Second)
			defer stopGuard()
			requestCtx, cancelRequest := context.WithCancel(guard)
			defer cancelRequest()
			transport := connectorTransport{hub: hub, channel: &channel, identity: &Identity{TenantID: testTenantID}, model: testModel}
			request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, "https://connector.invalid/v1/chat/completions", strings.NewReader(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			type result struct {
				response *http.Response
				err      error
			}
			responses := make(chan result, 1)
			go func() {
				response, err := transport.RoundTrip(request)
				responses <- result{response, err}
			}()
			var job *connectorJob
			select {
			case job = <-session.queue:
			case <-guard.Done():
				t.Fatal("authorized request did not enter the connector queue")
			}
			pr, pw := io.Pipe()
			defer pr.Close()
			defer pw.Close()
			upload, err := http.NewRequestWithContext(guard, http.MethodPost, server.URL+"/connector/result/"+job.ID, pr)
			if err != nil {
				t.Fatal(err)
			}
			upload.Header.Set("Authorization", "Bearer "+session.token)
			upload.Header.Set("Content-Type", "application/x-ndjson")
			uploaded := make(chan result, 1)
			go func() {
				response, err := server.Client().Do(upload)
				if response != nil {
					_, _ = io.Copy(io.Discard, response.Body)
					_ = response.Body.Close()
				}
				uploaded <- result{response, err}
			}()
			if _, err := io.WriteString(pw, "{\"type\":\"meta\",\"status\":200}\n"); err != nil {
				t.Fatal(err)
			}
			var response *http.Response
			select {
			case got := <-responses:
				if got.err != nil || got.response == nil {
					t.Fatalf("response metadata was not delivered: %v", got.err)
				}
				response = got.response
			case <-guard.Done():
				t.Fatal("RoundTrip did not publish the response body")
			}
			defer response.Body.Close()
			if tc.frame == "" {
				cancelRequest()
			} else if _, err := io.WriteString(pw, tc.frame+"\n"); err != nil {
				t.Fatal(err)
			}
			_ = pw.Close()
			select {
			case got := <-uploaded:
				if got.err != nil {
					t.Fatalf("result upload did not finish: %v", got.err)
				}
				if tc.name == "complete" && got.response.StatusCode != http.StatusNoContent {
					t.Fatal("valid end frame did not complete the upload")
				}
			case <-guard.Done():
				t.Fatal("terminal result upload did not exit")
			}
			// Successful EOF does not itself cancel the job. Cancel its original
			// context after the end frame so the same cleanup path is exercised.
			cancelRequest()
			for {
				hub.mu.Lock()
				_, exists := hub.jobs[job.ID]
				hub.mu.Unlock()
				if !exists {
					break
				}
				select {
				case <-guard.Done():
					t.Fatal("job cleanup did not finish")
				case <-time.After(time.Millisecond):
				}
			}
			// Reading only after cleanup removes scheduler luck: cleanup must
			// preserve the first writer-side terminal cause for the consumer.
			body, err := io.ReadAll(response.Body)
			if len(body) != 0 || !errors.Is(err, tc.want) {
				t.Fatalf("cleanup changed the terminal result: body=%q err=%v, want %v", body, err, tc.want)
			}
		})
	}
}
