package provider

// Google Gemini adapter.
//
// Wire facts taken from src/lib/providers/gemini.ts: models live under
// /v1beta/models, the credential travels as a `key` query parameter, and
// streaming is requested with `alt=sse` so the response is SSE rather than a
// chunked JSON array.

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
	geminiAdapterVersion = "1.0.0"
	geminiAPIVersion     = "v1beta"
)

type Gemini struct {
	version string
	baseURL string
}

func NewGemini() *Gemini {
	return &Gemini{version: geminiAdapterVersion, baseURL: "https://generativelanguage.googleapis.com/v1beta"}
}

func (g *Gemini) ID() string      { return "gemini" }
func (g *Gemini) Version() string { return geminiAdapterVersion }

func (g *Gemini) Capabilities(model string) ModelCapabilities {
	caps := ModelCapabilities{Text: true, Streaming: true, Vision: true, ToolCalling: true, StructuredOutput: true}
	lower := strings.ToLower(model)
	if strings.Contains(lower, "2.5") || strings.Contains(lower, "thinking") {
		caps.Reasoning = true
	}
	return caps
}

type geminiPart struct {
	Text string `json:"text,omitempty"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiBody struct {
	Contents          []geminiContent  `json:"contents"`
	SystemInstruction *geminiContent   `json:"systemInstruction,omitempty"`
	GenerationConfig  *geminiGenConfig `json:"generationConfig,omitempty"`
}

type geminiGenConfig struct {
	MaxOutputTokens int      `json:"maxOutputTokens,omitempty"`
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"topP,omitempty"`
	StopSequences   []string `json:"stopSequences,omitempty"`
}

func (g *Gemini) BuildRequest(req *CanonicalRequest, cred Credential, ep Endpoint) (*ProviderRequest, error) {
	if req == nil {
		return nil, fmt.Errorf("gemini: nil request")
	}
	body := geminiBody{}
	var systemParts []string
	for _, msg := range req.Messages {
		if msg.Role == "system" || msg.Role == "developer" {
			if text := contentAsText(msg.Content); text != "" {
				systemParts = append(systemParts, text)
			}
			continue
		}
		role := "user"
		if msg.Role == "assistant" {
			role = "model"
		}
		body.Contents = append(body.Contents, geminiContent{Role: role, Parts: []geminiPart{{Text: contentAsText(msg.Content)}}})
	}
	if len(systemParts) > 0 {
		body.SystemInstruction = &geminiContent{Parts: []geminiPart{{Text: strings.Join(systemParts, "\n")}}}
	}
	if len(body.Contents) == 0 {
		return nil, fmt.Errorf("gemini: at least one non-system message is required")
	}
	if req.MaxTokens != nil || req.Temperature != nil || req.TopP != nil || len(req.Stop) > 0 {
		cfg := &geminiGenConfig{Temperature: req.Temperature, TopP: req.TopP, StopSequences: req.Stop}
		if req.MaxTokens != nil {
			cfg.MaxOutputTokens = *req.MaxTokens
		}
		body.GenerationConfig = cfg
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("gemini: encode body: %w", err)
	}

	base := ep.BaseURL
	if base == "" {
		base = g.baseURL
	}
	model := strings.TrimPrefix(req.Model, "models/")
	method := "generateContent"
	if req.Stream {
		method = "streamGenerateContent"
	}
	url := joinURL(base, "/models/"+model+":"+method)
	if req.Stream {
		url += "?alt=sse"
	}
	headers := map[string]string{
		"content-type":   "application/json",
		"accept":         "text/event-stream, application/json",
		"x-goog-api-key": cred.Secret,
	}
	return &ProviderRequest{Method: http.MethodPost, URL: url, Headers: headers, Body: raw}, nil
}

func (g *Gemini) Stream(ctx context.Context, client *http.Client, call *ProviderRequest) (Stream, error) {
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
	return &geminiStream{
		resp:              resp,
		reader:            NewSSEReader(resp.Body),
		providerRequestID: requestIDFromHeaders(resp.Header),
		usage:             &CanonicalUsage{},
	}, nil
}

type geminiStream struct {
	observedWire      *geminiObservedWire
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

func (s *geminiStream) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	return s.resp.Body.Close()
}

type geminiWireChunk struct {
	Candidates []struct {
		Content struct {
			Role  string `json:"role"`
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

func (s *geminiStream) Next() (CanonicalChunk, error) {
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
				s.usage.ProviderRequestID = s.providerRequestID
				if !s.terminalSeen {
					return CanonicalChunk{Usage: s.usage}, ErrStreamTruncated
				}
				return CanonicalChunk{Done: true, Usage: s.usage}, nil
			}
			return CanonicalChunk{Usage: s.usage}, err
		}
		payload := bytes.TrimSpace(event.Data)
		if len(payload) == 0 {
			continue
		}
		var wire geminiWireChunk
		if err := json.Unmarshal(payload, &wire); err != nil {
			return CanonicalChunk{Usage: s.usage}, fmt.Errorf("gemini: malformed stream chunk")
		}
		if wire.Error != nil {
			return CanonicalChunk{Usage: s.usage}, &UpstreamStreamError{Kind: mapGeminiStatus(wire.Error.Status)}
		}
		if wire.UsageMetadata != nil {
			s.usage.Observed = observeGemini(payload, &s.observedWire)
			s.usage.InputTokens = wire.UsageMetadata.PromptTokenCount
			s.usage.OutputTokens = wire.UsageMetadata.CandidatesTokenCount
			s.usage.CachedInputTokens = wire.UsageMetadata.CachedContentTokenCount
			s.usage.ReasoningTokens = wire.UsageMetadata.ThoughtsTokenCount
		}
		if len(wire.Candidates) > 0 {
			candidate := wire.Candidates[0]
			var text strings.Builder
			for _, part := range candidate.Content.Parts {
				text.WriteString(part.Text)
			}
			if text.Len() > 0 || candidate.FinishReason != "" {
				out := CanonicalChunk{Text: text.String()}
				if candidate.FinishReason != "" && candidate.FinishReason != "FINISH_REASON_UNSPECIFIED" {
					if !validGeminiFinishReason(candidate.FinishReason) {
						return CanonicalChunk{Usage: s.usage}, fmt.Errorf("gemini: invalid finish reason")
					}
					s.terminalSeen = true
					out.FinishReason = mapGeminiFinishReason(candidate.FinishReason)
				}
				return out, nil
			}
		}
	}
}

func validGeminiFinishReason(reason string) bool {
	switch reason {
	case "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "LANGUAGE", "OTHER",
		"BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL",
		"IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_OTHER", "NO_IMAGE",
		"IMAGE_RECITATION", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS",
		"MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE", "ESCALATION":
		return true
	default:
		return false
	}
}

func mapGeminiFinishReason(reason string) string {
	switch reason {
	case "MAX_TOKENS":
		return "length"
	case "STOP":
		return "stop"
	default:
		return "stop"
	}
}

func mapGeminiStatus(status string) CanonicalError {
	switch status {
	case "UNAUTHENTICATED", "PERMISSION_DENIED":
		return ErrAuth
	case "RESOURCE_EXHAUSTED":
		return ErrRateLimit
	case "INVALID_ARGUMENT", "FAILED_PRECONDITION":
		return ErrInvalidRequest
	case "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED":
		return ErrProviderDown
	default:
		return ErrUnknown
	}
}

type geminiNonStreamBody struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
}

func (g *Gemini) ParseUsage(res *ProviderResult) *CanonicalUsage {
	if res == nil || len(res.Body) == 0 {
		return nil
	}
	var body geminiNonStreamBody
	if err := json.Unmarshal(res.Body, &body); err != nil {
		return nil
	}
	var observedWire *geminiObservedWire
	observed := observeGemini(res.Body, &observedWire)
	legacyMissing := body.UsageMetadata.PromptTokenCount == 0 && body.UsageMetadata.CandidatesTokenCount == 0
	if observed == nil && legacyMissing {
		return nil
	}
	return &CanonicalUsage{
		Observed:          observed,
		LegacyMissing:     legacyMissing,
		InputTokens:       body.UsageMetadata.PromptTokenCount,
		OutputTokens:      body.UsageMetadata.CandidatesTokenCount,
		CachedInputTokens: body.UsageMetadata.CachedContentTokenCount,
		ReasoningTokens:   body.UsageMetadata.ThoughtsTokenCount,
		ProviderRequestID: res.ProviderRequestID,
	}
}

func (g *Gemini) ClassifyError(status int, body []byte, err error) ErrorClassification {
	classification := classifyHTTPStatus(status)
	lower := truncateForClassification(body)
	switch {
	case strings.Contains(lower, "safety") || strings.Contains(lower, "blocked"):
		classification.Kind = ErrContentPolicy
		classification.Retryable = false
	case strings.Contains(lower, "resource_exhausted") || strings.Contains(lower, "quota"):
		classification.Kind = ErrQuota
		classification.Retryable = false
	}
	if err != nil && status == 0 {
		classification = classifyTransportError(err)
	}
	return classification
}

func (g *Gemini) Health(ctx context.Context, client *http.Client, cred Credential, ep Endpoint) HealthStatus {
	base := ep.BaseURL
	if base == "" {
		base = g.baseURL
	}
	url := joinURL(base, "/models")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "request_build_failed"}
	}
	req.Header.Set("x-goog-api-key", cred.Secret)
	resp, err := client.Do(req)
	if err != nil {
		return HealthStatus{OK: false, CheckedAt: time.Now().UTC(), Detail: "unreachable"}
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return HealthStatus{OK: resp.StatusCode == http.StatusOK, CheckedAt: time.Now().UTC(), Detail: fmt.Sprintf("http_%d", resp.StatusCode)}
}
