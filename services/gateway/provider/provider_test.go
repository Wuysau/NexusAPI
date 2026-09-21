package provider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

func drain(t *testing.T, s Stream) []CanonicalChunk {
	t.Helper()
	var out []CanonicalChunk
	for {
		chunk, err := s.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		out = append(out, chunk)
		if chunk.Done {
			return out
		}
	}
}

// ── SSE parsing ───────────────────────────────────────────────────────

// The stream is delivered one byte at a time so every possible split point —
// inside a field name, inside a JSON string, inside a multi-byte rune — is
// exercised.
func TestSSEReaderHandlesArbitraryFragmentation(t *testing.T) {
	body := "event: message\ndata: {\"a\":1}\n\ndata: {\"b\":\"héllo\"}\n\ndata: [DONE]\n\n"
	reader := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))

	want := []string{`{"a":1}`, `{"b":"héllo"}`, `[DONE]`}
	for i, expected := range want {
		event, err := reader.Next()
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		if string(event.Data) != expected {
			t.Fatalf("event %d data = %q want %q", i, event.Data, expected)
		}
	}
	if _, err := reader.Next(); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestSSEReaderHandlesCRLFCommentsAndMultilineData(t *testing.T) {
	body := ": keep-alive\r\n" +
		"data: line1\r\n" +
		"data: line2\r\n" +
		"\r\n" +
		"data: last"
	reader := NewSSEReader(strings.NewReader(body))

	event, err := reader.Next()
	if err != nil {
		t.Fatalf("first event: %v", err)
	}
	if string(event.Data) != "line1\nline2" {
		t.Fatalf("multiline data = %q", event.Data)
	}
	// "data: last" is never terminated by a blank line, so per the SSE spec it
	// is discarded rather than dispatched.
	if event, err := reader.Next(); err != io.EOF {
		t.Fatalf("unterminated trailing event must be discarded, got %q (err %v)", event.Data, err)
	}
}

// A truncated stream (connection cut mid-event) must end cleanly, not hang and
// not panic.
func TestSSEReaderTruncatedStreamEndsCleanly(t *testing.T) {
	reader := NewSSEReader(iotest.OneByteReader(strings.NewReader("data: {\"partial\":tr")))
	event, err := reader.Next()
	if err != io.EOF {
		t.Fatalf("partial trailing event must be discarded, got %q (err %v)", event.Data, err)
	}
}

// ── OpenAI-compatible ─────────────────────────────────────────────────

func TestOpenAICompatibleBuildRequestNeverPutsSecretInBody(t *testing.T) {
	adapter := NewOpenAICompatible("openai", "https://example.invalid/v1")
	maxTokens := 16
	req := &CanonicalRequest{
		Model:     "gpt-4o",
		Messages:  []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}},
		MaxTokens: &maxTokens,
		Stream:    true,
	}
	call, err := adapter.BuildRequest(req, Credential{Ref: "cred_1", Secret: "sk-upstream-secret"}, Endpoint{AuthScheme: "bearer"})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	if strings.Contains(string(call.Body), "sk-upstream-secret") {
		t.Fatal("credential leaked into the request body")
	}
	if call.Headers["authorization"] != "Bearer sk-upstream-secret" {
		t.Fatalf("authorization header = %q", call.Headers["authorization"])
	}
	if call.URL != "https://example.invalid/v1/chat/completions" {
		t.Fatalf("url = %s", call.URL)
	}
	var decoded map[string]any
	if err := json.Unmarshal(call.Body, &decoded); err != nil {
		t.Fatalf("body: %v", err)
	}
	if opts, ok := decoded["stream_options"].(map[string]any); !ok || opts["include_usage"] != true {
		t.Fatalf("stream_options.include_usage must be requested, got %v", decoded["stream_options"])
	}
}

func TestOpenAIStreamParsesFragmentedSSEAndUsage(t *testing.T) {
	sse := "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n" +
		"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"},\"finish_reason\":null}]}\n\n" +
		"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n" +
		"data: [DONE]\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		// One byte at a time to force fragmentation at the HTTP layer too.
		for i := 0; i < len(sse); i++ {
			_, _ = w.Write([]byte{sse[i]})
			w.(http.Flusher).Flush()
		}
	}))
	defer upstream.Close()

	adapter := NewOpenAICompatible("openai", upstream.URL)
	call, err := adapter.BuildRequest(&CanonicalRequest{Model: "gpt-4o", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}, Credential{Secret: "s"}, Endpoint{AuthScheme: "bearer"})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := adapter.Stream(context.Background(), upstream.Client(), call)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer func() { _ = stream.Close() }()

	chunks := drain(t, stream)
	var text strings.Builder
	var usage *CanonicalUsage
	var finish string
	for _, c := range chunks {
		text.WriteString(c.Text)
		if c.Usage != nil {
			usage = c.Usage
		}
		if c.FinishReason != "" {
			finish = c.FinishReason
		}
	}
	if text.String() != "Hello" {
		t.Fatalf("text = %q", text.String())
	}
	if finish != "stop" {
		t.Fatalf("finish = %q", finish)
	}
	if usage == nil || usage.InputTokens != 7 || usage.OutputTokens != 3 || usage.CachedInputTokens != 2 || usage.ReasoningTokens != 1 {
		t.Fatalf("usage = %+v", usage)
	}
}

// Usage missing entirely is a first-class fixture: the core must fall back to an
// estimate and mark the event estimated, never bill zero silently.
func TestOpenAIStreamWithoutUsageReportsNil(t *testing.T) {
	sse := "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()

	adapter := NewOpenAICompatible("openai", upstream.URL)
	call, _ := adapter.BuildRequest(&CanonicalRequest{Model: "m", Stream: true}, Credential{Secret: "s"}, Endpoint{})
	stream, err := adapter.Stream(context.Background(), upstream.Client(), call)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	for _, c := range drain(t, stream) {
		if c.Done && c.Usage != nil {
			t.Fatalf("expected nil usage when the provider omits it, got %+v", c.Usage)
		}
	}
}

func TestOpenAICompatibleErrorClassification(t *testing.T) {
	adapter := NewOpenAICompatible("openai", "https://example.invalid")
	cases := []struct {
		name      string
		status    int
		body      string
		wantKind  CanonicalError
		retryable bool
	}{
		{"401", 401, `{"error":{"code":"invalid_api_key"}}`, ErrAuth, false},
		{"429", 429, `{"error":{"message":"rate limit reached"}}`, ErrRateLimit, true},
		{"quota", 429, `{"error":{"code":"insufficient_quota"}}`, ErrQuota, false},
		{"500", 500, `{"error":{"message":"server error"}}`, ErrProviderDown, true},
		{"503", 503, ``, ErrProviderDown, true},
		{"400", 400, `{"error":{"message":"bad param"}}`, ErrInvalidRequest, false},
		{"content policy", 400, `{"error":{"code":"content_policy_violation"}}`, ErrContentPolicy, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := adapter.ClassifyError(tc.status, []byte(tc.body), nil)
			if got.Kind != tc.wantKind || got.Retryable != tc.retryable {
				t.Fatalf("got %+v want kind=%s retryable=%v", got, tc.wantKind, tc.retryable)
			}
		})
	}
}

// A non-2xx response must become an UpstreamHTTPError carrying only the status,
// never the provider body.
func TestStreamNon2xxReturnsClassifiableError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"slow down","secret":"should-not-escape"}}`)
	}))
	defer upstream.Close()

	adapter := NewOpenAICompatible("openai", upstream.URL)
	call, _ := adapter.BuildRequest(&CanonicalRequest{Model: "m", Stream: true}, Credential{Secret: "s"}, Endpoint{})
	_, err := adapter.Stream(context.Background(), upstream.Client(), call)
	var upstreamErr *UpstreamHTTPError
	if !errors.As(err, &upstreamErr) {
		t.Fatalf("expected UpstreamHTTPError, got %T %v", err, err)
	}
	if upstreamErr.Status != 429 {
		t.Fatalf("status = %d", upstreamErr.Status)
	}
	if strings.Contains(err.Error(), "slow down") || strings.Contains(err.Error(), "should-not-escape") {
		t.Fatalf("error message leaked provider body: %v", err)
	}
	if got := adapter.ClassifyError(upstreamErr.Status, upstreamErr.Body, nil); got.Kind != ErrRateLimit || !got.Retryable {
		t.Fatalf("classification = %+v", got)
	}
}

// Cancelling the caller's context must abort the in-flight upstream call.
func TestStreamCancelPropagatesToUpstream(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer upstream.Close()
	defer close(release)

	adapter := NewOpenAICompatible("openai", upstream.URL)
	call, _ := adapter.BuildRequest(&CanonicalRequest{Model: "m", Stream: true}, Credential{Secret: "s"}, Endpoint{})
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := adapter.Stream(ctx, upstream.Client(), call)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer func() { _ = stream.Close() }()

	cancel()
	done := make(chan error, 1)
	go func() {
		_, err := stream.Next()
		done <- err
	}()
	select {
	case <-done:
		// Either a context error or io.EOF is acceptable; what matters is that
		// Next returns promptly instead of blocking on a dead upstream.
	case <-time.After(3 * time.Second):
		t.Fatal("stream did not observe cancellation")
	}
}

// ── Anthropic ─────────────────────────────────────────────────────────

func TestAnthropicBuildRequestMovesSystemOutOfMessages(t *testing.T) {
	adapter := NewAnthropic()
	maxTokens := 128
	req := &CanonicalRequest{
		Model: "claude-sonnet-5",
		Messages: []Message{
			{Role: "system", Content: json.RawMessage(`"be terse"`)},
			{Role: "user", Content: json.RawMessage(`"hi"`)},
		},
		MaxTokens: &maxTokens,
		Stream:    true,
	}
	call, err := adapter.BuildRequest(req, Credential{Secret: "sk-ant"}, Endpoint{})
	if err != nil {
		t.Fatal(err)
	}
	if call.Headers["x-api-key"] != "sk-ant" || call.Headers["anthropic-version"] != anthropicAPIVersion {
		t.Fatalf("headers = %v", call.Headers)
	}
	var decoded struct {
		System   string `json:"system"`
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
		MaxTokens int  `json:"max_tokens"`
		Stream    bool `json:"stream"`
	}
	if err := json.Unmarshal(call.Body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.System != "be terse" {
		t.Fatalf("system = %q", decoded.System)
	}
	if len(decoded.Messages) != 1 || decoded.Messages[0].Role != "user" {
		t.Fatalf("messages = %+v", decoded.Messages)
	}
	if decoded.MaxTokens != 128 || !decoded.Stream {
		t.Fatalf("max_tokens/stream = %d/%v", decoded.MaxTokens, decoded.Stream)
	}
}

func TestAnthropicDefaultsMaxTokensWhenClientOmitsIt(t *testing.T) {
	adapter := NewAnthropic()
	call, err := adapter.BuildRequest(&CanonicalRequest{Model: "claude-sonnet-5", Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}, Credential{Secret: "k"}, Endpoint{})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		MaxTokens int `json:"max_tokens"`
	}
	_ = json.Unmarshal(call.Body, &decoded)
	if decoded.MaxTokens != defaultAnthropicMaxTokens {
		t.Fatalf("max_tokens = %d", decoded.MaxTokens)
	}
}

func TestAnthropicStreamEvents(t *testing.T) {
	sse := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":11,\"output_tokens\":0,\"cache_read_input_tokens\":4}}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n" +
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()

	adapter := NewAnthropic()
	call, _ := adapter.BuildRequest(&CanonicalRequest{Model: "claude-sonnet-5", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}, Credential{Secret: "k"}, Endpoint{BaseURL: upstream.URL})
	stream, err := adapter.Stream(context.Background(), upstream.Client(), call)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()

	chunks := drain(t, stream)
	var text, reasoning, finish string
	var usage *CanonicalUsage
	for _, c := range chunks {
		text += c.Text
		reasoning += c.Reasoning
		if c.FinishReason != "" {
			finish = c.FinishReason
		}
		if c.Done {
			usage = c.Usage
		}
	}
	if text != "Hi" || reasoning != "hmm" || finish != "stop" {
		t.Fatalf("text=%q reasoning=%q finish=%q", text, reasoning, finish)
	}
	if usage == nil || usage.InputTokens != 11 || usage.OutputTokens != 5 || usage.CachedInputTokens != 4 {
		t.Fatalf("usage = %+v", usage)
	}
	if usage.ProviderRequestID != "msg_1" {
		t.Fatalf("provider request id = %q", usage.ProviderRequestID)
	}
}

func TestAnthropicClassifyError(t *testing.T) {
	adapter := NewAnthropic()
	if got := adapter.ClassifyError(429, []byte(`{"type":"error","error":{"type":"rate_limit_error"}}`), nil); got.Kind != ErrRateLimit || !got.Retryable {
		t.Fatalf("429 → %+v", got)
	}
	if got := adapter.ClassifyError(529, []byte(`{"type":"error","error":{"type":"overloaded_error"}}`), nil); got.Kind != ErrProviderDown {
		t.Fatalf("529 → %+v", got)
	}
}

// ── Gemini ────────────────────────────────────────────────────────────

func TestGeminiBuildRequestKeepsCredentialOutOfURL(t *testing.T) {
	adapter := NewGemini()
	call, err := adapter.BuildRequest(
		&CanonicalRequest{Model: "gemini-2.5-flash", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}},
		Credential{Secret: "AIza-secret"},
		Endpoint{BaseURL: "https://generativelanguage.googleapis.com/v1beta", AuthScheme: "query"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(call.URL, "/models/gemini-2.5-flash:streamGenerateContent?") || !strings.Contains(call.URL, "alt=sse") {
		t.Fatalf("url = %s", call.URL)
	}
	if strings.Contains(call.URL, "AIza-secret") || call.Headers["x-goog-api-key"] != "AIza-secret" {
		t.Fatal("credential must use header only")
	}
	if _, ok := call.Headers["authorization"]; ok {
		t.Fatal("query-auth provider must not also send an authorization header")
	}
}

func TestBoundCredentialsRejectQueryAuthentication(t *testing.T) {
	for _, adapter := range []Adapter{NewOpenAICompatible("openai", "https://api.example.com"), NewAnthropic()} {
		_, err := adapter.BuildRequest(&CanonicalRequest{Model: "fixture", Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}, Credential{Secret: "synthetic", AuthorizationBinding: "signed"}, Endpoint{AuthScheme: "query"})
		if err == nil {
			t.Fatal("bound credential placed in URL")
		}
	}
}

func TestGeminiStreamUsageMetadata(t *testing.T) {
	sse := `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hey"}]}}]}` + "\n\n" +
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"cachedContentTokenCount":1,"thoughtsTokenCount":3}}` + "\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, sse)
	}))
	defer upstream.Close()

	adapter := NewGemini()
	call, _ := adapter.BuildRequest(&CanonicalRequest{Model: "gemini-2.5-flash", Stream: true, Messages: []Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}}, Credential{Secret: "k"}, Endpoint{BaseURL: upstream.URL, AuthScheme: "query"})
	stream, err := adapter.Stream(context.Background(), upstream.Client(), call)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()

	var text string
	var usage *CanonicalUsage
	for _, c := range drain(t, stream) {
		text += c.Text
		if c.Done {
			usage = c.Usage
		}
	}
	if text != "Hey there" {
		t.Fatalf("text = %q", text)
	}
	if usage == nil || usage.InputTokens != 9 || usage.OutputTokens != 2 || usage.CachedInputTokens != 1 || usage.ReasoningTokens != 3 {
		t.Fatalf("usage = %+v", usage)
	}
}

// ── Registry ──────────────────────────────────────────────────────────

func TestBuiltinRegistryCoversRequiredProviders(t *testing.T) {
	registry, err := NewBuiltinRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"openai", "anthropic", "gemini", "deepseek", "qwen"} {
		adapter, ok := registry.Get(code)
		if !ok {
			t.Fatalf("adapter %q not registered", code)
		}
		if adapter.Version() == "" {
			t.Fatalf("adapter %q must expose an observable version", code)
		}
	}
	// openai/deepseek/qwen share one implementation — proof there are no
	// provider branches in the gateway core.
	openaiAdapter, _ := registry.Get("openai")
	deepseekAdapter, _ := registry.Get("deepseek")
	if _, ok := openaiAdapter.(*OpenAICompatible); !ok {
		t.Fatal("openai must use the OpenAI-compatible adapter")
	}
	if _, ok := deepseekAdapter.(*OpenAICompatible); !ok {
		t.Fatal("deepseek must reuse the OpenAI-compatible adapter")
	}
}

func TestRegistryRejectsDuplicates(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(NewGemini()); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(NewGemini()); err == nil {
		t.Fatal("expected duplicate registration to fail")
	}
}
