package main

import (
	"math/rand/v2"
	"testing"
	"time"

	"nexus/gateway/provider"
)

func routingFixture() (*Router, *GatewayBundle, RouteRequest) {
	registry := provider.NewRegistry()
	_ = registry.Register(provider.NewOpenAICompatible("openai", "https://api.openai.com"))
	router := NewRouter(registry, NewBreaker(DefaultBreakerConfig()), DefaultScoreWeights())
	bundle := &GatewayBundle{Channels: []SnapshotChannel{
		{ID: "a", Provider: "openai", Models: []string{"gpt-4o"}, CredentialMode: "managed", CredentialRef: "a", Enabled: true, Weight: 1},
		{ID: "b", Provider: "openai", Models: []string{"gpt-4o"}, CredentialMode: "managed", CredentialRef: "b", Enabled: true, Weight: 3},
	}}
	return router, bundle, RouteRequest{ResolvedModel: "gpt-4o", EstimatedInputTokens: 100, EstimatedOutputTokens: 100}
}

func TestRoutingWeightsDistributeSamePriorityTraffic(t *testing.T) {
	router, bundle, req := routingFixture()
	router.random = rand.New(rand.NewPCG(1, 2)).Float64
	counts := map[string]int{}
	for i := 0; i < 2000; i++ {
		candidates, err := router.Select(bundle, req)
		if err != nil {
			t.Fatal(err)
		}
		counts[candidates[0].Channel.ID]++
	}
	if counts["a"] < 350 || counts["a"] > 650 {
		t.Fatalf("1:3 weight must distribute traffic, got %v", counts)
	}
}

func TestRoutingChannelPriorityPrecedesSoftScoreAndWeight(t *testing.T) {
	router, bundle, req := routingFixture()
	bundle.Channels[0].Priority = 1
	bundle.Channels[1].Priority = 9
	for i := 0; i < 40; i++ {
		candidates, err := router.Select(bundle, req)
		if err != nil {
			t.Fatal(err)
		}
		if candidates[0].Channel.ID != "a" {
			t.Fatal("channel priority ignored")
		}
	}
}

func TestRoutingUnknownCostDoesNotScoreAsFree(t *testing.T) {
	router, bundle, req := routingFixture()
	candidates := []Candidate{{Channel: &bundle.Channels[0]}, {Channel: &bundle.Channels[1], Price: &SnapshotPriceVersion{Components: []SnapshotPriceComponent{{Kind: "input", Amount: "1"}, {Kind: "output", Amount: "1"}}}}}
	router.score(candidates, req)
	if candidates[0].Score < candidates[1].Score {
		t.Fatalf("unknown cost preferred: %v < %v", candidates[0].Score, candidates[1].Score)
	}
}

func TestRoutingLoadAndTTFTAreIndependentOfRequestDuration(t *testing.T) {
	router, bundle, req := routingFixture()
	router.breaker.RecordSuccess(BreakerKey("a", req.ResolvedModel), time.Minute)
	router.breaker.RecordSuccess(BreakerKey("b", req.ResolvedModel), time.Second)
	router.breaker.RecordTTFT(BreakerKey("a", req.ResolvedModel), 10*time.Millisecond)
	router.breaker.RecordTTFT(BreakerKey("b", req.ResolvedModel), 100*time.Millisecond)
	candidates := []Candidate{{Channel: &bundle.Channels[0]}, {Channel: &bundle.Channels[1]}}
	router.score(candidates, req)
	if candidates[0].Score >= candidates[1].Score {
		t.Fatal("full request duration contaminated TTFT ranking")
	}
	release := router.BeginRequest("a", req.ResolvedModel)
	router.score(candidates, req)
	loaded := candidates[0].Score
	release()
	release()
	router.score(candidates, req)
	if loaded <= candidates[0].Score {
		t.Fatal("in-flight load did not affect routing")
	}
}

func TestRoutingInspectionDoesNotConsumeHalfOpenProbe(t *testing.T) {
	router, bundle, req := routingFixture()
	key := BreakerKey("a", req.ResolvedModel)
	for i := 0; i < 5; i++ {
		router.breaker.RecordFailure(key)
	}
	router.breaker.SetClock(func() time.Time { return time.Now().Add(time.Minute) })
	for i := 0; i < 4; i++ {
		candidates, err := router.Select(bundle, req)
		if err != nil || len(candidates) != 2 {
			t.Fatalf("inspection consumed probe: %v %d", err, len(candidates))
		}
	}
	if !router.breaker.Allow(key) || router.breaker.Allow(key) {
		t.Fatal("probe limit not enforced")
	}
	router.breaker.ReleaseProbe(key)
	if !router.breaker.Allow(key) {
		t.Fatal("unused probe not released")
	}
}

func TestRoutingRecentErrorsPenalizeBeforeCircuitOpens(t *testing.T) {
	router, bundle, req := routingFixture()
	key := BreakerKey("a", req.ResolvedModel)
	router.breaker.RecordFailure(key)
	candidates := []Candidate{{Channel: &bundle.Channels[0]}, {Channel: &bundle.Channels[1]}}
	router.score(candidates, req)
	if candidates[0].Score <= candidates[1].Score {
		t.Fatal("recent upstream error did not affect health before circuit threshold")
	}
	before := candidates[0].Score
	router.breaker.RecordSuccess(key, time.Second)
	router.score(candidates, req)
	if candidates[0].Score >= before {
		t.Fatal("upstream success did not improve health")
	}
}
