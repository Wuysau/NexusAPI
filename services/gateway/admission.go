package main

// Fleet admission uses Redis sorted sets of expiring, individually owned
// leases. Server time and one atomic script coordinate tenant/channel caps.
// A lost renewal cancels the upstream context, rather than letting work run
// indefinitely after another instance reclaims its capacity.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	ErrConcurrencyLimit       = errors.New("concurrency limit reached")
	ErrConcurrencyUnavailable = errors.New("shared concurrency admission unavailable")
)

type ConcurrencyRequest struct {
	TenantID, ChannelID       string
	TenantLimit, ChannelLimit int
	WaitTimeout, LeaseTTL     time.Duration
	// AllowLocal must only be enabled for explicit nonproduction profiles.
	AllowLocal bool
}

type ConcurrencyLease struct {
	ctx     context.Context
	cancel  context.CancelFunc
	once    sync.Once
	release func()
}

func (l *ConcurrencyLease) Context() context.Context { return l.ctx }
func (l *ConcurrencyLease) Release() {
	l.once.Do(func() { l.cancel(); l.release() })
}

var acquireLeaseLua = redis.NewScript(`
local t = redis.call('TIME')
local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)
local ttl = tonumber(ARGV[2])
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
  if redis.call('ZCARD',key) >= tonumber(ARGV[i+2]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD',key,now+ttl,ARGV[1])
  if redis.call('PTTL',key) < ttl*2 then redis.call('PEXPIRE',key,ttl*2) end
end
return 1
`)

var renewLeaseLua = redis.NewScript(`
local t = redis.call('TIME')
local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)
local ttl = tonumber(ARGV[2])
for _,key in ipairs(KEYS) do
  local expires = redis.call('ZSCORE',key,ARGV[1])
  if not expires or tonumber(expires) <= now then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD',key,'XX',now+ttl,ARGV[1])
  if redis.call('PTTL',key) < ttl*2 then redis.call('PEXPIRE',key,ttl*2) end
end
return 1
`)

var releaseLeaseLua = redis.NewScript(`
for _,key in ipairs(KEYS) do
  redis.call('ZREM',key,ARGV[1])
  if redis.call('ZCARD',key) == 0 then redis.call('DEL',key) end
end
return 1
`)

// concurrencyKeys uses a common Redis Cluster hash slot so combined admission
// remains atomic. Channels are globally scoped: a shared managed account has
// the same cap even when called by different tenants. IDs are hashed to keep
// delimiters or braces in caller identifiers from changing key semantics.
func concurrencyKeys(req ConcurrencyRequest) ([]string, []int) {
	var keys []string
	var limits []int
	add := func(kind, id string, limit int) {
		if limit <= 0 {
			return
		}
		digest := sha256.Sum256([]byte(id))
		keys = append(keys, "nexus:{admission}:"+kind+":"+hex.EncodeToString(digest[:]))
		limits = append(limits, limit)
	}
	add("tenant", req.TenantID, req.TenantLimit)
	add("channel", req.ChannelID, req.ChannelLimit)
	return keys, limits
}

// AcquireContext reserves all requested scopes or none. A zero cap omits that
// scope. Waiting is bounded by both WaitTimeout and the caller's context.
func (l *Limiter) AcquireContext(ctx context.Context, req ConcurrencyRequest) (*ConcurrencyLease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if req.TenantLimit < 0 || req.ChannelLimit < 0 || (req.TenantLimit == 0 && req.ChannelLimit == 0) || (req.TenantLimit > 0 && req.TenantID == "") || (req.ChannelLimit > 0 && req.ChannelID == "") {
		return nil, fmt.Errorf("%w: invalid scope or limit", ErrConcurrencyUnavailable)
	}
	if req.LeaseTTL <= 0 {
		req.LeaseTTL = 30 * time.Second
	}
	if req.LeaseTTL < 90*time.Millisecond {
		req.LeaseTTL = 90 * time.Millisecond
	}
	deadline := time.Now().Add(req.WaitTimeout)
	for {
		lease, err := l.tryAcquireContext(ctx, req)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, ErrConcurrencyLimit) || req.WaitTimeout <= 0 {
			return nil, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, ErrConcurrencyLimit
		}
		pause := 20 * time.Millisecond
		if remaining < pause {
			pause = remaining
		}
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (l *Limiter) tryAcquireContext(ctx context.Context, req ConcurrencyRequest) (*ConcurrencyLease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if l.redis == nil {
		if !req.AllowLocal {
			return nil, ErrConcurrencyUnavailable
		}
		return l.acquireLocalLease(ctx, req)
	}
	// Only the tenant stage consumes process capacity; acquiring the channel
	// later in the same request must not count that request twice.
	releaseProcess, ok := l.conc.acquireScopes("", 0, "", 0, req.TenantLimit > 0)
	if !ok {
		return nil, ErrConcurrencyLimit
	}
	keys, limits := concurrencyKeys(req)
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		releaseProcess()
		return nil, fmt.Errorf("%w: %v", ErrConcurrencyUnavailable, err)
	}
	id := hex.EncodeToString(token[:])
	args := []any{id, req.LeaseTTL.Milliseconds()}
	for _, limit := range limits {
		args = append(args, limit)
	}
	// A stalled Redis connection must not extend the admission operation past
	// cancellation or leave an uncertain, potentially admitted slot unreleased.
	opCtx, cancel := context.WithTimeout(ctx, leaseOperationTimeout(req.LeaseTTL))
	allowed, err := acquireLeaseLua.Run(opCtx, l.redis, keys, args...).Int()
	cancel()
	if err != nil {
		releaseProcess()
		l.setDegraded(true)
		l.releaseSharedLease(keys, id)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if req.AllowLocal {
			return l.acquireLocalLease(ctx, req)
		}
		return nil, fmt.Errorf("%w: %v", ErrConcurrencyUnavailable, err)
	}
	l.setDegraded(false)
	if allowed != 1 {
		releaseProcess()
		return nil, ErrConcurrencyLimit
	}
	leaseCtx, leaseCancel := context.WithCancel(ctx)
	lease := &ConcurrencyLease{ctx: leaseCtx, cancel: leaseCancel, release: func() { releaseProcess(); l.releaseSharedLease(keys, id) }}
	go l.maintainLease(lease, keys, id, req.LeaseTTL)
	if ctx.Err() != nil {
		lease.Release()
		return nil, ctx.Err()
	}
	return lease, nil
}

func leaseOperationTimeout(ttl time.Duration) time.Duration {
	d := ttl / 4
	if d > time.Second {
		d = time.Second
	}
	return d
}

func (l *Limiter) releaseSharedLease(keys []string, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// Expiry recovers capacity if Redis remains unavailable during release.
	_ = releaseLeaseLua.Run(ctx, l.redis, keys, id).Err()
}

func (l *Limiter) acquireLocalLease(ctx context.Context, req ConcurrencyRequest) (*ConcurrencyLease, error) {
	release, ok := l.conc.acquireScopes(req.TenantID, req.TenantLimit, req.ChannelID, req.ChannelLimit, req.TenantLimit > 0)
	if !ok {
		return nil, ErrConcurrencyLimit
	}
	leaseCtx, cancel := context.WithCancel(ctx)
	lease := &ConcurrencyLease{ctx: leaseCtx, cancel: cancel, release: release}
	go func() { <-leaseCtx.Done(); lease.Release() }()
	return lease, nil
}

func (l *Limiter) maintainLease(lease *ConcurrencyLease, keys []string, id string, ttl time.Duration) {
	ticker := time.NewTicker(ttl / 3)
	defer ticker.Stop()
	defer lease.Release()
	for {
		select {
		case <-lease.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(lease.ctx, leaseOperationTimeout(ttl))
			renewed, err := renewLeaseLua.Run(ctx, l.redis, keys, id, ttl.Milliseconds()).Int()
			cancel()
			if err != nil || renewed != 1 {
				l.setDegraded(err != nil)
				return
			}
		}
	}
}
