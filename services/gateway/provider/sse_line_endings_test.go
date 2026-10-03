package provider

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

func TestSSELineEndings(t *testing.T) {
	for _, ending := range []string{"\n", "\r", "\r\n"} {
		t.Run(fmt.Sprintf("ending=%q", ending), func(t *testing.T) {
			body := ": comment" + ending + "ignored: x" + ending + "event: delta" + ending + "id: abc" + ending + "data: 你" + ending + "data: 好" + ending + ending + "data: tail" + ending + ending
			r := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
			event, err := r.Next()
			if err != nil || event.Event != "delta" || event.ID != "abc" || string(event.Data) != "你\n好" {
				t.Fatalf("first event=%+v err=%v", event, err)
			}
			event, err = r.Next()
			if err != nil || string(event.Data) != "tail" {
				t.Fatalf("second event=%+v err=%v", event, err)
			}
			if _, err = r.Next(); err != io.EOF {
				t.Fatalf("want EOF, got %v", err)
			}
		})
	}
	for _, body := range []string{
		"event: delta\rid: abc\ndata: 你\r\ndata: 好\r\n\rdata: tail\n\n",
		"event: delta\r\nid: abc\r\ndata: 你\r\ndata: 好\r\n\r\ndata: tail\r\r",
	} {
		r := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
		event, err := r.Next()
		if err != nil || event.Event != "delta" || event.ID != "abc" || string(event.Data) != "你\n好" {
			t.Fatalf("mixed event=%+v err=%v", event, err)
		}
		event, err = r.Next()
		if err != nil || string(event.Data) != "tail" {
			t.Fatalf("mixed second event=%+v err=%v", event, err)
		}
	}
}

func TestSSECRLFContinuationDoesNotCreateBlankLine(t *testing.T) {
	// Each CR/LF pair spans separate reader calls. The LF continues the
	// preceding delimiter; only the final second line ending dispatches.
	reader := NewSSEReader(iotest.OneByteReader(strings.NewReader("data: first\r\ndata: second\r\n\r\n")))
	if event, err := reader.Next(); err != nil || string(event.Data) != "first\nsecond" {
		t.Fatalf("split CRLF dispatched early: event=%+v err=%v", event, err)
	}
	if _, err := reader.Next(); err != io.EOF {
		t.Fatalf("split CRLF created an extra event: %v", err)
	}
}

func TestSSEDispatchesCRWithoutLookahead(t *testing.T) {
	pipeReader, pipeWriter := io.Pipe()
	defer func() { _ = pipeReader.Close() }()
	defer func() { _ = pipeWriter.Close() }()
	r := NewSSEReader(pipeReader)
	type result struct {
		event SSEEvent
		err   error
	}
	first := make(chan result, 1)
	go func() { event, err := r.Next(); first <- result{event, err} }()
	if _, err := io.WriteString(pipeWriter, "data: fast\r\r"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-first:
		if got.err != nil || string(got.event.Data) != "fast" {
			t.Fatalf("event=%+v err=%v", got.event, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("CR blank-line dispatch waited for lookahead or EOF")
	}
	second := make(chan result, 1)
	go func() { event, err := r.Next(); second <- result{event, err} }()
	if _, err := io.WriteString(pipeWriter, "\ndata: later\r\r"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-second:
		if got.err != nil || string(got.event.Data) != "later" {
			t.Fatalf("event=%+v err=%v", got.event, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("delayed CRLF continuation blocked the next event")
	}
}

func TestSSEEOFRequiresBlankLine(t *testing.T) {
	for _, body := range []string{"data: x", "data: x\n", "data: x\r", "data: x\r\n"} {
		event, err := NewSSEReader(iotest.OneByteReader(strings.NewReader(body))).Next()
		if err != io.EOF {
			t.Fatalf("unterminated body=%q event=%+v err=%v", body, event, err)
		}
	}
	for _, body := range []string{"data: x\n\n", "data: x\r\r", "data: x\r\n\r", "data: x\r\n\r\n"} {
		r := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
		event, err := r.Next()
		if err != nil || string(event.Data) != "x" {
			t.Fatalf("complete body=%q event=%+v err=%v", body, event, err)
		}
		if _, err := r.Next(); err != io.EOF {
			t.Fatalf("want EOF, got %v", err)
		}
	}
}

type sseInjectedErrorReader struct{ err error }

func (r sseInjectedErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestSSEPreservesUpstreamReadErrors(t *testing.T) {
	sentinel := errors.New("upstream read failed")
	for _, body := range []string{"", "data: x", "data: x\r", "data: x\r\n"} {
		reader := NewSSEReader(io.MultiReader(strings.NewReader(body), sseInjectedErrorReader{sentinel}))
		if event, err := reader.Next(); !errors.Is(err, sentinel) {
			t.Fatalf("body=%q partial event=%+v upstream error=%v", body, event, err)
		}
	}
	reader := NewSSEReader(io.MultiReader(strings.NewReader("data: x\r\r"), sseInjectedErrorReader{sentinel}))
	if event, err := reader.Next(); err != nil || string(event.Data) != "x" {
		t.Fatalf("completed event=%+v err=%v", event, err)
	}
	if _, err := reader.Next(); !errors.Is(err, sentinel) {
		t.Fatalf("error after completed event=%v", err)
	}
}

func sseWireEventOfSize(size int, ending string) string {
	return "data: " + strings.Repeat("x", size-6-2*len(ending)) + ending + ending
}

func TestSSEExactRawWireLimit(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n"} {
		for _, fragmented := range []bool{false, true} {
			t.Run(fmt.Sprintf("ending=%q/onebyte=%t", ending, fragmented), func(t *testing.T) {
				body := sseWireEventOfSize(maxSSEEventBytes, ending)
				var source io.Reader = strings.NewReader(body)
				if fragmented {
					source = iotest.OneByteReader(source)
				}
				r := NewSSEReader(source)
				if event, err := r.Next(); err != nil || len(event.Data) != maxSSEEventBytes-6-2*len(ending) {
					t.Fatalf("exact-limit event data=%d err=%v", len(event.Data), err)
				}
			})
		}
	}
	// A final CR must leave one byte for a possible future LF, so the new
	// CR-only framing accepts max-1 wire bytes without waiting for lookahead.
	if event, err := NewSSEReader(iotest.OneByteReader(strings.NewReader(sseWireEventOfSize(maxSSEEventBytes-1, "\r")))).Next(); err != nil || len(event.Data) != maxSSEEventBytes-9 {
		t.Fatalf("CR-only max-1 wire limit rejected: data=%d err=%v", len(event.Data), err)
	}
	// The LF completing the preceding CR blank line cannot consume the next event's budget.
	for _, first := range []string{"data: a\r\n\r\n", ": comment\r\n\r\n"} {
		body := first + sseWireEventOfSize(maxSSEEventBytes, "\n")
		r := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
		if strings.HasPrefix(first, "data:") {
			if event, err := r.Next(); err != nil || string(event.Data) != "a" {
				t.Fatalf("first event=%+v err=%v", event, err)
			}
		}
		if event, err := r.Next(); err != nil || len(event.Data) != maxSSEEventBytes-8 {
			t.Fatalf("following exact-limit event data=%d err=%v", len(event.Data), err)
		}
	}
	// Reserve at the CR blank-line boundary, rather than once per CR-terminated line.
	comment := ":" + strings.Repeat("x", 1022) + "\r"
	body := strings.Repeat(comment, 1023) + "data: " + strings.Repeat("x", 1014) + "\r\r"
	if len(body) != maxSSEEventBytes-2 {
		t.Fatalf("bad CR-only fixture size %d", len(body))
	}
	if event, err := NewSSEReader(strings.NewReader(body)).Next(); err != nil || len(event.Data) != 1014 {
		t.Fatalf("CR-only wire limit overcharged: data=%d err=%v", len(event.Data), err)
	}
}

func TestSSEOversizedFraming(t *testing.T) {
	for _, ending := range []string{"\n", "\r", "\r\n"} {
		for _, prefix := range []string{"data: ", ":", "unknown: "} {
			body := prefix + strings.Repeat("x", maxSSEEventBytes-len(prefix)) + ending + ending
			if event, err := NewSSEReader(iotest.OneByteReader(strings.NewReader(body))).Next(); err == nil || err == io.EOF {
				t.Fatalf("oversize %q/%q data=%d err=%v", ending, prefix, len(event.Data), err)
			}
		}
	}
	// Ambiguous exact-limit CR ending uses a conservative one-byte reservation.
	for _, suffix := range []string{"", "\n"} {
		if event, err := NewSSEReader(iotest.OneByteReader(strings.NewReader(sseWireEventOfSize(maxSSEEventBytes, "\r") + suffix))).Next(); err == nil || err == io.EOF {
			t.Fatalf("ambiguous boundary data=%d suffix=%q err=%v", len(event.Data), suffix, err)
		}
	}
}

func TestProviderCRCompletionAndTruncation(t *testing.T) {
	for _, tc := range []struct{ kind, partial, terminal string }{
		{"openai", `{"usage":{"prompt_tokens":5}}`, `[DONE]`},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5}}}`, `{"type":"message_stop"}`},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`, `{"candidates":[{"finishReason":"STOP"}]}`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			c, err := testProtocolStream(tc.kind, "data: "+tc.partial+"\r\r").Next()
			if !errors.Is(err, ErrStreamTruncated) || c.Done || c.Usage == nil || c.Usage.InputTokens != 5 {
				t.Fatalf("CR truncation lost usage or became successful: chunk=%+v err=%v", c, err)
			}
			chunks := drain(t, testProtocolStream(tc.kind, "data: "+tc.terminal+"\r\r"))
			if len(chunks) == 0 || !chunks[len(chunks)-1].Done {
				t.Fatal("valid CR terminal failed completion")
			}
			c, err = testProtocolStream(tc.kind, "data: "+tc.terminal+"\r").Next()
			if !errors.Is(err, ErrStreamTruncated) || c.Done {
				t.Fatalf("unterminated CR event became successful: chunk=%+v err=%v", c, err)
			}
		})
	}
}

func BenchmarkSSELineEndings(b *testing.B) {
	for _, ending := range []struct{ name, value string }{
		{"LF", "\n"}, {"CR", "\r"}, {"CRLF", "\r\n"},
	} {
		for _, fixture := range []struct {
			name      string
			wireBytes int
		}{
			{"1KiB", 1024}, {"64KiB", 64 * 1024},
		} {
			b.Run(ending.name+"/"+fixture.name, func(b *testing.B) {
				body := sseWireEventOfSize(fixture.wireBytes, ending.value)
				want := []byte(strings.Repeat("x", fixture.wireBytes-6-2*len(ending.value)))
				b.SetBytes(int64(len(body)))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					event, err := NewSSEReader(strings.NewReader(body)).Next()
					if err != nil || !bytes.Equal(event.Data, want) {
						b.Fatalf("data=%d want=%d err=%v", len(event.Data), len(want), err)
					}
				}
			})
		}
	}
}
