package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"nexus/gateway/provider"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type relayFixtureStream struct {
	chunks   []provider.CanonicalChunk
	terminal error
}

func (s *relayFixtureStream) Next() (provider.CanonicalChunk, error) {
	if len(s.chunks) == 0 {
		if s.terminal != nil {
			return provider.CanonicalChunk{}, s.terminal
		}
		return provider.CanonicalChunk{}, io.EOF
	}
	c := s.chunks[0]
	s.chunks = s.chunks[1:]
	return c, nil
}
func (s *relayFixtureStream) Close() error { return nil }

func TestRelayPreservesNonStreamToolsAndReasoning(t *testing.T) {
	stream := &relayFixtureStream{chunks: []provider.CanonicalChunk{
		{Reasoning: "consider"},
		{ToolCallDelta: json.RawMessage(`[{"index":0,"id":"call_fixture","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]`)},
		{ToolCallDelta: json.RawMessage(`[{"index":0,"function":{"arguments":"\"Paris\"}"}}]`)},
		{FinishReason: "tool_calls"}, {Done: true},
	}}
	p := &Proxy{now: time.Now}
	_, body, err := p.relay(context.Background(), httptest.NewRecorder(), stream, "test", "test", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Choices []struct {
			Message struct {
				Reasoning string `json:"reasoning_content"`
				ToolCalls []struct {
					ID       string
					Function struct {
						Name      string
						Arguments string
					}
				} `json:"tool_calls"`
			}
		}
	}
	if err = json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	m := result.Choices[0].Message
	if m.Reasoning != "consider" || len(m.ToolCalls) != 1 || m.ToolCalls[0].Function.Arguments != `{"city":"Paris"}` || m.ToolCalls[0].Function.Name != "weather" {
		t.Fatalf("lost semantic output: %s", body)
	}
}

func TestRelayEOFRequiresTerminal(t *testing.T) {
	p := &Proxy{now: time.Now}
	w := httptest.NewRecorder()
	_, _, err := p.relay(context.Background(), w, &relayFixtureStream{chunks: []provider.CanonicalChunk{{Text: "partial"}}}, "test", "test", true, nil)
	if err == nil || strings.Contains(w.Body.String(), "[DONE]") {
		t.Fatal("unterminated stream reported successful")
	}
}

func TestRelayRejectsMalformedToolDelta(t *testing.T) {
	p := &Proxy{now: time.Now}
	w := httptest.NewRecorder()
	_, _, err := p.relay(context.Background(), w, &relayFixtureStream{chunks: []provider.CanonicalChunk{{ToolCallDelta: json.RawMessage(`{"arguments":`)}, {Done: true}}}, "test", "test", true, nil)
	if err == nil {
		t.Fatal("invalid tool delta silently discarded")
	}
}

func TestRelayKeepsUsageOnError(t *testing.T) {
	// Provider adapters can return the last observed counters together with a read failure.
	p := &Proxy{now: time.Now}
	observed := &provider.CanonicalUsage{OutputTokens: 3}
	stream := &relayErrorUsage{usage: observed}
	usage, _, err := p.relay(context.Background(), httptest.NewRecorder(), stream, "test", "test", true, nil)
	if err == nil || usage != observed {
		t.Fatal("lost observed usage on error")
	}
}

type relayErrorUsage struct{ usage *provider.CanonicalUsage }

func (s *relayErrorUsage) Next() (provider.CanonicalChunk, error) {
	return provider.CanonicalChunk{Usage: s.usage}, errors.New("fixture read failed")
}
func (s *relayErrorUsage) Close() error { return nil }

func TestStreamingDoneRequiresDurableTerminal(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.store.FailNext()
	body := readAll(h.doChat(chatBody(chatBodyOptions{Stream: true}), nil))
	if strings.Contains(body, "[DONE]") || !strings.Contains(body, CodeStorageUnavailable) {
		t.Fatalf("false stream success after storage failure: %s", body)
	}
}

func TestRelayAggregationBoundOnlyAppliesToBufferedOutput(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		p := &Proxy{now: time.Now, limits: Limits{MaxResponseBytes: 8}}
		stream := &relayFixtureStream{chunks: []provider.CanonicalChunk{{Text: "0123456789"}, {Done: true}}}
		_, _, err := p.relay(context.Background(), httptest.NewRecorder(), stream, "m", "r", streaming, nil)
		if streaming && err != nil {
			t.Fatal(err)
		}
		if !streaming && err == nil {
			t.Fatal("unbounded buffered output accepted")
		}
	}
}

type blockingRelayStream struct {
	done   chan struct{}
	exited chan struct{}
	once   sync.Once
}

func (s *blockingRelayStream) Next() (provider.CanonicalChunk, error) {
	<-s.done
	close(s.exited)
	return provider.CanonicalChunk{}, io.EOF
}
func (s *blockingRelayStream) Close() error { s.once.Do(func() { close(s.done) }); return nil }
func TestRelayIdleClosesBlockedReader(t *testing.T) {
	s := &blockingRelayStream{done: make(chan struct{}), exited: make(chan struct{})}
	p := &Proxy{now: time.Now, limits: Limits{IdleTimeout: 10 * time.Millisecond}}
	_, _, err := p.relay(context.Background(), httptest.NewRecorder(), s, "m", "r", false, nil)
	if !errors.Is(err, errUpstreamIdle) {
		t.Fatal(err)
	}
	select {
	case <-s.exited:
	case <-time.After(time.Second):
		t.Fatal("reader leaked")
	}
}

func TestTransportFailureAfterDispatchDoesNotRetry(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}, ExtraChannelsFn: func(url string) []SnapshotChannel {
		return []SnapshotChannel{{ID: "chan_second", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", CredentialMode: "managed", CredentialRef: "cred_test", Weight: 5, Capabilities: []string{"text", "streaming"}, Enabled: true}}
	}})
	_ = readAll(h.doChat(chatBody(chatBodyOptions{}), nil))
	if calls.Load() != 1 {
		t.Fatalf("ambiguous accepted request replayed %d times", calls.Load())
	}
	records := h.store.Requests()
	if len(records) != 1 || records[0].Status != string(OutcomeUnknown) {
		t.Fatal("ambiguous dispatch lost unknown terminal")
	}
	if len(records[0].Attempts) != 1 || records[0].Attempts[0].Status != string(OutcomeUnknown) {
		t.Fatal("ambiguous dispatch attempt conflicts with terminal status")
	}
}

func TestSuccessfulFailoverClearsPriorStreamError(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{MaxAttempts: 2, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(status)
					return
				}
				defaultUpstreamHandler()(w, r)
			}, ExtraChannelsFn: func(url string) []SnapshotChannel {
				return []SnapshotChannel{{ID: "chan_second", ProviderID: "prov_openai", Provider: "openai", BaseURL: url, AuthScheme: "bearer", Models: []string{testModel}, Region: "global", CredentialMode: "managed", CredentialRef: "cred_test", Weight: 5, Capabilities: []string{"text", "streaming"}, Enabled: true}}
			}})
			body := readAll(h.doChat(chatBody(chatBodyOptions{Stream: true}), nil))
			if !strings.Contains(body, "[DONE]") || strings.Contains(body, `"error":`) {
				t.Fatalf("successful fallback retained failure: %s", body)
			}
			records := h.store.Requests()
			if len(records) != 1 || records[0].Status != string(OutcomeCompleted) || records[0].ErrorCode != "" {
				t.Fatalf("successful fallback retained terminal error: %+v", records)
			}
		})
	}
}

func TestChatUsagePreservesUnknownCounters(t *testing.T) {
	output := int64(4)
	raw, err := json.Marshal(chatUsage(&provider.CanonicalUsage{Observed: &provider.ObservedUsage{OutputTokens: &output}}))
	if err != nil {
		t.Fatal(err)
	}
	var u map[string]any
	_ = json.Unmarshal(raw, &u)
	if u["prompt_tokens"] != nil || u["total_tokens"] != nil || u["completion_tokens"] != float64(4) {
		t.Fatalf("invented usage: %s", raw)
	}
}

type repeatRelayStream struct{ remaining int }

func (s *repeatRelayStream) Next() (provider.CanonicalChunk, error) {
	if s.remaining == 0 {
		return provider.CanonicalChunk{Done: true}, nil
	}
	s.remaining--
	return provider.CanonicalChunk{Text: "token"}, nil
}
func (s *repeatRelayStream) Close() error { return nil }

type discardStreamWriter struct {
	header  http.Header
	flushes int
}

func (w *discardStreamWriter) Header() http.Header         { return w.header }
func (w *discardStreamWriter) WriteHeader(int)             {}
func (w *discardStreamWriter) Write(b []byte) (int, error) { return len(b), nil }
func (w *discardStreamWriter) Flush()                      { w.flushes++ }
func TestRelayCoalescesSmallFrames(t *testing.T) {
	p := &Proxy{now: time.Now}
	w := &discardStreamWriter{header: make(http.Header)}
	_, _, err := p.relay(context.Background(), w, &repeatRelayStream{remaining: 200}, "m", "r", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if w.flushes >= 100 {
		t.Fatalf("tiny frames still flushed individually: %d", w.flushes)
	}
}
func BenchmarkRelayStreaming(b *testing.B) {
	p := &Proxy{now: time.Now, limits: Limits{IdleTimeout: time.Minute}}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := &discardStreamWriter{header: make(http.Header)}
		_, _, err := p.relay(context.Background(), w, &repeatRelayStream{remaining: 1000}, "m", "r", true, nil)
		if err != nil {
			b.Fatal(err)
		}
	}
}
