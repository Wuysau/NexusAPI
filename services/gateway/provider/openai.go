package provider

// OpenAI-compatible adapter.
//
// One implementation serves openai, deepseek and qwen: they share the
// /chat/completions wire protocol, and the channel supplies the base URL. That
// is the whole point of the adapter contract — the core never learns which of
// them it is talking to.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const openAIAdapterVersion = "1.0.0"

// OpenAICompatible implements Adapter for /chat/completions providers.
type OpenAICompatible struct {
	id         string
	version    string
	baseURL    string
	chatPath   string
	modelsPath string
}

func NewOpenAICompatible(id, defaultBaseURL string) *OpenAICompatible {
	return &OpenAICompatible{
		id:         id,
		version:    openAIAdapterVersion,
		baseURL:    defaultBaseURL,
		chatPath:   "/chat/completions",
		modelsPath: "/models",
	}
}

func (a *OpenAICompatible) ID() string      { return a.id }
func (a *OpenAICompatible) Version() string { return a.version }

// Capabilities returns conservative defaults. The control plane confirms
// per-model capabilities at review time (Work Item D); the gateway must never
// invent a capability, so anything unconfirmed is reported as unsupported.
func (a *OpenAICompatible) Capabilities(model string) ModelCapabilities {
	caps := ModelCapabilities{Text: true, Streaming: true}
	lower := strings.ToLower(model)
	switch {
	case strings.Contains(lower, "gpt-4o"), strings.Contains(lower, "gpt-4.1"), strings.Contains(lower, "o1"),
		strings.Contains(lower, "o3"), strings.Contains(lower, "vl"), strings.Contains(lower, "vision"):
		caps.Vision = true
	}
	switch {
	case strings.HasPrefix(lower, "o1"), strings.HasPrefix(lower, "o3"), strings.HasPrefix(lower, "o4"),
		strings.Contains(lower, "reasoner"), strings.Contains(lower, "r1"):
		caps.Reasoning = true
	}
	switch {
	case strings.HasPrefix(lower, "gpt-4"), strings.HasPrefix(lower, "gpt-3.5"), strings.Contains(lower, "qwen"),
		strings.Contains(lower, "deepseek-chat"):
		caps.ToolCalling = true
		caps.StructuredOutput = true
	}
	return caps
}

// openAIChatBody is the wire body. Optional fields are pointers so "unset" is
// distinguishable from "zero".
type openAIChatBody struct {
	Model          string          `json:"model"`
	Messages       []Message       `json:"messages"`
	Stream         bool            `json:"stream"`
	MaxTokens      *int            `json:"max_tokens,omitempty"`
	Temperature    *float64        `json:"temperature,omitempty"`
	TopP           *float64        `json:"top_p,omitempty"`
	Stop           []string        `json:"stop,omitempty"`
	Tools          json.RawMessage `json:"tools,omitempty"`
	ToolChoice     json.RawMessage `json:"tool_choice,omitempty"`
	ResponseFormat json.RawMessage `json:"response_format,omitempty"`
	User           string          `json:"user,omitempty"`
	StreamOptions  *streamOptions  `json:"stream_options,omitempty"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

func (a *OpenAICompatible) BuildRequest(req *CanonicalRequest, cred Credential, ep Endpoint) (*ProviderRequest, error) {
	if cred.AuthorizationBinding != "" && ep.AuthScheme == "query" {
		return nil, fmt.Errorf("credential query authentication is forbidden")
	}
	if err := a.ValidateRequest(req); err != nil {
		return nil, err
	}
	base := ep.BaseURL
	if base == "" {
		base = a.baseURL
	}
	body := openAIChatBody{
		Model:          req.Model,
		Messages:       req.Messages,
		Stream:         req.Stream,
		MaxTokens:      req.MaxTokens,
		Temperature:    req.Temperature,
		TopP:           req.TopP,
		Stop:           req.Stop,
		Tools:          req.Tools,
		ToolChoice:     req.ToolChoice,
		ResponseFormat: req.ResponseFormat,
		User:           req.User,
	}
	if req.Stream {
		body.StreamOptions = &streamOptions{IncludeUsage: true}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("openai: encode body: %w", err)
	}
	headers := map[string]string{
		"content-type": "application/json",
		"accept":       "text/event-stream, application/json",
	}
	switch ep.AuthScheme {
	case "x_api_key":
		headers["x-api-key"] = cred.Secret
	case "query":
		// Handled by the URL below; no header.
	default:
		headers["authorization"] = "Bearer " + cred.Secret
	}
	url := joinURL(base, a.chatPath)
	if ep.AuthScheme == "query" {
		param := ep.QueryParam
		if param == "" {
			param = "key"
		}
		url += "?" + param + "=" + cred.Secret
	}
	return &ProviderRequest{Method: http.MethodPost, URL: url, Headers: headers, Body: raw}, nil
}

func (a *OpenAICompatible) Stream(ctx context.Context, client *http.Client, call *ProviderRequest) (Stream, error) {
	httpReq, err := http.NewRequestWithContext(ctx, call.Method, call.URL, bytes.NewReader(call.Body))
	if err != nil {
		return nil, err
	}
	for k, v := range call.Headers {
		httpReq.Header.Set(k, v)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, newUpstreamHTTPError(resp.StatusCode, body, resp.Header, time.Now())
	}
	return &openAIStream{
		resp:              resp,
		reader:            NewSSEReader(resp.Body),
		providerRequestID: requestIDFromHeaders(resp.Header),
	}, nil
}

// UpstreamHTTPError carries a non-2xx response without leaking its body into
// logs. The body is retained only for classification.
type UpstreamHTTPError struct {
	Status     int
	Body       []byte
	RetryAfter time.Duration // normalized, bounded hint; zero means absent/invalid
}

func (e *UpstreamHTTPError) Error() string { return fmt.Sprintf("upstream http %d", e.Status) }

type openAIStream struct {
	resp              *http.Response
	reader            *SSEReader
	providerRequestID string
	usage             *CanonicalUsage
	finished          bool
	terminalSeen      bool
	// closed is written by Close() on the request goroutine and read by Next()
	// on the relay's read goroutine, so it must be atomic. finished and usage
	// are only ever touched by Next(), which the relay calls from one goroutine
	// at a time, so they stay plain fields.
	closed atomic.Bool
}

func (s *openAIStream) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	return s.resp.Body.Close()
}

func (s *openAIStream) Next() (CanonicalChunk, error) {
	if s.closed.Load() {
		return CanonicalChunk{}, ErrStreamClosed
	}
	if s.finished {
		return CanonicalChunk{}, io.EOF
	}
	for {
		event, err := s.reader.Next()
		if err != nil {
			if err == io.EOF {
				s.finished = true
				if !s.terminalSeen {
					return CanonicalChunk{Usage: s.usage}, ErrStreamTruncated
				}
				return CanonicalChunk{Done: true, Usage: s.usage}, nil
			}
			return CanonicalChunk{Usage: s.usage}, err
		}
		payload := strings.TrimSpace(string(event.Data))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			s.finished = true
			return CanonicalChunk{Done: true, Usage: s.usage}, nil
		}
		chunk, err := parseOpenAIChunk([]byte(payload))
		if err != nil {
			// A malformed chunk from the provider is a protocol error, not
			// something to silently skip: skipping would under-bill.
			return CanonicalChunk{Usage: s.usage}, fmt.Errorf("openai: malformed or failed stream chunk")
		}
		if chunk.Usage != nil {
			if s.usage != nil {
				chunk.Usage.Observed = mergeObserved(s.usage.Observed, chunk.Usage.Observed)
			}
			s.usage = chunk.Usage
		}
		if chunk.FinishReason != "" {
			s.terminalSeen = true
		}
		if chunk.Text == "" && chunk.Reasoning == "" && chunk.ToolCallDelta == nil && chunk.FinishReason == "" {
			continue // keep-alive / role-only delta
		}
		return chunk, nil
	}
}

type openAIWireChunk struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role             string          `json:"role"`
			Content          string          `json:"content"`
			ReasoningContent string          `json:"reasoning_content"`
			Reasoning        string          `json:"reasoning"`
			ToolCalls        json.RawMessage `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

func parseOpenAIChunk(raw []byte) (CanonicalChunk, error) {
	var wire openAIWireChunk
	if err := json.Unmarshal(raw, &wire); err != nil {
		return CanonicalChunk{}, err
	}
	if wire.Error != nil {
		return CanonicalChunk{}, &UpstreamStreamError{Kind: ErrUnknown}
	}
	var out CanonicalChunk
	if wire.Usage != nil {
		out.Usage = &CanonicalUsage{
			Observed:          observeOpenAI(raw),
			InputTokens:       wire.Usage.PromptTokens,
			OutputTokens:      wire.Usage.CompletionTokens,
			CachedInputTokens: wire.Usage.PromptTokensDetails.CachedTokens,
			ReasoningTokens:   wire.Usage.CompletionTokensDetails.ReasoningTokens,
		}
	}
	if len(wire.Choices) > 0 {
		choice := wire.Choices[0]
		out.Text = choice.Delta.Content
		out.Reasoning = choice.Delta.ReasoningContent
		if out.Reasoning == "" {
			out.Reasoning = choice.Delta.Reasoning
		}
		if len(choice.Delta.ToolCalls) > 0 && string(choice.Delta.ToolCalls) != "null" {
			out.ToolCallDelta = choice.Delta.ToolCalls
		}
		if choice.FinishReason != nil {
			switch *choice.FinishReason {
			case "", "stop", "length", "tool_calls", "content_filter", "function_call":
			default:
				return CanonicalChunk{}, fmt.Errorf("openai: invalid finish reason")
			}
			out.FinishReason = *choice.FinishReason
		}
	}
	return out, nil
}

// openAINonStreamBody is the buffered response shape.
type openAINonStreamBody struct {
	ID      string `json:"id"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
}

func (a *OpenAICompatible) ParseUsage(res *ProviderResult) *CanonicalUsage {
	if res == nil || len(res.Body) == 0 {
		return nil
	}
	var body openAINonStreamBody
	if err := json.Unmarshal(res.Body, &body); err != nil {
		return nil
	}
	observed := observeOpenAI(res.Body)
	legacyMissing := body.Usage.PromptTokens == 0 && body.Usage.CompletionTokens == 0 && body.ID == ""
	if observed == nil && legacyMissing {
		return nil
	}
	return &CanonicalUsage{
		Observed:          observed,
		LegacyMissing:     legacyMissing,
		InputTokens:       body.Usage.PromptTokens,
		OutputTokens:      body.Usage.CompletionTokens,
		CachedInputTokens: body.Usage.PromptTokensDetails.CachedTokens,
		ReasoningTokens:   body.Usage.CompletionTokensDetails.ReasoningTokens,
		ProviderRequestID: res.ProviderRequestID,
	}
}

func (a *OpenAICompatible) ClassifyError(status int, body []byte, err error) ErrorClassification {
	classification := classifyHTTPStatus(status)
	lower := truncateForClassification(body)
	switch {
	case strings.Contains(lower, "content_policy") || strings.Contains(lower, "content_filter") ||
		strings.Contains(lower, "content policy"):
		classification.Kind = ErrContentPolicy
		classification.Retryable = false
	case strings.Contains(lower, "insufficient_quota") || strings.Contains(lower, "exceeded your current quota"):
		classification.Kind = ErrQuota
		classification.Retryable = false
	case strings.Contains(lower, "invalid_api_key") || strings.Contains(lower, "incorrect api key"):
		classification.Kind = ErrAuth
		classification.Retryable = false
	case strings.Contains(lower, "rate limit") && status == 0:
		classification.Kind = ErrRateLimit
		classification.Retryable = true
	}
	if err != nil && status == 0 {
		classification = classifyTransportError(err)
	}
	return classification
}

func (a *OpenAICompatible) Health(ctx context.Context, client *http.Client, cred Credential, ep Endpoint) HealthStatus {
	base := ep.BaseURL
	if base == "" {
		base = a.baseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, joinURL(base, a.modelsPath), nil)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "request_build_failed"}
	}
	switch ep.AuthScheme {
	case "x_api_key":
		req.Header.Set("x-api-key", cred.Secret)
	case "query":
		req.Header.Set("authorization", "Bearer "+cred.Secret)
	default:
		req.Header.Set("authorization", "Bearer "+cred.Secret)
	}
	resp, err := client.Do(req)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "unreachable"}
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return HealthStatus{OK: resp.StatusCode == http.StatusOK, CheckedAt: time.Now().UTC(), Detail: fmt.Sprintf("http_%d", resp.StatusCode)}
}

// requestIDFromHeaders extracts a provider request id without touching content.
func requestIDFromHeaders(h http.Header) string {
	for _, key := range []string{"x-request-id", "request-id", "x-amzn-requestid"} {
		if v := h.Get(key); v != "" {
			return v
		}
	}
	return ""
}

// classifyTransportError maps a Go transport error to the taxonomy. Cancellation
// is deliberately NOT retryable here: the core decides whether the client is
// still there to receive a retry.
func classifyTransportError(err error) ErrorClassification {
	if err == nil {
		return ErrorClassification{Kind: ErrUnknown}
	}
	if err == context.Canceled || err == context.DeadlineExceeded {
		return ErrorClassification{Kind: ErrTransient, Retryable: false}
	}
	name := strings.ToLower(fmt.Sprintf("%T %v", err, err))
	if strings.Contains(name, "timeout") || strings.Contains(name, "deadline") {
		return ErrorClassification{Kind: ErrTransient, Retryable: true}
	}
	return ErrorClassification{Kind: ErrTransient, Retryable: true}
}
