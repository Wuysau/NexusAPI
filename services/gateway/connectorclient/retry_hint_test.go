package connectorclient

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type retryHintUpload struct {
	raw      []byte
	started  time.Time
	finished time.Time
}

func retryHintExecuteHTTP(t *testing.T, status int, headers map[string]string, run bool) retryHintUpload {
	t.Helper()
	const model = "qwen2.5:7b"
	j := job{ID: "req_00000000000000000000000000000001", Model: model, Body: json.RawMessage(`{"model":"qwen2.5:7b","messages":[{"role":"user","content":"hello"}]}`), Deadline: time.Now().Add(time.Minute)}
	var upstreamCalls, polls atomic.Int32
	uploads := make(chan []byte, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = io.WriteString(w, `{"data":[{"id":"qwen2.5:7b"}]}`)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected local request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		upstreamCalls.Add(1)
		for name, value := range headers {
			w.Header().Set(name, value)
		}
		w.Header().Set("X-Upstream-Private", "private-header-value")
		w.Header().Set("Set-Cookie", "private-cookie-value")
		w.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		} else {
			_, _ = io.WriteString(w, `{"error":{"message":"private-error-body"}}`)
		}
	}))
	t.Cleanup(upstream.Close)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/connector/lease":
			_ = json.NewEncoder(w).Encode(lease{Token: "nxlease_retry_fixture", ExpiresAt: time.Now().Add(time.Minute)})
		case r.URL.Path == "/connector/poll":
			if polls.Add(1) == 1 {
				_ = json.NewEncoder(w).Encode(j)
				return
			}
			<-r.Context().Done()
		case r.URL.Path == "/connector/cancel/"+j.ID:
			<-r.Context().Done()
		case r.URL.Path == "/connector/result/"+j.ID:
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("read uploaded frames: %v", err)
			}
			select {
			case uploads <- raw:
			case <-r.Context().Done():
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected remote request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(gateway.Close)
	cfg := configFixture()
	cfg.UpstreamURL, cfg.GatewayURL, cfg.ControlURL = upstream.URL+"/v1", gateway.URL, gateway.URL
	cfg.AllowHTTPDevelopment = true
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.local.CloseIdleConnections)
	t.Cleanup(client.remote.CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	done := make(chan error, 1)
	started := time.Now()
	go func() {
		if run {
			done <- client.Run(ctx, Identity{ControlURL: cfg.ControlURL, Credential: "nxidentity_retry_fixture"})
			return
		}
		client.execute(ctx, "nxlease_retry_fixture", j)
		done <- nil
	}()
	var raw []byte
	select {
	case raw = <-uploads:
	case <-ctx.Done():
		t.Fatal("connector did not upload the local response")
	}
	finished := time.Now()
	if run {
		cancel()
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("connector runtime failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connector worker did not stop after upload")
	}
	if upstreamCalls.Load() != 1 {
		t.Fatalf("retry hint caused local request replay: %d upstream calls", upstreamCalls.Load())
	}
	return retryHintUpload{raw: raw, started: started, finished: finished}
}

func retryHintCheckUpload(t *testing.T, upload retryHintUpload, status int, wantMin, wantMax int64) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(upload.raw))
	var frames []map[string]json.RawMessage
	for {
		var value map[string]json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			if err != io.EOF {
				t.Fatalf("invalid uploaded NDJSON: %v", err)
			}
			break
		}
		frames = append(frames, value)
	}
	if len(frames) != 3 || string(frames[0]["type"]) != `"meta"` || string(frames[1]["type"]) != `"data"` || string(frames[2]["type"]) != `"end"` {
		t.Fatalf("unexpected result envelope: %s", upload.raw)
	}
	meta := frames[0]
	if string(meta["status"]) != strconv.Itoa(status) {
		t.Fatalf("upstream status lost: %s", meta["status"])
	}
	if wantMax == 0 {
		if _, present := meta["retry_after_ms"]; present {
			t.Fatalf("unusable hint must be omitted: %s", meta["retry_after_ms"])
		}
	} else {
		var millis int64
		if err := json.Unmarshal(meta["retry_after_ms"], &millis); err != nil || millis < wantMin || millis > wantMax {
			t.Fatalf("normalized retry_after_ms = %s, want %d..%d (decode error %v)", meta["retry_after_ms"], wantMin, wantMax, err)
		}
	}
	for name := range meta {
		if name != "type" && name != "status" && name != "retry_after_ms" {
			t.Fatalf("unexpected upstream metadata forwarded: %s", name)
		}
	}
	for _, frame := range frames[1:] {
		if _, exists := frame["retry_after_ms"]; exists {
			t.Fatal("retry hint escaped the meta frame")
		}
	}
	var data []byte
	if err := json.Unmarshal(frames[1]["data"], &data); err != nil {
		t.Fatal(err)
	}
	wantData := `{"error":{"message":"Local upstream request failed"}}`
	if status == http.StatusOK {
		wantData = "data: [DONE]\n\n"
	}
	if string(data) != wantData {
		t.Fatalf("connector forwarded unexpected local response data: %q", data)
	}
	for _, private := range []string{"private-header-value", "private-cookie-value", "private-error-body", "private-retry-value", "X-Upstream-Private", "Set-Cookie", "Retry-After", "retry-after-ms", "x-ms-retry-after-ms"} {
		if bytes.Contains(upload.raw, []byte(private)) || bytes.Contains(data, []byte(private)) {
			t.Fatalf("upload contains private upstream metadata: %q", private)
		}
	}
	// An older Gateway decoder with only the original fields must still read
	// the added metadata field and preserve the original response envelope.
	var legacy struct {
		Type   string `json:"type"`
		Status int    `json:"status,omitempty"`
		Data   []byte `json:"data,omitempty"`
		Code   string `json:"code,omitempty"`
	}
	if err := json.NewDecoder(bytes.NewReader(upload.raw)).Decode(&legacy); err != nil || legacy.Type != "meta" || legacy.Status != status {
		t.Fatalf("new hint broke legacy frame decoding: %+v, %v", legacy, err)
	}
}

func TestExecuteUploadsOnlyNormalizedRetryHint(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			for _, tc := range []struct {
				name   string
				values map[string]string
				want   int64
			}{
				{"seconds", map[string]string{"Retry-After": "12"}, 12000},
				{"trimmed_seconds", map[string]string{"Retry-After": " 12 "}, 12000},
				{"milliseconds", map[string]string{"retry-after-ms": "1250"}, 1250},
				{"azure_milliseconds", map[string]string{"x-ms-retry-after-ms": "150"}, 150},
				{"header_precedence", map[string]string{"retry-after-ms": "50", "x-ms-retry-after-ms": "250", "Retry-After": "20"}, 50},
				{"invalid_ms_falls_through", map[string]string{"retry-after-ms": "private-retry-value", "x-ms-retry-after-ms": "250"}, 250},
				{"zero_ms_falls_through", map[string]string{"retry-after-ms": "0", "x-ms-retry-after-ms": "250"}, 250},
				{"invalid_ms_falls_to_seconds", map[string]string{"retry-after-ms": "NaN", "x-ms-retry-after-ms": "-2", "Retry-After": "3"}, 3000},
				{"future_date_capped", map[string]string{"Retry-After": time.Now().UTC().Add(24 * time.Hour).Format(http.TimeFormat)}, 60000},
				{"past_date", map[string]string{"Retry-After": time.Now().UTC().Add(-time.Hour).Format(http.TimeFormat)}, 0},
				{"huge_seconds", map[string]string{"Retry-After": strings.Repeat("9", 1024)}, 60000},
				{"huge_milliseconds", map[string]string{"retry-after-ms": strings.Repeat("9", 1024)}, 60000},
				{"invalid_suffix_after_overflow", map[string]string{"Retry-After": strings.Repeat("9", 1024) + "x"}, 0},
				{"missing", nil, 0},
				{"empty", map[string]string{"Retry-After": ""}, 0},
				{"zero", map[string]string{"Retry-After": "0"}, 0},
				{"negative", map[string]string{"Retry-After": "-4"}, 0},
				{"fraction", map[string]string{"Retry-After": "1.5"}, 0},
				{"multiple_values", map[string]string{"Retry-After": "1, 2"}, 0},
				{"nonfinite", map[string]string{"retry-after-ms": "NaN"}, 0},
				{"signed_number", map[string]string{"Retry-After": "+3"}, 0},
				{"unparseable", map[string]string{"Retry-After": "private-retry-value"}, 0},
			} {
				t.Run(tc.name, func(t *testing.T) {
					upload := retryHintExecuteHTTP(t, status, tc.values, false)
					retryHintCheckUpload(t, upload, status, tc.want, tc.want)
				})
			}
			t.Run("future_date", func(t *testing.T) {
				deadline := time.Now().UTC().Add(30 * time.Second).Truncate(time.Second)
				upload := retryHintExecuteHTTP(t, status, map[string]string{"Retry-After": deadline.Format(http.TimeFormat)}, false)
				ceilMillis := func(d time.Duration) int64 { return int64((d + time.Millisecond - 1) / time.Millisecond) }
				retryHintCheckUpload(t, upload, status, ceilMillis(deadline.Sub(upload.finished)), ceilMillis(deadline.Sub(upload.started)))
			})
		})
	}
}

func TestExecuteOmitsRetryHintForOtherStatuses(t *testing.T) {
	for _, status := range []int{200, 201, 204, 400, 401, 403, 404, 409, 500, 502, 504} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			upload := retryHintExecuteHTTP(t, status, map[string]string{"retry-after-ms": "1250", "Retry-After": "20"}, false)
			retryHintCheckUpload(t, upload, status, 0, 0)
		})
	}
}

func TestRunUploadsRetryHintWithoutReplayingLocalJob(t *testing.T) {
	upload := retryHintExecuteHTTP(t, http.StatusServiceUnavailable, map[string]string{"Retry-After": "2"}, true)
	retryHintCheckUpload(t, upload, http.StatusServiceUnavailable, 2000, 2000)
}

func TestLocalRetryAfterMillisRoundsPositiveRemainderUp(t *testing.T) {
	deadline := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	headers := make(http.Header)
	headers.Set("Retry-After", deadline.Format(http.TimeFormat))
	for _, tc := range []struct {
		name      string
		remaining time.Duration
		want      int64
	}{
		{"one_nanosecond", time.Nanosecond, 1},
		{"below_millisecond", time.Millisecond - time.Nanosecond, 1},
		{"exact_millisecond", time.Millisecond, 1},
		{"above_millisecond", time.Millisecond + time.Nanosecond, 2},
		{"above_second", time.Second + time.Nanosecond, 1001},
		{"current_date", 0, 0},
		{"past_date", -time.Nanosecond, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := localRetryAfterMillis(headers, deadline.Add(-tc.remaining)); got != tc.want {
				t.Fatalf("%v remainder normalized to %d ms, want %d", tc.remaining, got, tc.want)
			}
		})
	}
}
