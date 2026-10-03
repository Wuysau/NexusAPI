package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const resultMethodOwner = "nxlease_result-method-owner"
const resultMethodOther = "nxlease_result-method-other"
const resultMethodPrivate = "private-result-method-fixture"

type resultMethodResponse struct {
	response *http.Response
	err      error
}

type resultMethodHTTP struct {
	status int
	body   string
	err    error
}

// This observer still reads the real socket. Its first Read proves that the
// authenticated upload has reached the actual result parser before interruption.
type resultMethodBody struct {
	io.ReadCloser
	reading chan<- struct{}
	once    sync.Once
}

func (b *resultMethodBody) Read(p []byte) (int, error) {
	b.once.Do(func() { b.reading <- struct{}{} })
	return b.ReadCloser.Read(p)
}

type resultMethodFixture struct {
	ctx        context.Context
	cancel     context.CancelFunc
	hub        *ConnectorHub
	server     *httptest.Server
	client     *http.Client
	job        connectorJob
	responses  chan resultMethodResponse
	reading    chan struct{}
	handled    chan struct{}
	grantScope atomic.Int32
	logs       *connectorRetryLogs
}

func newResultMethodFixture(t *testing.T, protocol int) *resultMethodFixture {
	t.Helper()
	f := &resultMethodFixture{responses: make(chan resultMethodResponse, 1), reading: make(chan struct{}, 4), handled: make(chan struct{}, 4), logs: &connectorRetryLogs{}}
	f.ctx, f.cancel = context.WithTimeout(context.Background(), 5*time.Second)
	grant := connectorGrant{LeaseID: "result-method-lease", ConnectorID: "result-method-connector", ConnectionID: "result-method-connection", TenantID: testTenantID, ExpiresAt: time.Now().Add(time.Minute), Models: []string{testModel}}
	cp := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input connectorAuth
		if r.Method != http.MethodPost || r.URL.Path != "/api/internal/gateway/connector" || r.Header.Get("Authorization") != "Bearer result-method-internal" || json.NewDecoder(r.Body).Decode(&input) != nil || (input.LeaseToken != resultMethodOwner && input.LeaseToken != resultMethodOther) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next := grant
		// Returning a changed scope for the owner token independently exercises
		// the existing tenant and connection guards rather than only token mismatch.
		switch f.grantScope.Load() {
		case 1:
			next.TenantID = "other-result-method-tenant"
		case 2:
			next.ConnectionID = "other-result-method-connection"
		}
		_ = json.NewEncoder(w).Encode(next)
	}))
	t.Cleanup(cp.Close)
	f.hub = NewConnectorHub(cp.URL, "result-method-internal")
	f.hub.client = cp.Client() // The private fixture certificate is verified.
	f.hub.client.Timeout = 5 * time.Second
	f.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != protocol {
			t.Errorf("result request used HTTP/%d, want HTTP/%d", r.ProtoMajor, protocol)
		}
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/connector/result/") {
			r.Body = &resultMethodBody{ReadCloser: r.Body, reading: f.reading}
			defer func() { f.handled <- struct{}{} }()
		}
		f.hub.ServeHTTP(w, r)
	}))
	f.server.EnableHTTP2 = protocol == 2
	f.server.Config.ErrorLog = log.New(f.logs, "", 0)
	f.server.StartTLS()
	t.Cleanup(f.server.Close)
	f.client = f.server.Client() // Verify TLS for both HTTP/1 and HTTP/2.
	var transportDone <-chan struct{}
	pollDone := make(chan struct{})
	t.Cleanup(func() {
		f.cancel()
		awaitUploadCancel(t, pollDone, "result-method poll cleanup")
		if transportDone != nil {
			awaitUploadCancel(t, transportDone, "result-method transport cleanup")
		}
		f.client.CloseIdleConnections()
		f.hub.client.CloseIdleConnections()
		if strings.Contains(f.logs.String(), resultMethodPrivate) {
			t.Error("result routing disclosed private job data in server logs")
		}
	})
	polled := make(chan connectorJob, 1)
	pollErrors := make(chan error, 1)
	go func() {
		defer close(pollDone)
		r, _ := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+"/connector/poll", nil)
		r.Header.Set("Authorization", "Bearer "+resultMethodOwner)
		res, err := f.client.Do(r)
		if err != nil {
			pollErrors <- err
			return
		}
		defer res.Body.Close()
		var j connectorJob
		if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&j) != nil {
			pollErrors <- errors.New("authenticated job poll failed")
			return
		}
		polled <- j
	}()
	channel := &SnapshotChannel{ID: "result-method-channel", ConnectionID: grant.ConnectionID, TenantID: testTenantID, Models: grant.Models}
	for f.hub.session(channel) == nil {
		select {
		case err := <-pollErrors:
			t.Fatal(err)
		case <-f.ctx.Done():
			t.Fatal("actual poll did not establish a live session")
		case <-time.After(time.Millisecond):
		}
	}
	transport := connectorTransport{hub: f.hub, channel: channel, identity: &Identity{TenantID: testTenantID, ProjectID: "result-method-project", OrganizationID: testOrgID, KeyID: testKeyID}, model: testModel}
	r, err := http.NewRequestWithContext(f.ctx, http.MethodPost, "https://connector.invalid/v1/chat/completions", strings.NewReader(`{"model":"`+testModel+`","stream":true,"messages":[{"role":"user","content":"`+resultMethodPrivate+`"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	transportDone = done
	go func() {
		defer close(done)
		res, err := transport.RoundTrip(r)
		f.responses <- resultMethodResponse{res, err}
	}()
	select {
	case f.job = <-polled:
	case err := <-pollErrors:
		t.Fatal(err)
	case <-f.ctx.Done():
		t.Fatal("actual transport job was not delivered through polling")
	}
	return f
}

func (f *resultMethodFixture) request(ctx context.Context, method, path, token string, body io.Reader) resultMethodHTTP {
	r, err := http.NewRequestWithContext(ctx, method, f.server.URL+path, body)
	if err != nil {
		return resultMethodHTTP{err: err}
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/x-ndjson")
	res, err := f.client.Do(r)
	if err != nil {
		return resultMethodHTTP{err: err}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	return resultMethodHTTP{res.StatusCode, string(raw), err}
}

func (f *resultMethodFixture) resultPath() string { return "/connector/result/" + f.job.ID }

func (f *resultMethodFixture) expectStatus(t *testing.T, got resultMethodHTTP, want int) {
	t.Helper()
	if got.err != nil || got.status != want {
		t.Fatalf("HTTP status=%d error=%v, want %d", got.status, got.err, want)
	}
	for _, private := range []string{resultMethodPrivate, resultMethodOwner, resultMethodOther, "result-method-internal"} {
		if strings.Contains(got.body, private) {
			t.Fatal("result routing disclosed private job data or credentials")
		}
	}
}

const resultMethodComplete = "{\"type\":\"meta\",\"status\":200}\n{\"type\":\"end\"}\n"

func (f *resultMethodFixture) expectComplete(t *testing.T) {
	t.Helper()
	got := awaitUploadCancel(t, f.responses, "valid result metadata")
	if got.err != nil || got.response == nil {
		t.Fatalf("valid result did not publish metadata: error=%v", got.err)
	}
	defer got.response.Body.Close()
	body, err := io.ReadAll(got.response.Body)
	if got.response.StatusCode != http.StatusOK || len(body) != 0 || err != nil {
		t.Fatal("valid result did not preserve metadata and normal EOF")
	}
}

func TestConnectorResultRejectedMethodPreservesFirstUpload(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, tc := range []struct {
			name, method, path, token string
			status                    int
			scope                     int32
		}{
			{name: "normal_post"},
			{name: "result_get", method: "GET", path: "result", token: resultMethodOwner, status: 404},
			{name: "result_head", method: "HEAD", path: "result", token: resultMethodOwner, status: 404},
			{name: "result_options", method: "OPTIONS", path: "result", token: resultMethodOwner, status: 404},
			{name: "unauthenticated_get", method: "GET", path: "result", token: "unavailable", status: 401},
			{name: "other_lease_get", method: "GET", path: "result", token: resultMethodOther, status: 404},
			{name: "other_tenant_get", method: "GET", path: "result", token: resultMethodOwner, status: 404, scope: 1},
			{name: "other_connection_get", method: "GET", path: "result", token: resultMethodOwner, status: 404, scope: 2},
			{name: "cancel_post", method: "POST", path: "cancel", token: resultMethodOwner, status: 404},
		} {
			t.Run("http"+string(rune('0'+protocol))+"/"+tc.name, func(t *testing.T) {
				f := newResultMethodFixture(t, protocol)
				if tc.method != "" {
					f.grantScope.Store(tc.scope)
					f.expectStatus(t, f.request(f.ctx, tc.method, "/connector/"+tc.path+"/"+f.job.ID, tc.token, nil), tc.status)
					f.grantScope.Store(0)
				}
				f.expectStatus(t, f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, strings.NewReader(resultMethodComplete)), http.StatusNoContent)
				f.expectComplete(t)
			})
		}
	}
}

func TestConnectorResultAcceptedPOSTKeepsSingleClaim(t *testing.T) {
	for _, protocol := range []int{1, 2} {
		for _, scenario := range []string{"overlapping_uploads", "malformed_json", "interrupted_upload"} {
			t.Run("http"+string(rune('0'+protocol))+"/"+scenario, func(t *testing.T) {
				f := newResultMethodFixture(t, protocol)
				switch scenario {
				case "overlapping_uploads":
					pr, pw := io.Pipe()
					t.Cleanup(func() { _ = pw.Close(); _ = pr.Close() })
					first := make(chan resultMethodHTTP, 1)
					go func() { first <- f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, pr) }()
					awaitUploadCancel(t, f.reading, "first upload parser entry")
					// The first legal upload remains active. A concurrent legal POST
					// must neither replace it nor consume another result opportunity.
					f.expectStatus(t, f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, strings.NewReader(resultMethodComplete)), http.StatusNotFound)
					if _, err := io.WriteString(pw, resultMethodComplete); err != nil {
						t.Fatal("first upload lost its result claim")
					}
					_ = pw.Close()
					f.expectStatus(t, awaitUploadCancel(t, first, "first upload acknowledgment"), http.StatusNoContent)
					f.expectComplete(t)
				case "malformed_json":
					f.expectStatus(t, f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, strings.NewReader("{\"type\":\"meta\",\"status\":\"private-result-method-fixture\"}\n")), http.StatusBadGateway)
					failed := awaitUploadCancel(t, f.responses, "malformed upload transport failure")
					if failed.response != nil || failed.err == nil {
						t.Fatal("malformed accepted POST published success metadata")
					}
					f.expectStatus(t, f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, strings.NewReader(resultMethodComplete)), http.StatusNotFound)
				case "interrupted_upload":
					pr, pw := io.Pipe()
					t.Cleanup(func() { _ = pw.Close(); _ = pr.Close() })
					ctx, cancel := context.WithCancel(f.ctx)
					defer cancel()
					first := make(chan resultMethodHTTP, 1)
					go func() { first <- f.request(ctx, http.MethodPost, f.resultPath(), resultMethodOwner, pr) }()
					awaitUploadCancel(t, f.reading, "interrupted upload parser entry")
					if _, err := io.WriteString(pw, "{\"type\":"); err != nil {
						t.Fatal("partial upload did not reach the real HTTP body")
					}
					cancel()
					_ = pw.Close()
					got := awaitUploadCancel(t, first, "interrupted upload client cleanup")
					if !errors.Is(got.err, context.Canceled) {
						t.Fatalf("upload interruption error=%v, want canceled", got.err)
					}
					awaitUploadCancel(t, f.handled, "interrupted upload handler cleanup")
					failed := awaitUploadCancel(t, f.responses, "interrupted upload transport failure")
					if failed.response != nil || failed.err == nil {
						t.Fatal("interrupted accepted POST published success metadata")
					}
					f.expectStatus(t, f.request(f.ctx, http.MethodPost, f.resultPath(), resultMethodOwner, strings.NewReader(resultMethodComplete)), http.StatusNotFound)
				}
			})
		}
	}
}
