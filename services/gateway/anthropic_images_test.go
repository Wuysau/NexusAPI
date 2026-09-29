package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAnthropicImagesReachNativeUpstreamWithoutFetchingMedia(t *testing.T) {
	var mediaConnections atomic.Int32
	media := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Gateway fetched an image instead of forwarding its reference")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	media.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mediaConnections.Add(1)
		}
	}
	media.StartTLS()
	t.Cleanup(media.Close)
	const imageMarker = "private-image-reference-9f6d"
	imageURL := media.URL + "/" + imageMarker + ".png"
	const imageData = "aW1hZ2UtZml4dHVyZQ=="
	text := map[string]any{"type": "text", "text": "describe fixture"}
	canonicalURL := map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageURL, "detail": "auto"}}
	canonicalData := map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64," + imageData}}
	nativeURL := map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": imageURL}}
	nativeData := map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": imageData}}
	tools := []any{map[string]any{"id": "call_image", "type": "function", "function": map[string]any{"name": "image_metadata", "arguments": "{}"}}}
	nativeTool := map[string]any{"type": "tool_use", "id": "call_image", "name": "image_metadata", "input": map[string]any{}}
	for _, tc := range []struct {
		name     string
		messages []map[string]any
		want     []map[string]any
	}{
		{"user URL and base64", []map[string]any{{"role": "user", "content": []any{canonicalURL, text, canonicalData}}}, []map[string]any{{"role": "user", "content": []any{nativeURL, text, nativeData}}}},
		{"assistant history", []map[string]any{{"role": "assistant", "content": []any{text, canonicalURL}}, {"role": "user", "content": "continue"}}, []map[string]any{{"role": "assistant", "content": []any{text, nativeURL}}, {"role": "user", "content": "continue"}}},
		{"assistant tool history", []map[string]any{{"role": "assistant", "content": []any{canonicalData, text}, "tool_calls": tools}, {"role": "tool", "tool_call_id": "call_image", "content": "metadata"}}, []map[string]any{{"role": "assistant", "content": []any{nativeData, text, nativeTool}}, {"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "call_image", "content": "metadata"}}}}},
		{"image tool result", []map[string]any{{"role": "assistant", "content": nil, "tool_calls": tools}, {"role": "tool", "tool_call_id": "call_image", "content": []any{canonicalURL, text, canonicalData}}}, []map[string]any{{"role": "assistant", "content": []any{nativeTool}}, {"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "call_image", "content": []any{nativeURL, text, nativeData}}}}}},
		{"existing native image", []map[string]any{{"role": "user", "content": []any{nativeURL, text, nativeData}}}, []map[string]any{{"role": "user", "content": []any{nativeURL, text, nativeData}}}},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, stream), func(t *testing.T) {
				var calls atomic.Int32
				h := newHarness(t, harnessOptions{EnableUsageV2: true, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body struct{ Messages []map[string]any }
					if json.NewDecoder(r.Body).Decode(&body) != nil || !reflect.DeepEqual(body.Messages, tc.want) {
						w.WriteHeader(http.StatusBadRequest)
						_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","message":"Invalid image content."}}`)
						return
					}
					adapterFixtureResponse(w, r)
				}})
				setValidationProvider(t, h, "anthropic")
				var logs bytes.Buffer
				h.proxy.logger = slog.New(slog.NewTextHandler(&logs, nil))
				response := h.doChat(chatBody(chatBodyOptions{Stream: stream, Messages: tc.messages}), nil)
				body := readAll(response)
				if response.StatusCode != http.StatusOK || calls.Load() != 1 || !strings.Contains(body, "Hello") {
					t.Fatalf("image request did not reach native contract: status=%d calls=%d", response.StatusCode, calls.Load())
				}
				records := h.store.Requests()
				if len(records) != 1 || len(records[0].Attempts) != 1 || records[0].Status != string(OutcomeCompleted) || records[0].EventV2 == nil || h.store.OutboxCount(testTenantID) != 1 || h.managed.reserveCount() != 1 {
					t.Fatal("image translation changed attributed execution cardinality")
				}
				facts, _ := json.Marshal(records)
				for _, marker := range []string{imageMarker, imageData} {
					if bytes.Contains(facts, []byte(marker)) || strings.Contains(logs.String(), marker) {
						t.Fatal("image reference or data leaked into execution facts or logs")
					}
				}
			})
		}
	}
	if mediaConnections.Load() != 0 {
		t.Fatal("Gateway attempted to connect to an image reference")
	}
}

func TestAnthropicUnsupportedImagesRejectBeforeCredentialsAndReservation(t *testing.T) {
	image := func(url string) map[string]any {
		return map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}}
	}
	for _, tc := range []struct {
		name, role string
		content    any
	}{
		{"system image", "system", []any{map[string]any{"type": "text", "text": "system fixture"}, image("https://fixture.invalid/private-image")}},
		{"developer image", "developer", []any{image("https://fixture.invalid/private-image")}},
		{"system native image", "system", []any{map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": "https://fixture.invalid/private-image"}}}},
		{"system discarded field", "system", []any{map[string]any{"type": "text", "text": "fixture", "cache_control": map[string]any{"type": "ephemeral"}}}},
		{"detail low", "user", []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/image", "detail": "low"}}}},
		{"detail high", "user", []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/image", "detail": "high"}}}},
		{"file URL", "user", []any{image("file:///private/image.png")}},
		{"relative URL", "user", []any{image("/private/image.png")}},
		{"plaintext URL", "user", []any{image("http://fixture.invalid/private-image")}},
		{"embedded userinfo", "user", []any{image("https://private-user:private-pass@fixture.invalid/image")}},
		{"invalid base64", "user", []any{image("data:image/png;base64,private-base64!")}},
		{"unsupported media", "user", []any{image("data:image/svg+xml;base64,PHN2Zy8+")}},
		{"unknown image option", "user", []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://fixture.invalid/image", "private_extra": true}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				adapterFixtureResponse(w, r)
			}})
			setValidationProvider(t, h, "anthropic")
			credentials := &countedValidationCredentials{CredentialResolver: h.proxy.credentials}
			h.proxy.credentials = credentials
			headers := map[string]string{"Idempotency-Key": "image-before-execution"}
			response := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": tc.role, "content": tc.content}, {"role": "user", "content": "continue"}}}), headers)
			body := readAll(response)
			var failure errorEnvelope
			_ = json.Unmarshal([]byte(body), &failure)
			if response.StatusCode != http.StatusBadRequest || failure.Error.Code != CodeUnsupportedParam || failure.Error.Param == nil || *failure.Error.Param != "messages" || strings.Contains(body, "private-") {
				t.Fatalf("unsupported image input was not rejected safely: status=%d code=%s", response.StatusCode, failure.Error.Code)
			}
			if calls.Load() != 0 || credentials.calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Fatal("unsupported images crossed credentials or execution")
			}
			corrected := h.doChat(chatBody(chatBodyOptions{Messages: []map[string]any{{"role": "user", "content": "corrected text"}}}), headers)
			_ = readAll(corrected)
			if corrected.StatusCode != http.StatusOK || calls.Load() != 1 || h.managed.reserveCount() != 1 {
				t.Fatal("corrected text could not reuse its undispatched idempotency key")
			}
		})
	}
}
