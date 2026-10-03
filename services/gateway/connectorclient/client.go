// Package connectorclient implements the local Ollama-only execution boundary.
package connectorclient

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"nexus/gateway/internal/retryafter"
)

type Config struct {
	ControlURL             string   `json:"controlUrl"`
	GatewayURL             string   `json:"gatewayUrl"`
	UpstreamURL            string   `json:"upstreamUrl"`
	Models                 []string `json:"models"`
	APIKeyEnv              string   `json:"apiKeyEnv,omitempty"`
	CAFile                 string   `json:"caFile,omitempty"`
	AllowHTTPDevelopment   bool     `json:"allowHttpDevelopment,omitempty"`
	UpstreamTimeoutSeconds int      `json:"upstreamTimeoutSeconds,omitempty"`
}
type Identity struct {
	ConnectorID  string `json:"connectorId"`
	ConnectionID string `json:"connectionId"`
	TenantID     string `json:"tenantId"`
	Credential   string `json:"credential"`
	ControlURL   string `json:"controlUrl"`
}
type lease struct {
	Token     string    `json:"leaseToken"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type job struct {
	ID       string          `json:"id"`
	Model    string          `json:"model"`
	Body     json.RawMessage `json:"body"`
	Deadline time.Time       `json:"deadline"`
}
type frame struct {
	Type         string `json:"type"`
	Status       int    `json:"status,omitempty"`
	Data         []byte `json:"data,omitempty"`
	Code         string `json:"code,omitempty"`
	RetryAfterMS int64  `json:"retry_after_ms,omitempty"`
}

// Keep only a normalized number on the wire. A positive HTTP-date remainder
// shorter than one millisecond must not disappear into the no-hint default.
func localRetryAfterMillis(headers http.Header, now time.Time) int64 {
	delay := retryafter.Parse(headers, now)
	return int64((delay + time.Millisecond - 1) / time.Millisecond)
}

var errRemote = errors.New("remote connector authorization or transport unavailable")

// Local configuration must use the Control Plane's approved model-ID grammar.
var modelIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`)

func (c *Config) Validate() error {
	for _, raw := range []string{c.ControlURL, c.GatewayURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return errors.New("remote URL must be an HTTPS origin")
		}
		ip, _ := netip.ParseAddr(u.Hostname())
		if u.Scheme != "https" && !(c.AllowHTTPDevelopment && u.Scheme == "http" && (ip.IsLoopback() || u.Hostname() == "localhost")) {
			return errors.New("verified TLS is required; development HTTP is loopback-only")
		}
	}
	u, e := url.Parse(c.UpstreamURL)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") || strings.TrimRight(u.Path, "/") != "/v1" {
		return errors.New("upstream must be an explicit private IP OpenAI /v1 endpoint")
	}
	host := u.Hostname()
	if host == "localhost" {
		host = "127.0.0.1"
		u.Host = net.JoinHostPort(host, u.Port())
		if u.Port() == "" {
			u.Host = host
		}
		c.UpstreamURL = u.String()
	}
	ip, e := netip.ParseAddr(host)
	if e != nil || (!ip.IsLoopback() && !ip.IsPrivate()) || ip.IsUnspecified() {
		return errors.New("upstream requires a loopback or private literal IP")
	}
	if len(c.Models) < 1 || len(c.Models) > 64 {
		return errors.New("explicit local model allowlist required")
	}
	for _, m := range c.Models {
		if !modelIDPattern.MatchString(m) {
			return errors.New("invalid model ID")
		}
	}
	if c.UpstreamTimeoutSeconds == 0 {
		c.UpstreamTimeoutSeconds = 120
	}
	if c.UpstreamTimeoutSeconds < 1 || c.UpstreamTimeoutSeconds > 600 {
		return errors.New("upstream timeout must be 1..600 seconds")
	}
	if c.APIKeyEnv != "" && os.Getenv(c.APIKeyEnv) == "" {
		return errors.New("configured upstream credential environment variable is empty")
	}
	return nil
}

type Client struct {
	config        Config
	remote, local *http.Client
	mu            sync.RWMutex
	lease         lease
	pollTimeout   time.Duration // zero uses the production 35-second poll limit
}

func New(config Config) (*Client, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.CAFile != "" {
		pem, e := os.ReadFile(config.CAFile)
		if e != nil {
			return nil, errors.New("CA file unavailable")
		}
		roots, e := x509.SystemCertPool()
		if e != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid CA file")
		}
		tlsConfig.RootCAs = roots
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{config: config, remote: &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true, ResponseHeaderTimeout: 35 * time.Second, IdleConnTimeout: 60 * time.Second}, CheckRedirect: noRedirect},
		local: &http.Client{Transport: &http.Transport{Proxy: nil, TLSClientConfig: tlsConfig.Clone(), ForceAttemptHTTP2: true, ResponseHeaderTimeout: time.Duration(config.UpstreamTimeoutSeconds) * time.Second}, CheckRedirect: noRedirect}}, nil
}
func (c *Client) remoteJSON(ctx context.Context, path, token string, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, _ := json.Marshal(body)
	r, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.config.ControlURL, "/")+path, bytes.NewReader(raw))
	r.Header.Set("authorization", "Bearer "+token)
	r.Header.Set("content-type", "application/json")
	res, e := c.remote.Do(r)
	if e != nil {
		return errRemote
	}
	defer res.Body.Close()
	if path == "/api/connector/lease" && (res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden) {
		return ErrAuthorizationRejected
	}
	if res.StatusCode != 200 {
		return errRemote
	}
	if decodeBoundedJSON(res.Body, 16384, out) != nil {
		return errRemote
	}
	return nil
}
func (c *Client) Pair(ctx context.Context, token string) (Identity, error) {
	var identity Identity
	if err := c.remoteJSON(ctx, "/api/connector/pair", strings.TrimSpace(token), nil, &identity); err != nil {
		return Identity{}, err
	}
	const prefix = "nxidentity_"
	suffix := strings.TrimPrefix(identity.Credential, prefix)
	secret, err := base64.RawURLEncoding.Strict().DecodeString(suffix)
	if strings.TrimSpace(identity.ConnectorID) == "" || strings.TrimSpace(identity.ConnectionID) == "" || strings.TrimSpace(identity.TenantID) == "" ||
		!strings.HasPrefix(identity.Credential, prefix) || len(suffix) != 43 || err != nil || len(secret) != 32 {
		return Identity{}, errRemote
	}
	identity.ControlURL = c.config.ControlURL
	return identity, nil
}
func (c *Client) request(ctx context.Context, method, path, token string, body io.Reader) (*http.Response, error) {
	r, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.config.GatewayURL, "/")+path, body)
	if e != nil {
		return nil, errRemote
	}
	r.Header.Set("authorization", "Bearer "+token)
	r.Header.Set("content-type", "application/x-ndjson")
	return c.remote.Do(r)
}
func (c *Client) currentLease() lease { c.mu.RLock(); defer c.mu.RUnlock(); return c.lease }
func (c *Client) readyModels(ctx context.Context) []string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ready, _ := c.discoverModels(ctx)
	return ready
}
func (c *Client) renew(ctx context.Context, identity Identity, enforceLease bool) error {
	current := c.currentLease()
	if enforceLease {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, current.ExpiresAt)
		defer cancel()
	}
	var next lease
	if err := c.remoteJSON(ctx, "/api/connector/lease", identity.Credential, map[string]any{"leaseToken": current.Token, "readyModels": c.readyModels(ctx)}, &next); err != nil {
		return err
	}
	if next.Token == "" || !time.Now().Before(next.ExpiresAt) {
		return errRemote
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// A late response cannot revive a runtime whose previously known lease expired.
	if enforceLease && !time.Now().Before(c.lease.ExpiresAt) {
		return ErrLeaseExpired
	}
	if ctx.Err() != nil {
		return errRemote
	}
	if !time.Now().Before(next.ExpiresAt) {
		return errRemote
	}
	c.lease = next
	return nil
}
func (c *Client) localAuth(r *http.Request) {
	if c.config.APIKeyEnv != "" {
		r.Header.Set("authorization", "Bearer "+os.Getenv(c.config.APIKeyEnv))
	}
}
func (c *Client) execute(parent context.Context, token string, j job) {
	if !c.validJob(j) {
		return
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(c.config.UpstreamTimeoutSeconds)*time.Second)
	defer cancel()
	if !j.Deadline.IsZero() {
		var deadlineCancel context.CancelFunc
		ctx, deadlineCancel = context.WithDeadline(ctx, j.Deadline)
		defer deadlineCancel()
	}
	watcherDone := make(chan struct{})
	defer func() {
		cancel()
		<-watcherDone
	}()
	go func() {
		defer close(watcherDone)
		for ctx.Err() == nil {
			started := time.Now()
			res, e := c.request(ctx, "GET", "/connector/cancel/"+j.ID, token, nil)
			if e != nil {
				cancel()
				return
			}
			res.Body.Close()
			if res.StatusCode != 202 {
				cancel()
				return
			}
			// Successful cancellation long polls normally take 20 seconds.
			// A fast 202 must not cause a busy loop; failures still cancel once.
			if !pause(ctx, max(0, retryBase-time.Since(started))) {
				return
			}
		}
	}()
	r, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.config.UpstreamURL, "/")+"/chat/completions", bytes.NewReader(j.Body))
	r.Header.Set("content-type", "application/json")
	c.localAuth(r)
	upstream, err := c.local.Do(r)
	status := http.StatusGatewayTimeout
	if err == nil {
		defer upstream.Body.Close()
		status = upstream.StatusCode
	}
	var retryAfterMS int64
	if err == nil && (status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable) {
		retryAfterMS = localRetryAfterMillis(upstream.Header, time.Now())
	}
	// Upload uses the parent context so a local timeout can still report a sanitized failure.
	uploadCtx, uploadCancel := context.WithTimeout(parent, 10*time.Minute)
	defer uploadCancel()
	pr, pw := io.Pipe()
	defer pr.Close()
	produced := make(chan struct{})
	go func() {
		defer close(produced)
		defer pw.Close()
		encoder := json.NewEncoder(pw)
		if err != nil {
			code := "unavailable"
			if errors.Is(err, context.DeadlineExceeded) {
				code = "timeout"
			}
			_ = encoder.Encode(frame{Type: "error", Code: code})
			return
		}
		if encoder.Encode(frame{Type: "meta", Status: status, RetryAfterMS: retryAfterMS}) != nil {
			return
		}
		if status != 200 {
			_ = encoder.Encode(frame{Type: "data", Data: []byte(`{"error":{"message":"Local upstream request failed"}}`)})
			_ = encoder.Encode(frame{Type: "end"})
			return
		}
		reader := bufio.NewReader(upstream.Body)
		buffer := make([]byte, 16<<10)
		for {
			n, e := reader.Read(buffer)
			if n > 0 {
				if encoder.Encode(frame{Type: "data", Data: buffer[:n]}) != nil {
					return
				}
			}
			if e != nil {
				if e == io.EOF {
					_ = encoder.Encode(frame{Type: "end"})
				} else {
					code := ""
					if errors.Is(e, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
						code = "timeout"
					}
					_ = encoder.Encode(frame{Type: "error", Code: code})
				}
				return
			}
		}
	}()
	result, e := c.request(uploadCtx, "POST", "/connector/result/"+j.ID, token, pr)
	if e == nil {
		// The acknowledgment body is unused; draining it can retain a completed worker.
		result.Body.Close()
	}
	cancel()
	pr.Close()
	<-produced
}

func validJobID(id string) bool {
	if len(id) != 36 || !strings.HasPrefix(id, "req_") {
		return false
	}
	for _, c := range id[4:] {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
