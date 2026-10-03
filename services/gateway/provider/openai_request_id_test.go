package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const openAIRequestIDHeader = "req_r40_http_123"
const openAIRequestIDBody = "chatcmpl_r40_body_456"
const openAIRequestIDContent = "private-openai-request-id-content"
const openAIRequestIDFullUsage = `{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}`

func TestOpenAIHTTPReportedUsageCarriesRequestID(t *testing.T) {
	for _, ending := range []string{"completed", "truncated", "protocol error"} {
		for _, header := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/header=%t", ending, header), func(t *testing.T) {
				wire := openAIRequestIDContentFrame("")
				if ending == "completed" {
					wire += openAIRequestIDFinishFrame()
				}
				wire += "data: " + `{"id":"` + openAIRequestIDBody + `","choices":[],"usage":` + openAIRequestIDFullUsage + "}\n\n"
				switch ending {
				case "completed":
					wire += "data: [DONE]\n\n"
				case "protocol error":
					wire += "data: " + `{"error":{"type":"server_error","message":"private-openai-request-id-error"}}` + "\n\n"
				}
				headers, wantID := map[string]string{}, ""
				if header {
					headers["x-request-id"], wantID = openAIRequestIDHeader, openAIRequestIDHeader
				}
				stream := newOpenAIRequestIDHTTPStream(t, wire, headers)
				final, err, text, finish := openAIRequestIDReadTerminal(t, stream)
				if text != openAIRequestIDContent {
					t.Fatal("header metadata changed streamed content")
				}
				if ending == "completed" {
					if err != nil || !final.Done || finish != "stop" {
						t.Fatal("header metadata changed valid completion")
					}
				} else if final.Done || err == nil {
					t.Fatal("broken stream became successful")
				} else if ending == "truncated" && !errors.Is(err, ErrStreamTruncated) {
					t.Fatalf("truncation error changed: %v", err)
				} else if ending == "protocol error" && err.Error() != "openai: malformed or failed stream chunk" {
					t.Fatal("private provider details entered protocol error")
				}
				checkObserved(t, final.Usage, openAIRequestIDObserved(5, 2, 7, 0))
				assertOpenAIRequestIDUsage(t, final.Usage, wantID, 5, 2, 0)
			})
		}
	}
}

func TestOpenAIHTTPHeaderRequestIDPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers map[string]string
		wantID  string
	}{
		{"request-id fallback", map[string]string{"request-id": "req_fallback_123"}, "req_fallback_123"},
		{"AWS fallback", map[string]string{"x-amzn-requestid": "6b14d2a7-e5ce-4b6a-bdda-78b7285ae399"}, "6b14d2a7-e5ce-4b6a-bdda-78b7285ae399"},
		{"x-request-id first", map[string]string{"x-request-id": openAIRequestIDHeader, "request-id": "req_secondary_123", "x-amzn-requestid": "req_third_123"}, openAIRequestIDHeader},
		{"request-id before AWS", map[string]string{"request-id": "vendor/request:opaque?zone=global", "x-amzn-requestid": "req_third_123"}, "vendor/request:opaque?zone=global"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := newOpenAIRequestIDHTTPStream(t, openAIRequestIDContentFrame(openAIRequestIDFullUsage)+openAIRequestIDFinishFrame()+"data: [DONE]\n\n", tc.headers)
			final, err, text, finish := openAIRequestIDReadTerminal(t, stream)
			if err != nil || !final.Done || text != openAIRequestIDContent || finish != "stop" {
				t.Fatal("header precedence changed completion")
			}
			checkObserved(t, final.Usage, openAIRequestIDObserved(5, 2, 7, 0))
			assertOpenAIRequestIDUsage(t, final.Usage, tc.wantID, 5, 2, 0)
		})
	}
}

func TestOpenAIHTTPMalformedUsageRetainsReportedRequestID(t *testing.T) {
	wire := openAIRequestIDContentFrame(openAIRequestIDFullUsage) + "data: " + `{"id":"` + openAIRequestIDBody + `","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":20,"total_tokens":"private-openai-request-id-invalid"}}` + "\n\ndata: [DONE]\n\n"
	stream := newOpenAIRequestIDHTTPStream(t, wire, map[string]string{"x-request-id": openAIRequestIDHeader})
	first, err := stream.Next()
	if err != nil || first.Text != openAIRequestIDContent || first.Done {
		t.Fatal("known usage did not precede the malformed frame")
	}
	checkObserved(t, first.Usage, openAIRequestIDObserved(5, 2, 7, 0))
	assertOpenAIRequestIDUsage(t, first.Usage, openAIRequestIDHeader, 5, 2, 0)
	final, err, text, finish := openAIRequestIDReadTerminal(t, stream)
	if err == nil || err.Error() != "openai: malformed or failed stream chunk" || final.Done || text != "" || finish != "" {
		t.Fatal("malformed usage bypassed the static protocol guard")
	}
	checkObserved(t, final.Usage, openAIRequestIDObserved(5, 2, 7, 0))
	assertOpenAIRequestIDUsage(t, final.Usage, openAIRequestIDHeader, 5, 2, 0)
}

func TestOpenAIHTTPUsageRequestIDSurvivesPartialUpdates(t *testing.T) {
	for _, tc := range []struct {
		name, later          string
		observed             ObservedUsage
		input, output, cache int
	}{
		{"immediate usage and terminal EOF", "", openAIRequestIDObserved(5, 2, 7, 0), 5, 2, 0},
		{"partial retains observations", `{"completion_tokens":2}`, openAIRequestIDObserved(5, 2, 7, 0), 0, 2, 0},
		{"observed zero replaces input", `{"prompt_tokens":0,"completion_tokens":2,"total_tokens":2}`, openAIRequestIDObserved(0, 2, 2, 0), 0, 2, 0},
		{"new cache observation", `{"prompt_tokens_details":{"cached_tokens":1}}`, openAIRequestIDObserved(5, 2, 7, 1), 0, 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wire := openAIRequestIDContentFrame(openAIRequestIDFullUsage)
			if tc.later != "" {
				wire += "data: " + `{"id":"` + openAIRequestIDBody + `","choices":[],"usage":` + tc.later + "}\n\n"
			}
			wire += openAIRequestIDFinishFrame()
			stream := newOpenAIRequestIDHTTPStream(t, wire, map[string]string{"x-request-id": openAIRequestIDHeader})
			first, err := stream.Next()
			if err != nil || first.Text != openAIRequestIDContent || first.Done {
				t.Fatal("content with reported usage changed")
			}
			checkObserved(t, first.Usage, openAIRequestIDObserved(5, 2, 7, 0))
			assertOpenAIRequestIDUsage(t, first.Usage, openAIRequestIDHeader, 5, 2, 0)
			final, err, text, finish := openAIRequestIDReadTerminal(t, stream)
			if err != nil || !final.Done || text != "" || finish != "stop" {
				t.Fatal("partial usage changed accepted terminal EOF")
			}
			checkObserved(t, final.Usage, tc.observed)
			// Legacy integer fields still come from the last wire object, while
			// Observed retains earlier omitted cumulative fields.
			assertOpenAIRequestIDUsage(t, final.Usage, openAIRequestIDHeader, tc.input, tc.output, tc.cache)
		})
	}
}

func TestOpenAIHTTPHeaderDoesNotInventUsage(t *testing.T) {
	for _, tc := range []struct {
		name, usage                    string
		reported, truncated, malformed bool
		observed                       ObservedUsage
		input                          int
	}{
		{name: "absent usage"},
		{name: "null usage", usage: "null"},
		{name: "no usage truncated", truncated: true},
		{name: "initial malformed usage", usage: `{"completion_tokens":"private-openai-request-id-invalid"}`, malformed: true},
		{name: "empty object retains pointer", usage: `{}`, reported: true},
		{name: "all null retains pointer", usage: `{"prompt_tokens":null,"completion_tokens":null,"total_tokens":null,"prompt_tokens_details":{"cached_tokens":null},"completion_tokens_details":{"reasoning_tokens":null}}`, reported: true},
		{name: "partial usage truncated", usage: `{"prompt_tokens":5}`, reported: true, truncated: true, observed: ObservedUsage{InputTokens: observedInt(5)}, input: 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wire := openAIRequestIDContentFrame(tc.usage)
			if !tc.truncated && !tc.malformed {
				wire += openAIRequestIDFinishFrame() + "data: [DONE]\n\n"
			}
			stream := newOpenAIRequestIDHTTPStream(t, wire, map[string]string{"x-request-id": openAIRequestIDHeader})
			final, err, text, finish := openAIRequestIDReadTerminal(t, stream)
			if tc.malformed {
				if err == nil || err.Error() != "openai: malformed or failed stream chunk" || final.Done || text != "" {
					t.Fatal("initial invalid usage escaped the static protocol guard")
				}
			} else if tc.truncated {
				if !errors.Is(err, ErrStreamTruncated) || final.Done || text != openAIRequestIDContent {
					t.Fatal("header metadata changed truncated completion")
				}
			} else if err != nil || !final.Done || text != openAIRequestIDContent || finish != "stop" {
				t.Fatal("header metadata changed optional usage completion")
			}
			if !tc.reported {
				if final.Usage != nil {
					t.Fatal("response header or completion body ID invented canonical usage")
				}
				return
			}
			checkObserved(t, final.Usage, tc.observed)
			assertOpenAIRequestIDUsage(t, final.Usage, openAIRequestIDHeader, tc.input, 0, 0)
		})
	}
}

func newOpenAIRequestIDHTTPStream(t *testing.T, wire string, headers map[string]string) Stream {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer upstream-test-secret" {
			t.Error("fixture missed the authenticated compatible HTTP stream")
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Private-Upstream", "private-openai-request-id-header")
		for key, value := range headers {
			w.Header().Set(key, value)
		}
		_, _ = io.WriteString(w, wire)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	adapter := NewOpenAICompatible("openai", server.URL)
	call, err := adapter.BuildRequest(&CanonicalRequest{Model: "gpt-4o", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"private-openai-request-id-prompt"`)}}}, Credential{Secret: "upstream-test-secret"}, Endpoint{AuthScheme: "bearer"})
	if err != nil {
		t.Fatal("build synthetic provider call")
	}
	stream, err := adapter.Stream(ctx, server.Client(), call)
	if err != nil {
		t.Fatalf("open synthetic HTTP stream: %v", err)
	}
	t.Cleanup(func() {
		_ = stream.Close()
		if calls.Load() != 1 {
			t.Error("request ID changed provider execution count")
		}
	})
	return stream
}

func openAIRequestIDReadTerminal(t *testing.T, stream Stream) (CanonicalChunk, error, string, string) {
	t.Helper()
	var text, finish strings.Builder
	for i := 0; i < 8; i++ {
		chunk, err := stream.Next()
		text.WriteString(chunk.Text)
		finish.WriteString(chunk.FinishReason)
		if err != nil || chunk.Done {
			return chunk, err, text.String(), finish.String()
		}
	}
	t.Fatal("synthetic stream did not reach a bounded terminal")
	return CanonicalChunk{}, nil, "", ""
}

func assertOpenAIRequestIDUsage(t *testing.T, usage *CanonicalUsage, wantID string, input, output, cache int) {
	t.Helper()
	if usage == nil {
		t.Fatal("reported canonical usage missing")
	}
	if usage.InputTokens != input || usage.OutputTokens != output || usage.CachedInputTokens != cache || usage.ReasoningTokens != 0 || usage.Estimated || usage.LegacyMissing {
		t.Error("request ID changed legacy usage or estimate decisions")
	}
	if usage.ProviderRequestID != wantID || usage.ProviderRequestID == openAIRequestIDBody {
		t.Errorf("HTTP request ID lost or replaced by completion ID: got=%q want=%q", usage.ProviderRequestID, wantID)
	}
	raw, err := json.Marshal(usage)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-openai-request-id-prompt", openAIRequestIDContent, "upstream-test-secret", "private-openai-request-id-header", "private-openai-request-id-error", "private-openai-request-id-invalid"} {
		if strings.Contains(string(raw), private) {
			t.Error("unrelated private provider/request details entered canonical usage")
		}
	}
}

func openAIRequestIDObserved(input, output, total, cache int64) ObservedUsage {
	return ObservedUsage{InputTokens: observedInt(input), OutputTokens: observedInt(output), TotalTokens: observedInt(total), CachedInputTokens: observedInt(cache), ReasoningTokens: observedInt(0)}
}

func openAIRequestIDContentFrame(usage string) string {
	frame := `{"id":"` + openAIRequestIDBody + `","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"` + openAIRequestIDContent + `"},"finish_reason":null}]`
	if usage != "" {
		frame += `,"usage":` + usage
	}
	return "data: " + frame + "}\n\n"
}

func openAIRequestIDFinishFrame() string {
	return "data: " + `{"id":"` + openAIRequestIDBody + `","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n"
}
