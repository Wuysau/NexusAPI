package main

// Routing: hard constraints first, then soft scoring.
//
// GATEWAY_SPEC "路由和切换":
//   - hard: data residency, model licence, credential mode, scope, capability
//   - soft: price, latency, health
//   - hard constraints are NEVER relaxed on failure (that is what makes them
//     hard); if nothing survives the filter the request fails with
//     503 no_healthy_upstream rather than silently falling back to a channel
//     the policy forbids.
//
// Candidates are weighted within a channel priority band. Soft signals adjust
// their effective weight; the resulting order is fixed for this request.

import (
	"errors"
	"math"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"sync"

	"nexus/gateway/provider"
)

// RouteRequest describes what the caller is allowed and asking for.
type RouteRequest struct {
	TenantID             string
	RequestedModel       string // alias or model id as the client sent it
	ResolvedModel        string // upstream model id after alias resolution
	RequiredCapabilities []string
	// CredentialMode restricts candidates to "managed" or "byok"; empty means
	// the snapshot policy decides.
	CredentialMode string
	// RequiredRegion pins data residency when the key's policy demands it.
	RequiredRegion string
	// EstimatedInputTokens/EstimatedOutputTokens feed the cost RANKING only.
	// Money arithmetic (holds, charges) never happens in the gateway — see
	// relativeCost's contract note.
	EstimatedInputTokens  int
	EstimatedOutputTokens int
}

// Candidate is one routable channel after filtering and scoring.
type Candidate struct {
	Channel *SnapshotChannel
	Adapter provider.Adapter
	Price   *SnapshotPriceVersion
	Score   float64
}

// ErrNoCandidate means every candidate was excluded by a hard constraint or an
// open circuit. Callers translate it to 503.
var ErrNoCandidate = errors.New("router: no candidate survives the hard filter")

// Router selects and orders upstream candidates.
type Router struct {
	registry *provider.Registry
	breaker  *Breaker
	weights  ScoreWeights
	mu       sync.Mutex
	inFlight map[string]int
	random   func() float64
}

// ScoreWeights controls the soft-score blend. Cost dominates by default.
type ScoreWeights struct {
	Cost    float64
	Latency float64
	Health  float64
	Load    float64
}

func DefaultScoreWeights() ScoreWeights {
	return ScoreWeights{Cost: 0.5, Latency: 0.3, Health: 0.2, Load: 0.3}
}

func NewRouter(registry *provider.Registry, breaker *Breaker, weights ScoreWeights) *Router {
	return &Router{registry: registry, breaker: breaker, weights: weights, inFlight: make(map[string]int), random: rand.Float64}
}

// Select returns candidates best-first. A non-nil error means no candidate is
// currently allowed.
func (r *Router) Select(bundle *GatewayBundle, req RouteRequest) ([]Candidate, error) {
	if bundle == nil {
		return nil, ErrNoCandidate
	}
	var candidates []Candidate
	for i := range bundle.Channels {
		channel := &bundle.Channels[i]
		if !r.passesHardFilter(bundle, channel, req) {
			continue
		}
		adapter, ok := r.channelAdapter(channel)
		if !ok {
			// A channel whose provider has no adapter is a configuration error,
			// not a reason to relax a hard constraint.
			continue
		}
		candidates = append(candidates, Candidate{
			Channel: channel,
			Adapter: adapter,
			Price:   bundle.LookupPrice(channel.Provider, req.ResolvedModel, channel.Region),
		})
	}
	if len(candidates) == 0 {
		return nil, ErrNoCandidate
	}
	r.score(candidates, req)
	r.order(candidates)
	return candidates, nil
}

// passesHardFilter applies every mandatory constraint. Each check is explicit so
// a reviewer can see that no failure path relaxes one.
func (r *Router) passesHardFilter(bundle *GatewayBundle, channel *SnapshotChannel, req RouteRequest) bool {
	if !channel.Enabled {
		return false
	}
	if channel.Provider == "" {
		return false
	}
	// Model licence: the channel must be licensed for the specific model.
	if !containsString(channel.Models, req.ResolvedModel) {
		return false
	}
	// Credential mode: managed and BYOK are never mixed (INVARIANT #13).
	if req.CredentialMode != "" && channel.CredentialMode != req.CredentialMode {
		return false
	}
	if channel.CredentialMode != "managed" && channel.CredentialMode != "byok" {
		return false
	}
	// Credential reference must exist; a channel without one cannot be called.
	if channel.CredentialRef == "" {
		return false
	}
	// Data residency.
	if req.RequiredRegion != "" {
		if channel.Region != req.RequiredRegion && channel.DataResidency != req.RequiredRegion {
			return false
		}
	}
	// Scope/capability: the model must declare every capability the request
	// needs on this channel.
	adapter, ok := r.channelAdapter(channel)
	if !ok {
		return false
	}
	caps := adapter.Capabilities(req.ResolvedModel)
	for _, required := range req.RequiredCapabilities {
		if !capabilitySatisfied(caps, required) {
			return false
		}
		if len(channel.Capabilities) > 0 && !containsString(channel.Capabilities, required) {
			return false
		}
	}
	// Circuit breaker is a hard exclusion: a channel known to be failing must
	// not receive traffic just because nothing else is available.
	return r.breaker.Available(BreakerKey(channel.ID, req.ResolvedModel))
}

func (r *Router) channelAdapter(channel *SnapshotChannel) (provider.Adapter, bool) {
	if channel.Protocol == "" {
		return r.registry.Get(channel.Provider)
	}
	if channel.Protocol != "openai" && channel.Protocol != "anthropic" {
		return nil, false
	}
	return r.registry.Get(channel.Protocol)
}

func (r *Router) score(candidates []Candidate, req RouteRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var maxCost float64
	latencies := make([]float64, len(candidates))
	for i, c := range candidates {
		cost := relativeCost(c.Price, req.EstimatedInputTokens, req.EstimatedOutputTokens)
		if cost > maxCost {
			maxCost = cost
		}
		latencies[i] = r.breaker.TTFTMs(BreakerKey(c.Channel.ID, req.ResolvedModel))
	}
	maxLatency := 0.0
	for _, l := range latencies {
		if l > maxLatency {
			maxLatency = l
		}
	}
	for i := range candidates {
		costScore := 1.0 // Unknown pricing is never treated as free.
		cost := relativeCost(candidates[i].Price, req.EstimatedInputTokens, req.EstimatedOutputTokens)
		if !math.IsNaN(cost) {
			costScore = 0
			if maxCost > 0 {
				costScore = cost / maxCost
			}
		}
		latencyScore := 0.0
		if maxLatency > 0 {
			latencyScore = latencies[i] / maxLatency
		}
		healthScore := healthPenalty(r.breaker.State(BreakerKey(candidates[i].Channel.ID, req.ResolvedModel)))
		healthScore += r.breaker.FailureRate(BreakerKey(candidates[i].Channel.ID, req.ResolvedModel))
		loadScore := float64(r.inFlight[BreakerKey(candidates[i].Channel.ID, req.ResolvedModel)])
		candidates[i].Score = r.weights.Cost*costScore + r.weights.Latency*latencyScore + r.weights.Health*healthScore + r.weights.Load*loadScore
	}
}

// order uses exponential races for weighted sampling without replacement.
// Model-route priority applies to models, not individual channel candidates;
// only the channel's own priority separates eligible channel bands.
func (r *Router) order(candidates []Candidate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	type ranked struct {
		candidate Candidate
		rank      float64
	}
	entries := make([]ranked, len(candidates))
	for i, c := range candidates {
		weight := float64(c.Channel.Weight)
		if weight <= 0 {
			weight = 1
		}
		u := r.random()
		if u <= 0 {
			u = math.SmallestNonzeroFloat64
		}
		entries[i] = ranked{c, -math.Log(u) * (1 + math.Max(0, c.Score)) / weight}
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.candidate.Channel.Priority != b.candidate.Channel.Priority {
			return a.candidate.Channel.Priority < b.candidate.Channel.Priority
		}
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		return a.candidate.Channel.ID < b.candidate.Channel.ID
	})
	for i := range entries {
		candidates[i] = entries[i].candidate
	}
}

// BeginRequest tracks a dispatched attempt, scoped to channel and model.
func (r *Router) BeginRequest(channelID, model string) func() {
	key := BreakerKey(channelID, model)
	r.mu.Lock()
	r.inFlight[key]++
	r.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.inFlight[key]--
			if r.inFlight[key] <= 0 {
				delete(r.inFlight, key)
			}
		})
	}
}

func healthPenalty(state BreakerState) float64 {
	switch state {
	case BreakerClosed:
		return 0
	case BreakerHalfOpen:
		return 1
	default:
		return 2
	}
}

// relativeCost is a RANKING signal, not money.
//
// Billing arithmetic (reservation holds, charges, ledger postings) lives in
// exactly one implementation — the control plane's pricing engine and ledger
// (INVARIANTS #2/#4). Duplicating it in Go would create a second source of
// monetary truth, which is precisely what those invariants forbid. The gateway
// therefore sends token counts to the control plane and lets it compute the
// hold, and only ever uses this float64 ratio to order equally-eligible
// channels. It is never persisted and never charged.
//
// NaN is returned when the price is unknown; a missing price is soft, so it
// does not remove the candidate.
func relativeCost(price *SnapshotPriceVersion, inputTokens, outputTokens int) float64 {
	if price == nil {
		return math.NaN()
	}
	var inputRate, outputRate float64
	var hasInput, hasOutput bool
	for _, component := range price.Components {
		amount := parseFloatAmount(component.Amount)
		switch component.Kind {
		case "input":
			inputRate = amount
			hasInput = true
		case "output":
			outputRate = amount
			hasOutput = true
		}
	}
	if (inputTokens > 0 && !hasInput) || (outputTokens > 0 && !hasOutput) {
		return math.NaN()
	}
	scale := 1.0
	if price.Unit == "per_million_tokens" {
		scale = 1_000_000
	}
	return (float64(inputTokens)*inputRate + float64(outputTokens)*outputRate) / scale
}

// parseFloatAmount parses a non-negative decimal amount for ranking only.
// Invalid, infinite or negative amounts are unknown, never free.
func parseFloatAmount(raw string) float64 {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value < 0 || math.IsInf(value, 0) {
		return math.NaN()
	}
	return value
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// capabilitySatisfied maps a contract capability name to the adapter's
// capability set.
func capabilitySatisfied(caps provider.ModelCapabilities, name string) bool {
	switch strings.ToLower(name) {
	case "text":
		return caps.Text
	case "vision":
		return caps.Vision
	case "audio":
		return caps.Audio
	case "embeddings":
		return caps.Embeddings
	case "reasoning":
		return caps.Reasoning
	case "streaming":
		return caps.Streaming
	case "tool_calling", "toolcalling":
		return caps.ToolCalling
	case "structured_output":
		return caps.StructuredOutput
	case "prompt_caching":
		return caps.PromptCaching
	default:
		// An unknown capability cannot be proven, so it is not satisfied.
		return false
	}
}

// RequiredCapabilitiesForChat is the baseline every chat request needs.
func RequiredCapabilitiesForChat() []string { return []string{"text"} }
