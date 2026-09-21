package main

// Limits: connection, header, body, token estimate, concurrency, per-minute
// requests and tokens, total duration, idle timeout (GATEWAY_SPEC "限制与取消").
//
// System caps come from the environment; the signed snapshot may only tighten
// them per tenant. Rate limiting uses a Redis token bucket so the fleet shares
// one budget. When Redis is unavailable the gateway degrades to a conservative
// per-instance bucket rather than removing the limit — losing the shared counter
// is not a reason to lose the ceiling (GATEWAY_SPEC "降级").

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// LimitDecision is the outcome of a limit check.
type LimitDecision struct {
	Allowed    bool
	RetryAfter time.Duration
	// Degraded is true when the answer came from the local fallback because
	// Redis was unreachable.
	Degraded bool
}

// Limiter enforces request/token rate limits and concurrency caps.
type Limiter struct {
	redis  *redis.Client
	logger *slog.Logger

	// localFallbackFraction scales the shared limit down when running without
	// Redis. With N gateway instances the per-instance ceiling should be
	// limit/N; 1/10 is a deliberately conservative default for the small
	// replica counts this deployment targets.
	localFallbackFraction int

	local *localBuckets
	conc  *concurrencyGuard

	degradedMu sync.RWMutex
	degraded   bool
}

// bucketLua is a token bucket with millisecond refill. Returns {allowed, retryMs}.
var bucketLua = redis.NewScript(`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local delta = now - ts
if delta < 0 then delta = 0 end
tokens = math.min(capacity, tokens + delta * refillPerMs)
if tokens < cost then
  local need = (cost - tokens) / refillPerMs
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, ttlMs)
  return {0, math.ceil(need)}
end
tokens = tokens - cost
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttlMs)
return {1, 0}
`)

func NewLimiter(redisURL string, logger *slog.Logger) (*Limiter, error) {
	if logger == nil {
		logger = slog.Default()
	}
	l := &Limiter{
		logger:                logger,
		localFallbackFraction: 10,
		local:                 newLocalBuckets(),
		conc:                  newConcurrencyGuard(),
	}
	if redisURL != "" {
		opts, err := redis.ParseURL(redisURL)
		if err != nil {
			return nil, err
		}
		l.redis = redis.NewClient(opts)
	}
	return l, nil
}

// Close releases the Redis client.
func (l *Limiter) Close() error {
	if l.redis != nil {
		return l.redis.Close()
	}
	return nil
}

// Ping verifies Redis connectivity for readiness reporting.
func (l *Limiter) Ping(ctx context.Context) error {
	if l.redis == nil {
		return errors.New("redis not configured")
	}
	return l.redis.Ping(ctx).Err()
}

// HasRedis reports whether a shared limiter is configured. When it is, the
// idempotency guard can be made fleet-wide instead of per-instance.
func (l *Limiter) HasRedis() bool { return l != nil && l.redis != nil }

// ClaimIdempotency reserves a key with SET NX EX. Returns true when the caller
// won the claim. An error means the caller must fall back to a local guard.
func (l *Limiter) ClaimIdempotency(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	if l == nil || l.redis == nil {
		return false, errors.New("redis not configured")
	}
	claimed, err := l.redis.SetNX(ctx, key, "1", ttl).Result()
	if err != nil {
		l.setDegraded(true)
		return false, err
	}
	l.setDegraded(false)
	return claimed, nil
}

// ReleaseIdempotency drops a claim that has not yet been dispatched.
func (l *Limiter) ReleaseIdempotency(ctx context.Context, key string) error {
	if l == nil || l.redis == nil {
		return nil
	}
	return l.redis.Del(ctx, key).Err()
}

// Degraded reports whether the limiter is currently running without Redis.
func (l *Limiter) Degraded() bool {
	l.degradedMu.RLock()
	defer l.degradedMu.RUnlock()
	return l.degraded
}

func (l *Limiter) setDegraded(v bool) {
	l.degradedMu.Lock()
	changed := l.degraded != v
	l.degraded = v
	l.degradedMu.Unlock()
	if changed && v {
		l.logger.Warn("redis unavailable: rate limits degraded to conservative local buckets")
	}
}

// Allow consumes `cost` units from a token bucket.
//
// A Redis failure degrades to a local bucket at a fraction of the configured
// limit and reports Degraded=true so callers can apply paid-traffic policy.
func (l *Limiter) Allow(ctx context.Context, bucket string, capacity int, window time.Duration, cost int) LimitDecision {
	if capacity <= 0 || window <= 0 {
		return LimitDecision{Allowed: true}
	}
	if cost < 1 {
		cost = 1
	}
	if l.redis == nil {
		return l.allowLocal(bucket, capacity, window, cost)
	}
	refillPerMs := float64(capacity) / float64(window.Milliseconds())
	res, err := bucketLua.Run(ctx, l.redis, []string{"nexus:rl:" + bucket},
		capacity, refillPerMs, time.Now().UnixMilli(), cost, window.Milliseconds()*2).Slice()
	if err != nil {
		l.setDegraded(true)
		return l.allowLocal(bucket, capacity, window, cost)
	}
	l.setDegraded(false)
	allowed, _ := res[0].(int64)
	if allowed == 1 {
		return LimitDecision{Allowed: true}
	}
	retryMs, _ := res[1].(int64)
	return LimitDecision{Allowed: false, RetryAfter: time.Duration(retryMs) * time.Millisecond}
}

// allowLocal is the degraded path: a per-instance bucket at a reduced ceiling.
func (l *Limiter) allowLocal(bucket string, capacity int, window time.Duration, cost int) LimitDecision {
	localCapacity := capacity / l.localFallbackFraction
	if localCapacity < 1 {
		localCapacity = 1
	}
	allowed, retryAfter := l.local.allow(bucket, localCapacity, window, cost)
	return LimitDecision{Allowed: allowed, RetryAfter: retryAfter, Degraded: true}
}

// AcquireConcurrency reserves a slot for a tenant. The returned release func is
// always safe to call once.
func (l *Limiter) AcquireConcurrency(tenantID string, max int) (func(), bool) {
	return l.conc.acquire(tenantID, max)
}

// localBuckets is a mutex-guarded token bucket set used when Redis is down or
// unconfigured.
type localBuckets struct {
	mu      sync.Mutex
	buckets map[string]*localBucket
}

type localBucket struct {
	tokens     float64
	lastRefill time.Time
}

func newLocalBuckets() *localBuckets {
	return &localBuckets{buckets: make(map[string]*localBucket)}
}

func (b *localBuckets) allow(key string, capacity int, window time.Duration, cost int) (bool, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	bucket, ok := b.buckets[key]
	if !ok {
		bucket = &localBucket{tokens: float64(capacity), lastRefill: now}
		b.buckets[key] = bucket
	}
	refillPerMs := float64(capacity) / float64(window.Milliseconds())
	elapsed := now.Sub(bucket.lastRefill).Milliseconds()
	if elapsed > 0 {
		bucket.tokens = minFloat(float64(capacity), bucket.tokens+float64(elapsed)*refillPerMs)
		bucket.lastRefill = now
	}
	if bucket.tokens < float64(cost) {
		needMs := (float64(cost) - bucket.tokens) / refillPerMs
		return false, time.Duration(needMs) * time.Millisecond
	}
	bucket.tokens -= float64(cost)
	// Opportunistic sweep so a long-lived process cannot grow this map forever.
	if len(b.buckets) > 100_000 {
		for k, v := range b.buckets {
			if now.Sub(v.lastRefill) > 10*window {
				delete(b.buckets, k)
			}
		}
	}
	return true, 0
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// concurrencyGuard bounds in-flight requests globally and per tenant.
//
// The global cap protects the process; the tenant cap is what the snapshot may
// tighten. Both are released by the release func, including on client
// disconnect (the proxy defers it).
type concurrencyGuard struct {
	mu      sync.Mutex
	global  chan struct{}
	tenants map[string]chan struct{}
}

// newConcurrencyGuard builds the guard. The global channel is sized lazily on
// first use because the system cap arrives with the config; a small default
// keeps the type usable in tests.
func newConcurrencyGuard() *concurrencyGuard {
	return &concurrencyGuard{tenants: make(map[string]chan struct{})}
}

// SetGlobalCap sizes the process-wide semaphore. Safe to call once at startup.
func (g *concurrencyGuard) SetGlobalCap(max int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if max < 1 {
		max = 1
	}
	if g.global == nil {
		g.global = make(chan struct{}, max)
	}
}

func (g *concurrencyGuard) acquire(tenantID string, max int) (func(), bool) {
	g.mu.Lock()
	if g.global == nil {
		g.global = make(chan struct{}, 256)
	}
	global := g.global
	tenant, ok := g.tenants[tenantID]
	if !ok || cap(tenant) != max {
		tenant = make(chan struct{}, max)
		g.tenants[tenantID] = tenant
	}
	g.mu.Unlock()

	select {
	case global <- struct{}{}:
	default:
		return func() {}, false
	}
	select {
	case tenant <- struct{}{}:
	default:
		<-global
		return func() {}, false
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			<-tenant
			<-global
		})
	}, true
}

// ConcurrencyFor merges the system cap with the snapshot's tenant cap.
func ConcurrencyFor(system int, bundle *GatewayBundle) int {
	if bundle == nil {
		return system
	}
	if v := bundle.Limits.MaxConcurrent; v > 0 && v < system {
		return v
	}
	return system
}

// EstimateTokens is the pre-flight token estimate used for the per-minute token
// bucket. It is deliberately pessimistic: bytes/3 over-counts English text and
// errs on the side of refusing rather than overspending. The real counts replace
// it in the usage event, which is what billing uses.
func EstimateTokens(bodyBytes int, maxTokens int) int {
	estimate := bodyBytes / 3
	if maxTokens > 0 {
		estimate += maxTokens
	}
	if estimate < 1 {
		estimate = 1
	}
	return estimate
}

// RateLimitBucket names a rate-limit bucket. Buckets are tenant-scoped so one
// tenant cannot exhaust another's budget.
func RateLimitBucket(tenantID, keyID, model, kind string) string {
	return tenantID + ":" + keyID + ":" + model + ":" + kind
}
