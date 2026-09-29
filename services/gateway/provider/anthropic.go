package provider

// Anthropic Messages adapter.
//
// Wire facts taken from the control plane's source adapter
// (src/lib/providers/anthropic.ts): POST /messages, x-api-key auth,
// anthropic-version: 2023-06-01. The Messages API has no `system` role inside
// `messages` and requires `max_tokens`, so the transform differs from the
// OpenAI shape — which is exactly why it lives behind the adapter interface.

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

const (
	anthropicAdapterVersion = "1.0.1"
	anthropicAPIVersion     = "2023-06-01"
	// defaultAnthropicMaxTokens is applied when the client omits max_tokens,
	// which the Messages API rejects. Chosen to match the legacy gateway's
	// long-standing default so behaviour does not change on migration.
	defaultAnthropicMaxTokens = 1024
)

type Anthropic struct {
	version string
	baseURL string
}

func NewAnthropic() *Anthropic {
	return &Anthropic{version: anthropicAdapterVersion, baseURL: "https://api.anthropic.com/v1"}
}

func (a *Anthropic) ID() string      { return "anthropic" }
func (a *Anthropic) Version() string { return a.version }

func (a *Anthropic) Capabilities(model string) ModelCapabilities {
	caps := ModelCapabilities{Text: true, Streaming: true, Vision: true, ToolCalling: true, PromptCaching: true}
	if strings.Contains(strings.ToLower(model), "3-7") || strings.Contains(strings.ToLower(model), "thinking") {
		caps.Reasoning = true
	}
	return caps
}

type anthropicBody struct {
	Model         string            `json:"model"`
	MaxTokens     int               `json:"max_tokens"`
	System        string            `json:"system,omitempty"`
	Messages      []anthropicMsg    `json:"messages"`
	Temperature   *float64          `json:"temperature,omitempty"`
	TopP          *float64          `json:"top_p,omitempty"`
	StopSequences []string          `json:"stop_sequences,omitempty"`
	Stream        bool              `json:"stream"`
	Tools         json.RawMessage   `json:"tools,omitempty"`
	ToolChoice    json.RawMessage   `json:"tool_choice,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

type anthropicMsg struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func (a *Anthropic) BuildRequest(req *CanonicalRequest, cred Credential, ep Endpoint) (*ProviderRequest, error) {
	if cred.AuthorizationBinding != "" && ep.AuthScheme == "query" {
		return nil, fmt.Errorf("credential query authentication is forbidden")
	}
	if err := a.ValidateRequest(req); err != nil {
		return nil, err
	}
	body := anthropicBody{Model: req.Model, Stream: req.Stream}
	body.MaxTokens = defaultAnthropicMaxTokens
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		body.MaxTokens = *req.MaxTokens
	}
	body.Temperature = req.Temperature
	body.TopP = req.TopP
	body.StopSequences = req.Stop
	var err error
	body.Tools, body.ToolChoice, err = anthropicTools(req.Tools, req.ToolChoice)
	if err != nil {
		return nil, err
	}
	if req.User != "" {
		body.Metadata = map[string]string{"user_id": req.User}
	}

	var systemParts []string
	for _, msg := range req.Messages {
		switch msg.Role {
		case "system", "developer":
			if text := contentAsText(msg.Content); text != "" {
				systemParts = append(systemParts, text)
			}
		default:
			content, err := anthropicMessageContent(msg)
			if err != nil {
				return nil, err
			}
			body.Messages = append(body.Messages, anthropicMsg{Role: normalizeAnthropicRole(msg.Role), Content: content})
		}
	}
	if len(systemParts) > 0 {
		body.System = strings.Join(systemParts, "\n")
	}
	if len(body.Messages) == 0 {
		// The Messages API rejects an empty messages array; a system-only call
		// is a client error the core will surface as invalid_request.
		return nil, fmt.Errorf("anthropic: at least one non-system message is required")
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("anthropic: encode body: %w", err)
	}
	base := ep.BaseURL
	if base == "" {
		base = a.baseURL
	}
	if ep.Protocol == "anthropic" && !strings.HasSuffix(strings.TrimRight(base, "/"), "/v1") {
		base = joinURL(base, "/v1")
	}
	url := joinURL(base, "/messages")
	if ep.AuthScheme == "query" {
		param := ep.QueryParam
		if param == "" {
			param = "key"
		}
		url += "?" + param + "=" + cred.Secret
	}
	headers := map[string]string{
		"content-type":      "application/json",
		"accept":            "text/event-stream, application/json",
		"anthropic-version": anthropicAPIVersion,
	}
	if ep.AuthScheme != "query" {
		headers["x-api-key"] = cred.Secret
	}
	return &ProviderRequest{Method: http.MethodPost, URL: url, Headers: headers, Body: raw}, nil
}

func normalizeAnthropicRole(role string) string {
	if role == "assistant" {
		return "assistant"
	}
	return "user"
}

// contentAsText extracts plain text from a string or OpenAI-style parts array.
func contentAsText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var sb strings.Builder
		for _, p := range parts {
			if p.Type == "text" || p.Type == "" {
				sb.WriteString(p.Text)
			}
		}
		return sb.String()
	}
	return ""
}

func (a *Anthropic) Stream(ctx context.Context, client *http.Client, call *ProviderRequest) (Stream, error) {
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
	return &anthropicStream{
		resp:              resp,
		reader:            NewSSEReader(resp.Body),
		providerRequestID: requestIDFromHeaders(resp.Header),
		usage:             &CanonicalUsage{},
	}, nil
}

type anthropicStream struct {
	observedWire      *anthropicObservedWire
	resp              *http.Response
	reader            *SSEReader
	providerRequestID string
	usage             *CanonicalUsage
	finished          bool
	toolIndexes       map[int]int
	// closed is written by Close() on the request goroutine and read by Next()
	// on the relay's read goroutine, so it must be atomic. finished and usage
	// are only ever touched by Next(), which the relay calls from one goroutine
	// at a time, so they stay plain fields.
	closed atomic.Bool
}

func (s *anthropicStream) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	return s.resp.Body.Close()
}

type anthropicWireEvent struct {
	Type    string `json:"type"`
	Message *struct {
		ID    string `json:"id"`
		Usage struct {
			InputTokens          int `json:"input_tokens"`
			OutputTokens         int `json:"output_tokens"`
			CacheReadInputTokens int `json:"cache_read_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	Index int `json:"index"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		StopReason  string `json:"stop_reason"`
		PartialJSON string `json:"partial_json"`
	} `json:"delta"`
	ContentBlock *struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"content_block"`
	Usage *struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func (s *anthropicStream) Next() (CanonicalChunk, error) {
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
				return CanonicalChunk{Usage: s.usage}, ErrStreamTruncated
			}
			return CanonicalChunk{Usage: s.usage}, err
		}
		payload := bytes.TrimSpace(event.Data)
		if len(payload) == 0 {
			continue
		}
		var wire anthropicWireEvent
		if err := json.Unmarshal(payload, &wire); err != nil {
			return CanonicalChunk{Usage: s.usage}, fmt.Errorf("anthropic: malformed stream event")
		}
		switch wire.Type {
		case "message_start":
			s.usage.Observed = observeAnthropic(payload, &s.observedWire)
			if wire.Message != nil {
				s.usage.InputTokens = wire.Message.Usage.InputTokens
				s.usage.CachedInputTokens = wire.Message.Usage.CacheReadInputTokens
				if wire.Message.ID != "" {
					s.providerRequestID = wire.Message.ID
				}
			}
			continue
		case "content_block_delta":
			if wire.Delta == nil {
				continue
			}
			switch wire.Delta.Type {
			case "thinking_delta":
				if wire.Delta.Thinking == "" {
					continue
				}
				return CanonicalChunk{Reasoning: wire.Delta.Thinking}, nil
			case "input_json_delta":
				if wire.Delta.PartialJSON == "" {
					continue
				}
				index, ok := s.toolIndexes[wire.Index]
				if !ok {
					return CanonicalChunk{Usage: s.usage}, fmt.Errorf("anthropic: tool delta without tool start")
				}
				delta, _ := json.Marshal([]any{map[string]any{
					"index": index, "function": map[string]string{"arguments": wire.Delta.PartialJSON},
				}})
				return CanonicalChunk{ToolCallDelta: delta}, nil
			default:
				if wire.Delta.Text == "" {
					continue
				}
				return CanonicalChunk{Text: wire.Delta.Text}, nil
			}
		case "content_block_start":
			if wire.ContentBlock != nil && wire.ContentBlock.Type == "tool_use" {
				if s.toolIndexes == nil {
					s.toolIndexes = make(map[int]int)
				}
				if _, exists := s.toolIndexes[wire.Index]; exists {
					return CanonicalChunk{Usage: s.usage}, fmt.Errorf("anthropic: duplicate tool start")
				}
				index := len(s.toolIndexes)
				s.toolIndexes[wire.Index] = index
				delta, _ := json.Marshal([]any{map[string]any{
					"index": index,
					"id":    wire.ContentBlock.ID,
					"type":  "function",
					"function": map[string]any{
						"name":      wire.ContentBlock.Name,
						"arguments": "",
					},
				}})
				return CanonicalChunk{ToolCallDelta: delta}, nil
			}
			continue
		case "message_delta":
			s.usage.Observed = observeAnthropic(payload, &s.observedWire)
			if wire.Usage != nil {
				s.usage.OutputTokens = wire.Usage.OutputTokens
			}
			if wire.Delta != nil && wire.Delta.StopReason != "" {
				return CanonicalChunk{FinishReason: mapAnthropicStopReason(wire.Delta.StopReason)}, nil
			}
			continue
		case "message_stop":
			s.finished = true
			s.usage.ProviderRequestID = s.providerRequestID
			return CanonicalChunk{Done: true, Usage: s.usage}, nil
		case "error":
			if wire.Error == nil {
				return CanonicalChunk{Usage: s.usage}, fmt.Errorf("anthropic: malformed error event")
			}
			return CanonicalChunk{Usage: s.usage}, &UpstreamStreamError{Kind: mapAnthropicErrorType(wire.Error.Type)}
		default:
			continue
		}
	}
}

func mapAnthropicStopReason(reason string) string {
	switch reason {
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	default:
		return "stop"
	}
}

func mapAnthropicErrorType(t string) CanonicalError {
	switch t {
	case "authentication_error", "permission_error":
		return ErrAuth
	case "rate_limit_error":
		return ErrRateLimit
	case "overloaded_error":
		return ErrProviderDown
	case "invalid_request_error":
		return ErrInvalidRequest
	default:
		return ErrUnknown
	}
}

// UpstreamStreamError is an error delivered mid-stream by the provider.
type UpstreamStreamError struct{ Kind CanonicalError }

func (e *UpstreamStreamError) Error() string { return "upstream stream error: " + string(e.Kind) }

type anthropicNonStreamBody struct {
	ID      string `json:"id"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens          int `json:"input_tokens"`
		OutputTokens         int `json:"output_tokens"`
		CacheReadInputTokens int `json:"cache_read_input_tokens"`
	} `json:"usage"`
}

func (a *Anthropic) ParseUsage(res *ProviderResult) *CanonicalUsage {
	if res == nil || len(res.Body) == 0 {
		return nil
	}
	var body anthropicNonStreamBody
	if err := json.Unmarshal(res.Body, &body); err != nil {
		return nil
	}
	var observedWire *anthropicObservedWire
	observed := observeAnthropic(res.Body, &observedWire)
	legacyMissing := body.Usage.InputTokens == 0 && body.Usage.OutputTokens == 0 && body.ID == ""
	if observed == nil && legacyMissing {
		return nil
	}
	return &CanonicalUsage{
		Observed:          observed,
		LegacyMissing:     legacyMissing,
		InputTokens:       body.Usage.InputTokens,
		OutputTokens:      body.Usage.OutputTokens,
		CachedInputTokens: body.Usage.CacheReadInputTokens,
		ProviderRequestID: res.ProviderRequestID,
	}
}

func (a *Anthropic) ClassifyError(status int, body []byte, err error) ErrorClassification {
	classification := classifyHTTPStatus(status)
	lower := truncateForClassification(body)
	switch {
	case strings.Contains(lower, "content_policy") || strings.Contains(lower, "content policy"):
		classification.Kind = ErrContentPolicy
		classification.Retryable = false
	case strings.Contains(lower, "credit balance") || strings.Contains(lower, "quota"):
		classification.Kind = ErrQuota
		classification.Retryable = false
	case strings.Contains(lower, "overloaded"):
		classification.Kind = ErrProviderDown
		classification.Retryable = true
	}
	if err != nil && status == 0 {
		classification = classifyTransportError(err)
	}
	return classification
}

func (a *Anthropic) Health(ctx context.Context, client *http.Client, cred Credential, ep Endpoint) HealthStatus {
	base := ep.BaseURL
	if base == "" {
		base = a.baseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, joinURL(base, "/models"), nil)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "request_build_failed"}
	}
	req.Header.Set("x-api-key", cred.Secret)
	req.Header.Set("anthropic-version", anthropicAPIVersion)
	resp, err := client.Do(req)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "unreachable"}
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return HealthStatus{OK: resp.StatusCode == http.StatusOK, CheckedAt: time.Now().UTC(), Detail: fmt.Sprintf("http_%d", resp.StatusCode)}
}
