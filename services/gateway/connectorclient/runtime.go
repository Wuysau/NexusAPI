package connectorclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	ErrLeaseExpired          = errors.New("connector lease expired")
	ErrAuthorizationRejected = errors.New("connector identity authorization rejected")
)

// decodeBoundedJSON consumes the entire bounded response. A valid JSON prefix
// followed by another value, junk, or excess whitespace is not a valid response.
func decodeBoundedJSON(r io.Reader, limit int64, out any) error {
	raw, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil || int64(len(raw)) > limit || json.Unmarshal(raw, out) != nil {
		return errRemote
	}
	return nil
}

func (c *Client) validJob(j job) bool {
	if !validJobID(j.ID) || (!j.Deadline.IsZero() && !time.Now().Before(j.Deadline)) {
		return false
	}
	var parsed struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(j.Body, &parsed) != nil || parsed.Model != j.Model {
		return false
	}
	for _, model := range c.config.Models {
		if model == j.Model {
			return true
		}
	}
	return false
}

func (c *Client) Run(parent context.Context, identity Identity) error {
	if identity.ControlURL != c.config.ControlURL || !strings.HasPrefix(identity.Credential, "nxidentity_") {
		return errors.New("identity is not bound to this control origin; pair again")
	}
	ctx, cancel := context.WithCancelCause(parent)
	var workers sync.WaitGroup
	defer func() {
		cancel(nil)
		workers.Wait()
	}()
	if err := c.renew(ctx, identity, false); err != nil {
		if parent.Err() != nil {
			return nil
		}
		return err
	}
	changed := make(chan struct{}, 1)
	workers.Add(2)
	go func() { defer workers.Done(); c.watchLease(ctx, cancel, changed) }()
	go func() { defer workers.Done(); c.renewLoop(ctx, cancel, identity, changed) }()
	sem := make(chan struct{}, 4)
	var retry retryBackoff
polling:
	for ctx.Err() == nil {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break polling
		}
		current, active := c.activeLease(cancel)
		if !active {
			<-sem
			break
		}
		started := time.Now()
		j, empty, err := c.poll(ctx, current.Token)
		if err != nil || empty {
			<-sem
			if empty && time.Since(started) >= retryBase {
				retry.reset()
				continue
			}
			// Even 401 from the Gateway can mean its control-plane check timed
			// out. Only the direct identity renewal can reject the identity.
			if !pause(ctx, retry.next()) {
				break
			}
			continue
		}
		if ctx.Err() != nil {
			<-sem
			break
		}
		if _, active := c.activeLease(cancel); !active {
			<-sem
			break
		}
		retry.reset()
		workers.Add(1)
		// A claimed job keeps its original token; it is never requeued or
		// rebound when a concurrent renewal publishes another token.
		go func() { defer workers.Done(); defer func() { <-sem }(); c.execute(ctx, current.Token, j) }()
	}
	if parent.Err() != nil {
		return nil
	}
	return context.Cause(ctx)
}

func (c *Client) poll(parent context.Context, token string) (job, bool, error) {
	timeout := c.pollTimeout
	if timeout <= 0 {
		timeout = 35 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	res, err := c.request(ctx, "POST", "/connector/poll", token, nil)
	if err != nil {
		return job{}, false, errRemote
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNoContent {
		return job{}, true, nil
	}
	var j job
	if res.StatusCode != http.StatusOK || decodeBoundedJSON(res.Body, 2<<20, &j) != nil || !c.validJob(j) {
		return job{}, false, errRemote
	}
	return j, false, nil
}

func (c *Client) watchLease(ctx context.Context, cancel context.CancelCauseFunc, changed <-chan struct{}) {
	for {
		current, active := c.activeLease(cancel)
		if !active {
			return
		}
		timer := time.NewTimer(time.Until(current.ExpiresAt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-changed:
		case <-timer.C:
		}
		timer.Stop()
	}
}

func (c *Client) activeLease(cancel context.CancelCauseFunc) (lease, bool) {
	// Expiry and publication of a renewal must share the same lock. Never
	// cancel from an earlier snapshot: it may already have been extended.
	c.mu.Lock()
	defer c.mu.Unlock()
	if !time.Now().Before(c.lease.ExpiresAt) {
		cancel(ErrLeaseExpired)
		return lease{}, false
	}
	return c.lease, true
}

func renewalDelay(expires time.Time) time.Duration {
	// Very short grants must not turn successful renewals into a busy loop.
	// The independent watchdog still cancels at the exact known deadline.
	return min(20*time.Second, max(10*time.Millisecond, time.Until(expires)/3))
}

func (c *Client) renewLoop(ctx context.Context, cancel context.CancelCauseFunc, identity Identity, changed chan<- struct{}) {
	var retry retryBackoff
	delay := renewalDelay(c.currentLease().ExpiresAt)
	for pause(ctx, delay) {
		err := c.renew(ctx, identity, true)
		if errors.Is(err, ErrAuthorizationRejected) || errors.Is(err, ErrLeaseExpired) {
			cancel(err)
			return
		}
		if err != nil {
			delay = retry.next()
			continue
		}
		select {
		case changed <- struct{}{}:
		default:
		}
		retry.reset()
		delay = renewalDelay(c.currentLease().ExpiresAt)
	}
}
