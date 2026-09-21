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
// Candidate ordering is deterministic: a tie on score is broken by policy
// priority, then channel weight, then channel id. Deterministic ordering is what
// makes "no unsafe switch after upstream acceptance" reviewable.

import (
	"errors"
	"sort"
	"strconv"
	"strings"

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
}

// ScoreWeights controls the soft-score blend. Cost dominates by default.
type ScoreWeights struct {
	Cost    float64
	Latency float64
	Health  float64
}

func DefaultScoreWeights() ScoreWeights { return ScoreWeights{Cost: 0.5, Latency: 0.3, Health: 0.2} }

func NewRouter(registry *provider.Registry, breaker *Breaker, weights ScoreWeights) *Router {
	return &Router{registry: registry, breaker: breaker, weights: weights}
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
	sortCandidates(candidates, bundle, req)
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
	return r.breaker.Allow(BreakerKey(channel.ID, req.ResolvedModel))
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
	var maxCost float64
	latencies := make([]float64, len(candidates))
	for i, c := range candidates {
		cost := relativeCost(c.Price, req.EstimatedInputTokens, req.EstimatedOutputTokens)
		if cost > maxCost {
			maxCost = cost
		}
		latencies[i] = r.breaker.LatencyMs(BreakerKey(c.Channel.ID, req.ResolvedModel))
	}
	maxLatency := 0.0
	for _, l := range latencies {
		if l > maxLatency {
			maxLatency = l
		}
	}
	for i := range candidates {
		costScore := 0.0
		if maxCost > 0 {
			costScore = relativeCost(candidates[i].Price, req.EstimatedInputTokens, req.EstimatedOutputTokens) / maxCost
		}
		latencyScore := 0.0
		if maxLatency > 0 {
			latencyScore = latencies[i] / maxLatency
		}
		healthScore := healthPenalty(r.breaker.State(BreakerKey(candidates[i].Channel.ID, req.ResolvedModel)))
		candidates[i].Score = r.weights.Cost*costScore + r.weights.Latency*latencyScore + r.weights.Health*healthScore
	}
}

// sortCandidates orders best-first with a total, deterministic order.
func sortCandidates(candidates []Candidate, bundle *GatewayBundle, req RouteRequest) {
	priorityOf := func(candidate Candidate) (int, bool) {
		for _, policy := range bundle.Snapshot.RoutingPolicies {
			for _, route := range policy.ModelRoutes {
				if route.ModelID != req.ResolvedModel || route.Priority == nil {
					continue
				}
				return *route.Priority, true
			}
		}
		return 0, false
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		pi, hasI := priorityOf(candidates[i])
		pj, hasJ := priorityOf(candidates[j])
		if hasI != hasJ {
			return hasI
		}
		if hasI && hasJ && pi != pj {
			return pi < pj
		}
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score < candidates[j].Score
		}
		if candidates[i].Channel.Weight != candidates[j].Channel.Weight {
			return candidates[i].Channel.Weight > candidates[j].Channel.Weight
		}
		return candidates[i].Channel.ID < candidates[j].Channel.ID
	})
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
// Zero is returned when the price is unknown; a missing price is soft, so it
// does not remove the candidate.
func relativeCost(price *SnapshotPriceVersion, inputTokens, outputTokens int) float64 {
	if price == nil {
		return 0
	}
	var inputRate, outputRate float64
	for _, component := range price.Components {
		amount := parseFloatAmount(component.Amount)
		switch component.Kind {
		case "input":
			inputRate = amount
		case "output":
			outputRate = amount
		}
	}
	scale := 1.0
	if price.Unit == "per_million_tokens" {
		scale = 1_000_000
	}
	return (float64(inputTokens)*inputRate + float64(outputTokens)*outputRate) / scale
}

// parseFloatAmount parses a non-negative decimal amount for ranking only.
// Invalid or absent amounts rank as free, which the soft score tolerates; a
// negative amount (which the price contract forbids) also ranks as 0.
func parseFloatAmount(raw string) float64 {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value < 0 {
		return 0
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
