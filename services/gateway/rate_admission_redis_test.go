//go:build redisintegration

package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Fail only a selected rate script. Shared concurrency, idempotency, and all
// other commands still use the real isolated Redis fixture.
type rateScriptFailureHook struct {
	key              string
	fail             atomic.Bool
	failures         atomic.Int64
	sharedAdmissions atomic.Int64
	cancel           context.CancelFunc
	waitForContext   bool
	timedOut         atomic.Bool
	deadlineBudget   atomic.Int64
	replaceReply     bool
	reply            any
}

func (h *rateScriptFailureHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h *rateScriptFailureHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (h *rateScriptFailureHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		args := cmd.Args()
		if cmd.Name() == "evalsha" && len(args) > 3 && args[1] == bucketLua.Hash() && args[3] == h.key && h.fail.Load() {
			h.failures.Add(1)
			if h.replaceReply {
				cmd.(*redis.Cmd).SetVal(h.reply)
				cmd.SetErr(nil)
				return nil
			}
			if h.waitForContext {
				if deadline, ok := ctx.Deadline(); ok {
					h.deadlineBudget.Store(int64(time.Until(deadline)))
				}
				<-ctx.Done()
				h.timedOut.Store(errors.Is(ctx.Err(), context.DeadlineExceeded))
				cmd.SetErr(ctx.Err())
				return ctx.Err()
			}
			// A non-NOSCRIPT error must not trigger go-redis's EVAL fallback.
			err := errors.New("private-rate-backend-fixture")
			if h.cancel != nil {
				h.cancel()
				err = ctx.Err()
			}
			cmd.SetErr(err)
			return err
		}
		err := next(ctx, cmd)
		if err == nil && cmd.Name() == "evalsha" && len(args) > 1 && args[1] == acquireLeaseLua.Hash() {
			h.sharedAdmissions.Add(1)
		}
		return err
	}
}

func TestRedisRateAdmissionProductionRejectsPartialRedisFailure(t *testing.T) {
	for _, kind := range []string{"req", "tok"} {
		t.Run(kind, func(t *testing.T) {
			limiter, _, prefix := admissionRedisFixture(t)
			keyID := prefix + "-key"
			keys := []SnapshotKey{{KeyID: keyID, TenantID: testTenantID, OrganizationID: testOrgID,
				ProjectID: "project-test", ProjectName: "Project Test", KeyKind: "shared", AttributionStatus: "attributed",
				HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeAll}, Enabled: true, RevocationEpoch: 1}}
			var upstreamCalls atomic.Int64
			h := newHarness(t, harnessOptions{Limiter: limiter, Keys: keys, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				upstreamCalls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			h.proxy.env.Environment = "production"
			// Preload only the concurrency script so its successful EVALSHA is
			// observable independently of the rate failure below.
			if err := acquireLeaseLua.Load(context.Background(), limiter.redis).Err(); err != nil {
				t.Fatal(err)
			}
			hook := &rateScriptFailureHook{key: "nexus:rl:" + RateLimitBucket(testTenantID, keyID, testModel, kind)}
			hook.fail.Store(true)
			limiter.redis.AddHook(hook)
			idempotencyKey := prefix + "-idempotency"
			t.Cleanup(func() {
				_ = limiter.redis.Del(context.Background(),
					"nexus:rl:"+RateLimitBucket(testTenantID, keyID, testModel, "req"),
					"nexus:rl:"+RateLimitBucket(testTenantID, keyID, testModel, "tok"),
					idempotencyRedisKey(testTenantID, idempotencyKey)).Err()
			})
			resp := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": idempotencyKey})
			body := readAll(resp)
			var envelope errorEnvelope
			if err := json.Unmarshal([]byte(body), &envelope); err != nil {
				t.Fatalf("error response is not JSON: %v", err)
			}
			if resp.StatusCode != http.StatusServiceUnavailable || envelope.Error.Code != CodeNoHealthyUpstream {
				t.Errorf("rate backend failure must reject production admission: status=%d code=%s", resp.StatusCode, envelope.Error.Code)
			}
			if strings.Contains(body, "private-rate-backend-fixture") {
				t.Error("rate backend error leaked into public response")
			}
			if hook.failures.Load() != 1 || hook.sharedAdmissions.Load() < 1 {
				t.Errorf("fixture did not isolate rate failure after real shared admission: failures=%d admissions=%d", hook.failures.Load(), hook.sharedAdmissions.Load())
			}
			if h.managed.reserveCount() != 0 || upstreamCalls.Load() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Errorf("unverified shared rate caused side effects: reserves=%d upstream=%d terminal=%d outbox=%d", h.managed.reserveCount(), upstreamCalls.Load(), len(h.store.Requests()), h.store.OutboxCount(testTenantID))
			}
			limiter.local.mu.Lock()
			localBuckets := len(limiter.local.buckets)
			limiter.local.mu.Unlock()
			if localBuckets != 0 {
				t.Errorf("production failure mutated %d local rate buckets", localBuckets)
			}
			if t.Failed() {
				return
			}

			// Recovery may retry a rejected operation under the same idempotency
			// key. Stop at an intentional budget denial, before any provider call;
			// the production fixture does not provide a Vault-backed credential.
			hook.fail.Store(false)
			h.managed.mu.Lock()
			h.managed.reserveErr = ErrBudgetExceeded
			h.managed.mu.Unlock()
			recovered := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": idempotencyKey})
			recoveryCode := errorCode(t, recovered)
			if recovered.StatusCode != http.StatusTooManyRequests || recoveryCode != CodeBudgetExceeded {
				t.Fatal("recovered shared rate check did not reach the independent budget decision")
			}
			if h.managed.reserveCount() != 1 || upstreamCalls.Load() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Fatalf("recovery repeated execution or failed to release idempotency: reserves=%d upstream=%d terminal=%d outbox=%d", h.managed.reserveCount(), upstreamCalls.Load(), len(h.store.Requests()), h.store.OutboxCount(testTenantID))
			}
		})
	}
}

func TestRedisRateAdmissionSharesCapacityAndServerTime(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	ctx := context.Background()
	bucket := prefix + "-rate"
	redisKey := "nexus:rl:" + bucket
	t.Cleanup(func() { _ = a.redis.Del(ctx, redisKey).Err() })
	before, err := a.redis.Time(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	// These are separate clients and local buckets, sharing one Redis bucket.
	for i, limiter := range []*Limiter{a, b, a, b, a, b} {
		decision, err := limiter.Allow(ctx, bucket, 3, time.Hour, 1, false)
		if err != nil || decision.Degraded || decision.Allowed != (i < 3) {
			t.Fatalf("alternating instance decision %d: %+v %v", i, decision, err)
		}
		if i >= 3 && (decision.RetryAfter <= 0 || decision.RetryAfter > 20*time.Minute) {
			t.Fatalf("shared exhausted bucket has invalid recovery hint: %s", decision.RetryAfter)
		}
	}
	ts, err := a.redis.HGet(ctx, redisKey, "ts").Int64()
	if err != nil {
		t.Fatal(err)
	}
	after, err := b.redis.Time(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	if ts < before.UnixMilli() || ts > after.UnixMilli() {
		t.Fatalf("bucket timestamp is outside Redis server clock: before=%d stored=%d after=%d", before.UnixMilli(), ts, after.UnixMilli())
	}
	for _, limiter := range []*Limiter{a, b} {
		assertNoLocalRateBuckets(t, limiter)
	}
}

func TestRedisRateAdmissionConcurrentInstancesDoNotExceedCapacity(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	ctx := context.Background()
	bucket := prefix + "-rate"
	t.Cleanup(func() { _ = a.redis.Del(ctx, "nexus:rl:"+bucket).Err() })
	var allowed atomic.Int64
	var workers sync.WaitGroup
	for i := range 32 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			limiter := a
			if i%2 == 1 {
				limiter = b
			}
			decision, err := limiter.Allow(ctx, bucket, 7, time.Hour, 1, false)
			if err != nil || decision.Degraded {
				t.Errorf("shared rate operation failed: %+v %v", decision, err)
				return
			}
			if decision.Allowed {
				allowed.Add(1)
			} else if decision.RetryAfter <= 0 {
				t.Error("temporary exhaustion omitted retry hint")
			}
		}()
	}
	workers.Wait()
	if allowed.Load() != 7 {
		t.Fatalf("shared capacity 7 admitted %d", allowed.Load())
	}
}

func TestRedisRateAdmissionOversizedCostHasNoRecoveryPromise(t *testing.T) {
	a, _, prefix := admissionRedisFixture(t)
	bucket := prefix + "-oversized"
	t.Cleanup(func() { _ = a.redis.Del(context.Background(), "nexus:rl:"+bucket).Err() })
	decision, err := a.Allow(context.Background(), bucket, 3, time.Minute, 4, false)
	if err != nil || decision.Allowed || decision.Degraded || decision.RetryAfter != 0 {
		t.Fatalf("cost exceeding full bucket cannot recover by waiting: %+v %v", decision, err)
	}
	assertNoLocalRateBuckets(t, a)
}

func TestRedisRateAdmissionExplicitDevelopmentFallback(t *testing.T) {
	a, _, prefix := admissionRedisFixture(t)
	bucket := prefix + "-development"
	hook := &rateScriptFailureHook{key: "nexus:rl:" + bucket}
	hook.fail.Store(true)
	a.redis.AddHook(hook)
	// Explicit development fallback is reduced to one request per minute.
	first, err := a.Allow(context.Background(), bucket, 10, time.Minute, 1, true)
	if err != nil || !first.Allowed || !first.Degraded {
		t.Fatalf("explicit development fallback failed: %+v %v", first, err)
	}
	second, err := a.Allow(context.Background(), bucket, 10, time.Minute, 1, true)
	if err != nil || second.Allowed || !second.Degraded || second.RetryAfter <= 0 {
		t.Fatalf("development fallback did not retain conservative rate: %+v %v", second, err)
	}
	if hook.failures.Load() != 2 {
		t.Fatalf("fixture expected two independent rate failures, got %d", hook.failures.Load())
	}
}

func TestRedisRateAdmissionCancellationNeverUsesLocalFallback(t *testing.T) {
	for _, duringCommand := range []bool{false, true} {
		t.Run(map[bool]string{false: "before_command", true: "during_command"}[duringCommand], func(t *testing.T) {
			a, _, prefix := admissionRedisFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			hook := &rateScriptFailureHook{key: "nexus:rl:" + prefix, cancel: cancel}
			hook.fail.Store(true)
			a.redis.AddHook(hook)
			if !duringCommand {
				cancel()
			}
			decision, err := a.Allow(ctx, prefix, 100, time.Minute, 1, true)
			if !errors.Is(err, context.Canceled) || decision.Allowed || decision.RetryAfter != 0 {
				t.Fatalf("cancelled rate operation became local admission: %+v %v", decision, err)
			}
			if !duringCommand && hook.failures.Load() != 0 {
				t.Error("already cancelled operation still attempted Redis")
			}
			if duringCommand && hook.failures.Load() != 1 {
				t.Error("fixture did not cancel during the rate operation")
			}
			assertNoLocalRateBuckets(t, a)
		})
	}
}

func assertNoLocalRateBuckets(t *testing.T, limiter *Limiter) {
	t.Helper()
	limiter.local.mu.Lock()
	defer limiter.local.mu.Unlock()
	if len(limiter.local.buckets) != 0 {
		t.Errorf("operation unexpectedly created %d local rate buckets", len(limiter.local.buckets))
	}
}

func TestRedisRateAdmissionOperationTimeoutRejectsBeforeBudget(t *testing.T) {
	limiter, _, prefix := admissionRedisFixture(t)
	var upstreamCalls atomic.Int64
	h := newHarness(t, harnessOptions{Limiter: limiter, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}})
	h.proxy.env.Environment = "production"
	if err := acquireLeaseLua.Load(context.Background(), limiter.redis).Err(); err != nil {
		t.Fatal(err)
	}
	hook := &rateScriptFailureHook{key: "nexus:rl:" + RateLimitBucket(testTenantID, testKeyID, testModel, "req"), waitForContext: true}
	hook.fail.Store(true)
	limiter.redis.AddHook(hook)
	started := time.Now()
	response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": prefix + "-timeout"})
	code := errorCode(t, response)
	elapsed := time.Since(started)
	if response.StatusCode != http.StatusServiceUnavailable || code != CodeNoHealthyUpstream {
		t.Fatalf("stalled rate operation reached another phase: status=%d code=%s", response.StatusCode, code)
	}
	if !hook.timedOut.Load() || hook.deadlineBudget.Load() <= 0 || time.Duration(hook.deadlineBudget.Load()) > time.Second || elapsed > 3*time.Second {
		t.Fatalf("rate operation did not enforce its one-second budget: timed_out=%v budget=%s elapsed=%s", hook.timedOut.Load(), time.Duration(hook.deadlineBudget.Load()), elapsed)
	}
	if hook.failures.Load() != 1 || hook.sharedAdmissions.Load() < 1 {
		t.Fatalf("fixture did not isolate one stalled rate check: rate=%d shared=%d", hook.failures.Load(), hook.sharedAdmissions.Load())
	}
	if h.managed.reserveCount() != 0 || upstreamCalls.Load() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
		t.Fatal("timed-out production rate check reserved, dispatched, or persisted")
	}
	assertNoLocalRateBuckets(t, limiter)
	if exists, err := limiter.redis.Exists(context.Background(), idempotencyRedisKey(testTenantID, prefix+"-timeout")).Result(); err != nil || exists != 0 {
		t.Fatalf("rate timeout retained rejected request's idempotency key: exists=%d err=%v", exists, err)
	}
}

func TestRedisRateAdmissionMalformedReplyFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply any
	}{
		{"empty_array", []any{}},
		{"short_array", []any{int64(1)}},
		{"long_array", []any{int64(1), int64(0), int64(0)}},
		{"not_array", "private-malformed-reply"},
		{"invalid_allowed", []any{int64(2), int64(0)}},
		{"allowed_wrong_type", []any{"1", int64(0)}},
		{"retry_wrong_type", []any{int64(0), "100"}},
		{"negative_retry", []any{int64(0), int64(-1)}},
		{"overflow_retry", []any{int64(0), int64(math.MaxInt64)}},
		{"success_with_retry", []any{int64(1), int64(100)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, prefix := admissionRedisFixture(t)
			hook := &rateScriptFailureHook{key: "nexus:rl:" + prefix, replaceReply: true, reply: tc.reply}
			hook.fail.Store(true)
			a.redis.AddHook(hook)
			decision, err := a.Allow(context.Background(), prefix, 100, time.Minute, 1, false)
			if !errors.Is(err, ErrRateLimitUnavailable) || decision.Allowed || decision.RetryAfter != 0 || hook.failures.Load() != 1 {
				t.Fatalf("malformed backend reply admitted work or became a rate denial: %+v %v interceptions=%d", decision, err, hook.failures.Load())
			}
			assertNoLocalRateBuckets(t, a)
			// Only this exact rate command was replaced. The same connection's
			// ordinary Redis commands still reach the disposable server.
			if err := a.Ping(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}
