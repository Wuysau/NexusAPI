package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type connectorRetryLogs struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (l *connectorRetryLogs) Write(body []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.Write(body)
}

func (l *connectorRetryLogs) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.String()
}

type connectorRetryExchange struct {
	response     *http.Response
	responseBody string
	err          error
	uploadStatus int
	uploadBody   string
	logs         string
}

// A previously authenticated poll creates the session. Exercise the remaining
// real transport: per-call authorization, job queue, authenticated HTTP result
// upload, frame decoding, and RoundTrip's reconstructed response.
func exchangeConnectorRetryFrame(t *testing.T, metadata string) connectorRetryExchange {
	t.Helper()
	const leaseToken = "nxlease_retry-metadata-fixture"
	channel := SnapshotChannel{ID: "retry-channel", ConnectionID: "retry-connection", TenantID: testTenantID, ProjectID: "project-test", Models: []string{testModel}}
	grant := connectorGrant{LeaseID: "retry-lease", ConnectorID: "retry-connector", ConnectionID: channel.ConnectionID, TenantID: channel.TenantID, ExpiresAt: time.Now().Add(time.Minute), Models: channel.Models}
	logs := &connectorRetryLogs{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input connectorAuth
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.LeaseToken != leaseToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(grant)
	}))
	t.Cleanup(cp.Close)
	hub := NewConnectorHub(cp.URL, "retry-internal-fixture")
	session := &connectorSession{token: leaseToken, grant: grant, queue: make(chan *connectorJob, 1), seen: time.Now(), polling: 1}
	hub.sessions[channel.ConnectionID] = session
	server := httptest.NewUnstartedServer(hub)
	server.Config.ErrorLog = log.New(logs, "", 0)
	server.Start()
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	transport := connectorTransport{hub: hub, channel: &channel, identity: &Identity{TenantID: testTenantID, OrganizationID: testOrgID, ProjectID: "project-test", KeyID: testKeyID}, model: testModel}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://connector.invalid/v1/chat/completions", strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"fixture"}],"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	roundTrip := make(chan connectorRetryExchange, 1)
	go func() {
		response, err := transport.RoundTrip(request)
		result := connectorRetryExchange{response: response, err: err}
		if response != nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			result.responseBody = string(body)
			if readErr != nil {
				result.err = readErr
			}
		}
		roundTrip <- result
	}()
	var job *connectorJob
	select {
	case job = <-session.queue:
	case <-ctx.Done():
		t.Fatal("RoundTrip did not enqueue an authorized connector job")
	}
	// Keep a valid legacy body/end sequence. Unsupported new metadata must be
	// ignored by older gateways; it cannot make a valid result body disappear.
	const body = "fixture-response-body"
	frames := metadata + "\n" + `{"type":"data","data":"` + base64.StdEncoding.EncodeToString([]byte(body)) + `"}` + "\n" + `{"type":"end"}` + "\n"
	upload, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/connector/result/"+job.ID, strings.NewReader(frames))
	if err != nil {
		t.Fatal(err)
	}
	upload.Header.Set("Authorization", "Bearer "+leaseToken)
	upload.Header.Set("Content-Type", "application/x-ndjson")
	uploadResponse, err := server.Client().Do(upload)
	if err != nil {
		t.Fatal(err)
	}
	uploadBody, err := io.ReadAll(uploadResponse.Body)
	_ = uploadResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var result connectorRetryExchange
	select {
	case result = <-roundTrip:
	case <-ctx.Done():
		t.Fatal("result upload did not terminate the original RoundTrip")
	}
	result.uploadStatus, result.uploadBody, result.logs = uploadResponse.StatusCode, string(uploadBody), logs.String()
	return result
}

func TestConnectorRetryMetadataBoundsAndLegacyFrames(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		for _, tc := range []struct {
			name  string
			value string
			want  string
		}{
			{"legacy_missing", "", ""},
			{"null", "null", ""},
			{"zero", "0", ""},
			{"negative", "-1", ""},
			{"minimum_integer", "-9223372036854775808", ""},
			{"one_millisecond", "1", "1"},
			{"fractional_second", "1250", "1250"},
			{"cap", "60000", "60000"},
			{"over_cap", "60001", "60000"},
			{"maximum_integer", "9223372036854775807", "60000"},
		} {
			t.Run(fmt.Sprintf("%d/%s", status, tc.name), func(t *testing.T) {
				extra := ""
				if tc.value != "" {
					extra = `,"retry_after_ms":` + tc.value
				}
				got := exchangeConnectorRetryFrame(t, fmt.Sprintf(`{"type":"meta","status":%d%s}`, status, extra))
				if got.err != nil || got.response == nil || got.response.StatusCode != status || got.uploadStatus != http.StatusNoContent || got.responseBody != "fixture-response-body" {
					t.Fatalf("valid or legacy metadata broke transport: response=%v err=%v upload=%d body=%q", got.response, got.err, got.uploadStatus, got.responseBody)
				}
				if hint := got.response.Header.Get("retry-after-ms"); hint != tc.want {
					t.Fatalf("reconstructed retry hint=%q, want %q", hint, tc.want)
				}
				wantHeaders := 1
				if tc.want != "" {
					wantHeaders++
				}
				if len(got.response.Header) != wantHeaders || got.response.Header.Get("Content-Type") != "text/event-stream" {
					t.Fatalf("unexpected reconstructed response headers: %v", got.response.Header)
				}
			})
		}
	}
}

func TestConnectorRetryMetadataIgnoresOtherStatuses(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusInternalServerError} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			got := exchangeConnectorRetryFrame(t, fmt.Sprintf(`{"type":"meta","status":%d,"retry_after_ms":9223372036854775807}`, status))
			if got.err != nil || got.response == nil || got.response.StatusCode != status || got.uploadStatus != http.StatusNoContent || got.responseBody != "fixture-response-body" {
				t.Fatalf("unrelated response status changed: response=%v err=%v upload=%d", got.response, got.err, got.uploadStatus)
			}
			if len(got.response.Header) != 1 || got.response.Header.Get("retry-after-ms") != "" || got.response.Header.Get("Retry-After") != "" {
				t.Fatalf("ineligible status propagated a cooldown hint: %v", got.response.Header)
			}
		})
	}
}

func TestConnectorRetryMetadataRejectsMalformedIntegerFrames(t *testing.T) {
	for _, tc := range []struct{ name, value string }{
		{"string", `"retry-private-value"`},
		{"fraction", "1.5"},
		{"exponent", "1e3"},
		{"boolean", "true"},
		{"object", `{"secret":"retry-private-value"}`},
		{"array", `["retry-private-value"]`},
		{"positive_overflow", "9223372036854775808"},
		{"negative_overflow", "-9223372036854775809"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := exchangeConnectorRetryFrame(t, `{"type":"meta","status":503,"retry_after_ms":`+tc.value+`}`)
			if got.err == nil || got.response != nil || got.uploadStatus != http.StatusBadGateway {
				t.Fatalf("malformed frame did not fail before response publication: response=%v err=%v upload=%d", got.response, got.err, got.uploadStatus)
			}
			if got.responseBody != "" || strings.TrimSpace(got.uploadBody) != "incomplete response" {
				t.Fatalf("malformed metadata escaped the static failure boundary: body=%q upload=%q", got.responseBody, got.uploadBody)
			}
			if strings.Contains(got.err.Error()+got.uploadBody+got.logs, "retry-private-value") {
				t.Fatal("malformed retry metadata leaked its private contents")
			}
		})
	}
}

func TestConnectorRetryMetadataDoesNotForwardArbitraryHeaders(t *testing.T) {
	for _, withHint := range []bool{false, true} {
		t.Run(fmt.Sprintf("numeric_hint_%v", withHint), func(t *testing.T) {
			extra := ""
			if withHint {
				extra = `,"retry_after_ms":1250`
			}
			metadata := `{"type":"meta","status":503,"headers":{"Retry-After":"retry-private-value","Set-Cookie":"retry-private-cookie","Authorization":"retry-private-key","X-Upstream-Private":"retry-private-body"},"retry-after-ms":"retry-private-value","upstream_body":"retry-private-body"` + extra + `}`
			got := exchangeConnectorRetryFrame(t, metadata)
			if got.err != nil || got.response == nil || got.uploadStatus != http.StatusNoContent {
				t.Fatalf("unknown additive metadata broke compatibility: response=%v err=%v upload=%d", got.response, got.err, got.uploadStatus)
			}
			want, count := "", 1
			if withHint {
				want, count = "1250", 2
			}
			if got.response.Header.Get("retry-after-ms") != want || len(got.response.Header) != count {
				t.Fatalf("arbitrary metadata affected reconstructed headers: %v", got.response.Header)
			}
			visible := fmt.Sprint(got.response.Header) + got.responseBody + got.uploadBody + got.logs
			for _, marker := range []string{"retry-private-value", "retry-private-cookie", "retry-private-key", "retry-private-body"} {
				if strings.Contains(visible, marker) {
					t.Fatal("unrecognized upstream metadata leaked into transport response or HTTP logs")
				}
			}
		})
	}
}
