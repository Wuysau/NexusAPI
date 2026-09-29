package main

// Narrow reverse transport: connectors pull chat jobs and upload framed SSE.
// Only in-memory request bodies cross this boundary; control-plane calls carry metadata.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"nexus/gateway/internal/retryafter"
)

var errConnectorUnavailable = errors.New("connector unavailable")

type connectorGrant struct {
	LeaseID      string    `json:"leaseId"`
	ConnectorID  string    `json:"connectorId"`
	ConnectionID string    `json:"connectionId"`
	TenantID     string    `json:"tenantId"`
	ExpiresAt    time.Time `json:"expiresAt"`
	Models       []string  `json:"models"`
}
type connectorAuth struct {
	LeaseToken      string   `json:"leaseToken"`
	TenantID        string   `json:"tenantId,omitempty"`
	ConnectionID    string   `json:"connectionId,omitempty"`
	ChannelID       string   `json:"channelId,omitempty"`
	ProjectID       string   `json:"projectId,omitempty"`
	OrganizationID  string   `json:"organizationId,omitempty"`
	KeyID           string   `json:"keyId,omitempty"`
	Model           string   `json:"model,omitempty"`
	RequestedModels []string `json:"requestedModels,omitempty"`
	Scope           string   `json:"scope,omitempty"`
	Transport       bool     `json:"transport,omitempty"`
}
type connectorSession struct {
	token   string
	grant   connectorGrant
	queue   chan *connectorJob
	seen    time.Time
	polling int
}
type connectorJob struct {
	ID       string          `json:"id"`
	Model    string          `json:"model"`
	Body     json.RawMessage `json:"body"`
	Deadline time.Time       `json:"deadline"`
	session  *connectorSession
	ctx      context.Context
	cancel   context.CancelFunc
	reader   *io.PipeReader
	writer   *io.PipeWriter
	response chan *http.Response
	failure  chan error
	claimed  bool
}
type connectorFrame struct {
	Type         string `json:"type"`
	Status       int    `json:"status,omitempty"`
	Data         []byte `json:"data,omitempty"`
	Code         string `json:"code,omitempty"`
	RetryAfterMS int64  `json:"retry_after_ms,omitempty"`
}
type ConnectorHub struct {
	mu             sync.Mutex
	sessions       map[string]*connectorSession
	jobs           map[string]*connectorJob
	baseURL, token string
	client         *http.Client
}

func NewConnectorHub(baseURL, token string) *ConnectorHub {
	return &ConnectorHub{sessions: map[string]*connectorSession{}, jobs: map[string]*connectorJob{}, baseURL: strings.TrimRight(baseURL, "/"), token: token,
		client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (h *ConnectorHub) authorize(ctx context.Context, input connectorAuth) (*connectorGrant, error) {
	raw, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", h.baseURL+"/api/internal/gateway/connector", bytes.NewReader(raw))
	if err != nil {
		return nil, errConnectorUnavailable
	}
	req.Header.Set("authorization", "Bearer "+h.token)
	req.Header.Set("content-type", "application/json")
	res, err := h.client.Do(req)
	if err != nil {
		return nil, errConnectorUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errConnectorUnavailable
	}
	var grant connectorGrant
	response, err := io.ReadAll(io.LimitReader(res.Body, 16385))
	if err != nil || len(response) > 16384 || json.Unmarshal(response, &grant) != nil || grant.ConnectionID == "" || !time.Now().Before(grant.ExpiresAt) {
		return nil, errConnectorUnavailable
	}
	return &grant, nil
}
func (h *ConnectorHub) session(channel *SnapshotChannel) *connectorSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[channel.ConnectionID]
	if s == nil || s.grant.TenantID != channel.TenantID || time.Now().After(s.grant.ExpiresAt) || (s.polling == 0 && time.Since(s.seen) > 3*time.Second) {
		return nil
	}
	copy := *s
	return &copy
}
func connectorInput(s *connectorSession, c *SnapshotChannel, identity *Identity, model, scope string) connectorAuth {
	return connectorAuth{LeaseToken: s.token, TenantID: identity.TenantID, ConnectionID: c.ConnectionID, ChannelID: c.ID, ProjectID: identity.ProjectID, OrganizationID: identity.OrganizationID, KeyID: identity.KeyID, Model: model, Scope: scope}
}
func (h *ConnectorHub) Available(ctx context.Context, c *SnapshotChannel, identity *Identity, model, scope string) bool {
	if h == nil {
		return false
	}
	s := h.session(c)
	if s == nil {
		return false
	}
	_, err := h.authorize(ctx, connectorInput(s, c, identity, model, scope))
	return err == nil
}
func (h *ConnectorHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("cache-control", "no-store")
	token := bearerToken(r)
	if len(token) > 160 || !strings.HasPrefix(token, "nxlease_") {
		http.Error(w, "connector unauthorized", 401)
		return
	}
	grant, err := h.authorize(r.Context(), connectorAuth{LeaseToken: token, Transport: r.URL.Path == "/connector/poll"})
	if err != nil {
		http.Error(w, "connector unauthorized", 401)
		return
	}
	if r.Method == "POST" && r.URL.Path == "/connector/poll" {
		h.poll(w, r, token, *grant)
		return
	}
	id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	h.mu.Lock()
	job := h.jobs[id]
	valid := job != nil && job.session.token == token && job.session.grant.ConnectionID == grant.ConnectionID && job.session.grant.TenantID == grant.TenantID
	if valid && strings.HasPrefix(r.URL.Path, "/connector/result/") {
		if job.claimed {
			valid = false
		} else {
			job.claimed = true
		}
	}
	h.mu.Unlock()
	if !valid {
		http.Error(w, "request unavailable", 404)
		return
	}
	if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/connector/cancel/") {
		// Full local capacity can pause job polls. The authenticated cancellation
		// watch is also live transport evidence while long generations are running.
		if _, err := h.authorize(r.Context(), connectorAuth{LeaseToken: token, Transport: true}); err != nil {
			http.Error(w, "connector unauthorized", 401)
			return
		}
		select {
		case <-job.ctx.Done():
			w.WriteHeader(204)
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
			w.WriteHeader(202)
		}
		return
	}
	if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/connector/result/") {
		h.result(w, r, job)
		return
	}
	http.NotFound(w, r)
}
func (h *ConnectorHub) poll(w http.ResponseWriter, r *http.Request, token string, grant connectorGrant) {
	h.mu.Lock()
	for id, s := range h.sessions {
		if time.Now().After(s.grant.ExpiresAt) && s.polling == 0 {
			delete(h.sessions, id)
		}
	}
	s := h.sessions[grant.ConnectionID]
	if s == nil || s.token != token {
		s = &connectorSession{token: token, grant: grant, queue: make(chan *connectorJob)}
		h.sessions[grant.ConnectionID] = s
	}
	s.grant = grant
	s.seen = time.Now()
	s.polling++
	h.mu.Unlock()
	defer func() { h.mu.Lock(); s.polling--; s.seen = time.Now(); h.mu.Unlock() }()
	deadline := time.NewTimer(min(25*time.Second, time.Until(grant.ExpiresAt)))
	defer deadline.Stop()
	select {
	case job := <-s.queue:
		if job.ctx.Err() != nil {
			w.WriteHeader(204)
			return
		}
		w.Header().Set("content-type", "application/json")
		if json.NewEncoder(w).Encode(job) != nil {
			job.cancel()
		}
	case <-r.Context().Done():
	case <-deadline.C:
		w.WriteHeader(204)
	}
}
func (h *ConnectorHub) result(w http.ResponseWriter, r *http.Request, job *connectorJob) {
	// A result upload lasts as long as generation; override the server's short
	// ordinary-request body deadline with the bounded inference deadline.
	if err := http.NewResponseController(w).SetReadDeadline(job.Deadline); err != nil {
		job.cancel()
		http.Error(w, "streaming transport unavailable", 503)
		return
	}
	// Bound each frame and the total upload. Pipe writes carry backpressure to the local upstream.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	scanner := bufio.NewScanner(r.Body)
	scanner.Buffer(make([]byte, 32<<10), 128<<10)
	defer job.writer.CloseWithError(io.ErrUnexpectedEOF)
	complete := false
	defer func() {
		if !complete {
			job.cancel()
		}
	}()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-job.ctx.Done():
			_ = r.Body.Close()
			_ = job.writer.CloseWithError(job.ctx.Err())
		case <-finished:
		}
	}()
	meta := false
	for scanner.Scan() {
		var frame connectorFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			break
		}
		switch frame.Type {
		case "meta":
			if meta || frame.Status < 200 || frame.Status > 599 {
				http.Error(w, "invalid response", 400)
				return
			}
			meta = true
			response := &http.Response{StatusCode: frame.Status, Header: make(http.Header), Body: job.reader}
			response.Header.Set("content-type", "text/event-stream")
			if frame.RetryAfterMS > 0 && (frame.Status == http.StatusTooManyRequests || frame.Status == http.StatusServiceUnavailable) {
				// Clamp before any conversion. Only a numeric hint reaches the
				// existing adapter; arbitrary local headers never cross the hub.
				milliseconds := min(frame.RetryAfterMS, int64(retryafter.MaxDelay/time.Millisecond))
				response.Header.Set("retry-after-ms", strconv.FormatInt(milliseconds, 10))
			}
			select {
			case job.response <- response:
			case <-job.ctx.Done():
				return
			}
		case "data":
			if !meta || len(frame.Data) > 32<<10 {
				return
			}
			if _, err := job.writer.Write(frame.Data); err != nil {
				return
			}
		case "end":
			if !meta {
				return
			}
			_ = job.writer.Close()
			complete = true
			w.WriteHeader(204)
			return
		case "error":
			err := errConnectorUnavailable
			if frame.Code == "timeout" {
				err = context.DeadlineExceeded
			}
			select {
			case job.failure <- err:
			default:
			}
			_ = job.writer.CloseWithError(err)
			return
		default:
			return
		}
	}
	http.Error(w, "incomplete response", 502)
}

type connectorTransport struct {
	hub      *ConnectorHub
	channel  *SnapshotChannel
	identity *Identity
	model    string
}

func (t connectorTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method != "POST" || r.URL.String() != "https://connector.invalid/v1/chat/completions" {
		return nil, errConnectorUnavailable
	}
	s := t.hub.session(t.channel)
	if s == nil {
		return nil, errConnectorUnavailable
	}
	if _, err := t.hub.authorize(r.Context(), connectorInput(s, t.channel, t.identity, t.model, ScopeChatWrite)); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (2<<20)+1))
	if err != nil || len(body) > 2<<20 {
		return nil, errConnectorUnavailable
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	deadline, _ := ctx.Deadline()
	pr, pw := io.Pipe()
	job := &connectorJob{ID: newRandomID(), Model: t.model, Body: body, Deadline: deadline, session: s, ctx: ctx, cancel: cancel, reader: pr, writer: pw, response: make(chan *http.Response, 1), failure: make(chan error, 1)}
	t.hub.mu.Lock()
	if len(t.hub.jobs) >= 1024 {
		t.hub.mu.Unlock()
		cancel()
		return nil, errConnectorUnavailable
	}
	t.hub.jobs[job.ID] = job
	t.hub.mu.Unlock()
	go func() {
		<-ctx.Done()
		// Closing the writer wakes both pipe ends while preserving an earlier
		// terminal cause. Closing the reader here would mask that cause with
		// ErrClosedPipe before the response consumer has observed it.
		_ = pw.CloseWithError(ctx.Err())
		t.hub.mu.Lock()
		delete(t.hub.jobs, job.ID)
		t.hub.mu.Unlock()
	}()
	select {
	case s.queue <- job:
	case <-ctx.Done():
		cancel()
		return nil, ctx.Err()
	case <-time.After(3 * time.Second):
		cancel()
		return nil, errConnectorUnavailable
	}
	select {
	case res := <-job.response:
		res.Body = &connectorBody{ReadCloser: res.Body, cancel: cancel}
		return res, nil
	case err := <-job.failure:
		cancel()
		return nil, err
	case <-ctx.Done():
		cancel()
		select {
		case err := <-job.failure:
			return nil, err
		default:
		}
		return nil, ctx.Err()
	}
}

type connectorBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *connectorBody) Close() error { b.cancel(); return b.ReadCloser.Close() }
