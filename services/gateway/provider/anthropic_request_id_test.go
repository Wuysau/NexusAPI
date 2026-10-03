package provider

import (
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

const anthropicRequestIDHeader = "req_r41_http_123"
const anthropicRequestIDBody = "msg_r41_body_456"
const anthropicRequestIDSecondBody = "msg_r41_body_789"
const anthropicRequestIDContent = "private-anthropic-request-id-content"

func TestAnthropicHTTPCompletedRequestIDSelection(t *testing.T) {
	for _, tc := range []struct {
		name         string
		headers      map[string]string
		bodyIDs      []string
		omitEmptyIDs bool
		wantID       string
	}{
		{name: "HTTP ID differs from message ID", headers: map[string]string{"request-id": anthropicRequestIDHeader}, bodyIDs: []string{anthropicRequestIDBody}, wantID: anthropicRequestIDHeader},
		{name: "message ID fallback", bodyIDs: []string{anthropicRequestIDBody}, wantID: anthropicRequestIDBody},
		{name: "HTTP ID survives repeated starts", headers: map[string]string{"request-id": anthropicRequestIDHeader}, bodyIDs: []string{anthropicRequestIDBody, anthropicRequestIDSecondBody}, wantID: anthropicRequestIDHeader},
		{name: "latest message ID fallback", bodyIDs: []string{anthropicRequestIDBody, anthropicRequestIDSecondBody}, wantID: anthropicRequestIDSecondBody},
		{name: "empty message ID with header", headers: map[string]string{"request-id": anthropicRequestIDHeader}, bodyIDs: []string{""}, wantID: anthropicRequestIDHeader},
		{name: "empty message ID without header", bodyIDs: []string{""}},
		{name: "absent message ID with header", headers: map[string]string{"request-id": anthropicRequestIDHeader}, bodyIDs: []string{""}, omitEmptyIDs: true, wantID: anthropicRequestIDHeader},
		{name: "absent message ID without header", bodyIDs: []string{""}, omitEmptyIDs: true},
		{name: "x-request-id first", headers: map[string]string{"x-request-id": anthropicRequestIDHeader, "request-id": "req_secondary_123", "x-amzn-requestid": "req_third_123"}, bodyIDs: []string{anthropicRequestIDBody}, wantID: anthropicRequestIDHeader},
		{name: "request-id before AWS", headers: map[string]string{"request-id": "vendor/request:opaque?zone=global", "x-amzn-requestid": "req_third_123"}, bodyIDs: []string{anthropicRequestIDBody}, wantID: "vendor/request:opaque?zone=global"},
		{name: "AWS fallback", headers: map[string]string{"x-amzn-requestid": "6b14d2a7-e5ce-4b6a-bdda-78b7285ae399"}, bodyIDs: []string{anthropicRequestIDBody}, wantID: "6b14d2a7-e5ce-4b6a-bdda-78b7285ae399"},
		{name: "empty x-request-id falls through", headers: map[string]string{"x-request-id": "", "request-id": anthropicRequestIDHeader}, bodyIDs: []string{anthropicRequestIDBody}, wantID: anthropicRequestIDHeader},
		{name: "empty later message ID keeps fallback", bodyIDs: []string{anthropicRequestIDBody, ""}, wantID: anthropicRequestIDBody},
		{name: "absent later message ID keeps fallback", bodyIDs: []string{anthropicRequestIDBody, ""}, omitEmptyIDs: true, wantID: anthropicRequestIDBody},
		{name: "empty header permits latest fallback", headers: map[string]string{"request-id": ""}, bodyIDs: []string{anthropicRequestIDBody, anthropicRequestIDSecondBody}, wantID: anthropicRequestIDSecondBody},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := newAnthropicRequestIDHTTPStream(t, anthropicRequestIDWire(tc.bodyIDs, tc.omitEmptyIDs), tc.headers)
			var final CanonicalChunk
			var text, finish strings.Builder
			for i := 0; i < 8; i++ {
				chunk, err := stream.Next()
				if err != nil {
					t.Fatalf("native completion failed: %v", err)
				}
				text.WriteString(chunk.Text)
				finish.WriteString(chunk.FinishReason)
				if chunk.Done {
					final = chunk
					break
				}
				if chunk.Usage != nil && chunk.Usage.ProviderRequestID != "" {
					t.Error("request ID was dispatched before message_stop")
				}
			}
			if !final.Done || text.String() != anthropicRequestIDContent || finish.String() != "stop" {
				t.Fatal("request ID selection changed native content or completion")
			}
			checkObserved(t, final.Usage, ObservedUsage{InputTokens: observedInt(5), OutputTokens: observedInt(2), CachedInputTokens: observedInt(1), ReasoningTokens: observedInt(0)})
			observed := final.Usage.Observed
			if observed.Semantics != "anthropic-inclusive-v1" || observed.CacheCreationInputTokens == nil || *observed.CacheCreationInputTokens != 1 {
				t.Error("request ID selection changed inclusive cache observations")
			}
			if final.Usage.InputTokens != 3 || final.Usage.OutputTokens != 2 || final.Usage.CachedInputTokens != 1 || final.Usage.ReasoningTokens != 0 || final.Usage.Estimated || final.Usage.LegacyMissing {
				t.Error("request ID selection changed legacy usage or estimate decisions")
			}
			if final.Usage.ProviderRequestID != tc.wantID {
				t.Errorf("selected request ID changed: got=%q want=%q", final.Usage.ProviderRequestID, tc.wantID)
			}
			raw, err := json.Marshal(final.Usage)
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"private-anthropic-request-id-prompt", anthropicRequestIDContent, "upstream-test-secret", "private-anthropic-request-id-header"} {
				if strings.Contains(string(raw), private) {
					t.Error("unrelated private HTTP/request details entered canonical usage")
				}
			}
			if chunk, err := stream.Next(); err != io.EOF || chunk.Done || chunk.Usage != nil {
				t.Error("message_stop did not remain the sole completed terminal")
			}
		})
	}
}

func newAnthropicRequestIDHTTPStream(t *testing.T, wire string, headers map[string]string) Stream {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/messages" || r.Header.Get("x-api-key") != "upstream-test-secret" || r.Header.Get("anthropic-version") != anthropicAPIVersion {
			t.Error("fixture missed the authenticated native HTTP stream")
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error("fixture could not consume synthetic request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Private-Upstream", "private-anthropic-request-id-header")
		for key, value := range headers {
			w.Header().Set(key, value)
		}
		if _, err := io.WriteString(w, wire); err != nil {
			t.Error("fixture could not write synthetic native stream")
		}
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	adapter := NewAnthropic()
	call, err := adapter.BuildRequest(&CanonicalRequest{Model: "claude-fixture", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"private-anthropic-request-id-prompt"`)}}}, Credential{Secret: "upstream-test-secret"}, Endpoint{BaseURL: server.URL})
	if err != nil {
		t.Fatal("build synthetic native provider call")
	}
	stream, err := adapter.Stream(ctx, server.Client(), call)
	if err != nil {
		t.Fatalf("open synthetic native HTTP stream: %v", err)
	}
	t.Cleanup(func() {
		_ = stream.Close()
		if calls.Load() != 1 {
			t.Error("request ID selection changed provider execution count")
		}
	})
	return stream
}

func anthropicRequestIDWire(bodyIDs []string, omitEmptyIDs bool) string {
	var wire strings.Builder
	emit := func(event, payload string) {
		wire.WriteString("event: " + event + "\ndata: " + payload + "\n\n")
	}
	for _, id := range bodyIDs {
		// Repeated starts preserve an existing permissive fallback. They are
		// a compatibility control, not a claim about official native streams.
		idField := ""
		if id != "" || !omitEmptyIDs {
			idField = `"id":` + strconv.Quote(id) + ","
		}
		emit("message_start", `{"type":"message_start","message":{`+idField+`"type":"message","role":"assistant","model":"claude-fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0,"cache_read_input_tokens":1,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":0}}}}`)
	}
	emit("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
	emit("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"`+anthropicRequestIDContent+`"}}`)
	emit("content_block_stop", `{"type":"content_block_stop","index":0}`)
	emit("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2,"output_tokens_details":{"thinking_tokens":0}}}`)
	emit("message_stop", `{"type":"message_stop"}`)
	return wire.String()
}
