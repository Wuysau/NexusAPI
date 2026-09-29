// Package provider implements the EXECUTION half of the ProviderAdapterV1
// contract (docs/contracts/provider-adapter.md).
//
// The control plane (Work Item D, src/lib/catalog/registry.ts) implements the
// SOURCE half — discovery, credential validation, capabilities, health. This
// package implements request transform, streaming and usage parsing, which only
// the data plane needs.
//
// Core-gateway rule: the proxy never branches on provider identity. Everything
// provider-specific lives behind Adapter. Adding a provider means registering
// another adapter; it never means editing the hot path.
//
// Contract rules carried over verbatim:
//   - adapter version is observable (Adapter.Version)
//   - adapters never log secrets or content
//   - adapters never retry: they classify; the core decides
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ── Canonical error taxonomy ──────────────────────────────────────────

// CanonicalError is the closed set from docs/contracts/provider-adapter.md.
type CanonicalError string

const (
	ErrAuth           CanonicalError = "auth"
	ErrRateLimit      CanonicalError = "rate_limit"
	ErrQuota          CanonicalError = "quota"
	ErrInvalidRequest CanonicalError = "invalid_request"
	ErrContentPolicy  CanonicalError = "content_policy"
	ErrTransient      CanonicalError = "transient"
	ErrProviderDown   CanonicalError = "provider_down"
	ErrUnknown        CanonicalError = "unknown"
)

// ErrorClassification tells the core whether a retry could ever be safe. The
// adapter does not act on it.
type ErrorClassification struct {
	Kind         CanonicalError
	Retryable    bool
	RetryAfterMs int
}

// ── Canonical request / response ──────────────────────────────────────

// Message is one canonical chat message. Content stays raw JSON so multimodal
// arrays pass through untouched.
type Message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	Name       string          `json:"name,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  json.RawMessage `json:"tool_calls,omitempty"`
}

// CanonicalRequest is the provider-agnostic chat request.
type CanonicalRequest struct {
	Model          string
	Messages       []Message
	MaxTokens      *int
	Temperature    *float64
	TopP           *float64
	Stop           []string
	Tools          json.RawMessage
	ToolChoice     json.RawMessage
	ResponseFormat json.RawMessage
	Stream         bool
	// User is an opaque abuse-tracking id; never customer content.
	User string
}

// CanonicalUsage is the billable token accounting for one attempt.
type CanonicalUsage struct {
	// Observed retains nullable v2 facts; legacy integer accounting is unchanged.
	Observed *ObservedUsage
	// LegacyMissing preserves the pre-v2 ParseUsage nil/estimate decision.
	LegacyMissing     bool
	InputTokens       int
	CachedInputTokens int
	OutputTokens      int
	ReasoningTokens   int
	Estimated         bool
	ProviderRequestID string
}

// ObservedUsage distinguishes omitted counts from an explicitly observed zero.
// Primary counts include their subsets; TotalTokens is never synthesized.
type ObservedUsage struct {
	Semantics                string
	CacheCreationInputTokens *int64
	InputTokens              *int64
	CachedInputTokens        *int64
	OutputTokens             *int64
	ReasoningTokens          *int64
	TotalTokens              *int64
}

// CanonicalChunk is one streamed increment.
type CanonicalChunk struct {
	// Text is the incremental assistant text. Empty for control-only chunks.
	Text string
	// Reasoning is incremental reasoning text where the provider exposes it.
	Reasoning string
	// ToolCallDelta is an OpenAI-compatible tool_calls JSON array. Function
	// arguments are incremental strings, which may contain incomplete JSON.
	ToolCallDelta json.RawMessage
	// FinishReason is set on the final content chunk ("stop", "length", ...).
	FinishReason string
	// Usage retains observed accounting, including on a chunk returned with an
	// error. Callers must consume Usage before handling the error.
	Usage *CanonicalUsage
	// Done marks the terminal chunk. Exactly one chunk per stream has Done set
	// (or the stream ends with an error).
	Done bool
}

// ModelCapabilities mirrors the control-plane ModelCapabilities shape.
type ModelCapabilities struct {
	Text             bool `json:"text"`
	Vision           bool `json:"vision"`
	Audio            bool `json:"audio"`
	Embeddings       bool `json:"embeddings"`
	Reasoning        bool `json:"reasoning"`
	Streaming        bool `json:"streaming"`
	ToolCalling      bool `json:"tool_calling"`
	StructuredOutput bool `json:"structured_output"`
	PromptCaching    bool `json:"prompt_caching"`
}

// Endpoint is the channel's connection facts (from the signed snapshot).
type Endpoint struct {
	BaseURL string
	// Protocol is an explicit compatible API selection; empty preserves legacy base semantics.
	Protocol   string
	AuthScheme string // bearer | x_api_key | query
	// QueryParam is the parameter name for query auth (e.g. "key" for Gemini).
	QueryParam string
	Region     string
	// Timeout records the core-enforced bound for a single upstream attempt.
	Timeout time.Duration
}

// Credential is an unwrapped upstream secret plus its non-secret identifiers.
// It must never be logged, serialised or attached to an error.
type Credential struct {
	// Ref is the credential id in the control plane (safe to log).
	Ref string
	// Fingerprint is the truncated hash from the Secret Plane (safe to log).
	Fingerprint string
	// Secret is the plaintext credential. Never log.
	Secret string
	// AuthorizationBinding pins a production resolver grant to its signed envelope.
	AuthorizationBinding   string
	AuthorizationExpiresAt time.Time
}

// ProviderRequest is a fully built upstream call.
type ProviderRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
	// StreamQuery marks URLs that must carry streaming parameters.
	StreamQuery string
}

// ProviderResult is a buffered upstream response (non-streaming path).
type ProviderResult struct {
	StatusCode int
	Header     http.Header
	Body       []byte
	// ProviderRequestID is extracted from response headers when present.
	ProviderRequestID string
}

// HealthStatus is the adapter's own reachability verdict for a channel.
type HealthStatus struct {
	OK        bool
	CheckedAt time.Time
	Detail    string // redacted
}

// Stream yields canonical chunks until the upstream finishes or errors.
type Stream interface {
	// Next returns the next chunk. io.EOF follows a successful Done chunk.
	// A failed read may return a chunk with Usage alongside the error.
	Next() (CanonicalChunk, error)
	// Close releases the upstream connection. Safe to call more than once.
	Close() error
}

// ── Adapter interface ─────────────────────────────────────────────────

// Adapter is the EXECUTION half of ProviderAdapterV1.
type Adapter interface {
	// ID is the provider code, e.g. "openai".
	ID() string
	// Version is observable and reported in telemetry.
	Version() string
	// Capabilities reports what a model on this provider supports.
	Capabilities(model string) ModelCapabilities
	// ValidateRequest checks whether the adapter can preserve the requested
	// semantics. It is pure: no credentials, I/O or request mutation.
	ValidateRequest(req *CanonicalRequest) error
	// BuildRequest transforms a canonical request into a provider call. It must
	// never include the secret in a place that could be logged.
	BuildRequest(req *CanonicalRequest, cred Credential, ep Endpoint) (*ProviderRequest, error)
	// Stream executes the call and returns a chunk stream. The caller owns
	// closing it and cancelling via ctx.
	Stream(ctx context.Context, client *http.Client, call *ProviderRequest) (Stream, error)
	// ParseUsage extracts billable usage from a buffered response.
	ParseUsage(res *ProviderResult) *CanonicalUsage
	// ClassifyError maps a transport failure or error response to the canonical
	// taxonomy.
	ClassifyError(status int, body []byte, err error) ErrorClassification
	// Health probes the channel without generating billable output.
	Health(ctx context.Context, client *http.Client, cred Credential, ep Endpoint) HealthStatus
}

// ── Registry ──────────────────────────────────────────────────────────

// RegistryError is a startup-time configuration failure, not a request failure.
type RegistryError struct{ Message string }

func (e *RegistryError) Error() string { return "provider registry: " + e.Message }

// Registry maps provider codes to adapters. It is populated at startup and read
// concurrently; registration after startup is not supported.
type Registry struct {
	adapters map[string]Adapter
	versions map[string]string
}

func NewRegistry() *Registry {
	return &Registry{adapters: make(map[string]Adapter), versions: make(map[string]string)}
}

func (r *Registry) Register(a Adapter) error {
	if a == nil || a.ID() == "" {
		return &RegistryError{Message: "adapter needs an id"}
	}
	if _, exists := r.adapters[a.ID()]; exists {
		return &RegistryError{Message: fmt.Sprintf("adapter %q already registered", a.ID())}
	}
	r.adapters[a.ID()] = a
	r.versions[a.ID()] = a.Version()
	return nil
}

func (r *Registry) Get(id string) (Adapter, bool) {
	a, ok := r.adapters[id]
	return a, ok
}

// Codes lists registered provider codes in stable order.
func (r *Registry) Codes() []string {
	out := make([]string, 0, len(r.adapters))
	for code := range r.adapters {
		out = append(out, code)
	}
	sort.Strings(out)
	return out
}

// Versions exposes adapter versions for /healthz and telemetry (observability
// requirement of the contract).
func (r *Registry) Versions() map[string]string {
	out := make(map[string]string, len(r.versions))
	for k, v := range r.versions {
		out[k] = v
	}
	return out
}

// Builtin returns the adapters NexusAPI ships. openai/deepseek/qwen share one
// OpenAI-compatible implementation registered under three codes — the pattern
// the contract requires instead of provider branches in the core.
func Builtin() []Adapter {
	return []Adapter{
		NewOpenAICompatible("openai", "https://api.openai.com/v1"),
		NewOpenAICompatible("deepseek", "https://api.deepseek.com/v1"),
		NewOpenAICompatible("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
		NewAnthropic(),
		NewGemini(),
	}
}

// NewBuiltinRegistry builds the default registry.
func NewBuiltinRegistry() (*Registry, error) {
	r := NewRegistry()
	for _, a := range Builtin() {
		if err := r.Register(a); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// ── Shared helpers ────────────────────────────────────────────────────

// joinURL concatenates base and path without doubling or dropping a slash.
func joinURL(base, path string) string {
	base = strings.TrimRight(base, "/")
	if path == "" {
		return base
	}
	return base + "/" + strings.TrimLeft(path, "/")
}

// truncateForClassification returns a small, safe slice of an error body for
// classification only. Callers must never log the result verbatim.
func truncateForClassification(body []byte) string {
	const max = 2048
	if len(body) > max {
		body = body[:max]
	}
	return strings.ToLower(string(body))
}

// classifyHTTPStatus is the shared status→taxonomy mapping. Provider adapters
// may refine it (e.g. content-policy detection) but must not contradict it.
func classifyHTTPStatus(status int) ErrorClassification {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrorClassification{Kind: ErrAuth, Retryable: false}
	case status == http.StatusPaymentRequired:
		return ErrorClassification{Kind: ErrQuota, Retryable: false}
	case status == http.StatusTooManyRequests:
		return ErrorClassification{Kind: ErrRateLimit, Retryable: true, RetryAfterMs: 1000}
	case status == http.StatusRequestTimeout || status == http.StatusConflict:
		return ErrorClassification{Kind: ErrTransient, Retryable: true}
	case status == http.StatusBadRequest || status == http.StatusUnprocessableEntity:
		return ErrorClassification{Kind: ErrInvalidRequest, Retryable: false}
	case status >= 500:
		return ErrorClassification{Kind: ErrProviderDown, Retryable: true}
	default:
		return ErrorClassification{Kind: ErrUnknown, Retryable: false}
	}
}

// ErrStreamClosed is returned by Stream.Next after Close.
var ErrStreamClosed = errors.New("provider: stream closed")

// ErrStreamTruncated means the transport ended before protocol completion.
// Observed usage is still returned on the accompanying chunk when available.
var ErrStreamTruncated = errors.New("provider: stream ended before completion")
