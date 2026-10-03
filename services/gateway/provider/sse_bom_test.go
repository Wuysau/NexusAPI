package provider

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

const sseUTF8BOM = "\xef\xbb\xbf"

func TestSSEIgnoresOneInitialBOM(t *testing.T) {
	for _, tc := range []struct {
		name, body, event, id, data string
	}{
		{"data LF", "data: 你好\n\n", "", "", "你好"},
		{"metadata CR", "event: delta\rid: abc\rdata: hello\r\r", "delta", "abc", "hello"},
		{"comment CRLF", ": keep-alive\r\n" + sseUTF8BOM + "data: ignored\r\ndata: hello\r\n\r\n", "", "", "hello"},
		{"blank CRLF", "\r\n" + sseUTF8BOM + "data: ignored\r\ndata: hello\r\n\r\n", "", "", "hello"},
		{"data CRLF", "data: hello\r\n\r\n", "", "", "hello"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader := NewSSEReader(iotest.OneByteReader(strings.NewReader(sseUTF8BOM + tc.body)))
			event, err := reader.Next()
			if err != nil || event.Event != tc.event || event.ID != tc.id || string(event.Data) != tc.data {
				t.Fatalf("initial BOM changed event=%+v err=%v", event, err)
			}
			if _, err := reader.Next(); err != io.EOF {
				t.Fatalf("initial BOM created an extra event: %v", err)
			}
		})
	}
}

func TestSSEBOMIsOnlyRemovedAtStreamStart(t *testing.T) {
	for _, prefix := range []string{"", sseUTF8BOM} {
		body := prefix + "data: first\n" + sseUTF8BOM + "data: ignored\n\n" +
			sseUTF8BOM + "data: ignored again\ndata: second\n\n"
		reader := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
		for _, want := range []string{"first", "second"} {
			event, err := reader.Next()
			if err != nil || string(event.Data) != want {
				t.Fatalf("prefix=%q later BOM was removed: data=%q want=%q err=%v", prefix, event.Data, want, err)
			}
		}
	}
	// Only one leading marker is ignored. The second marker remains part of
	// the field name, so that field is unknown and cannot become data.
	body := sseUTF8BOM + sseUTF8BOM + "data: ignored\ndata: kept\n\n"
	if event, err := NewSSEReader(iotest.OneByteReader(strings.NewReader(body))).Next(); err != nil || string(event.Data) != "kept" {
		t.Fatalf("repeated BOM was removed: event=%+v err=%v", event, err)
	}
}

func TestSSEPreservesBOMBytesInsidePayload(t *testing.T) {
	want := []byte(sseUTF8BOM + "你" + sseUTF8BOM)
	body := sseUTF8BOM + "data: " + string(want) + "\n\n" + "data: " + string(want) + "\n\n"
	reader := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
	for i := 0; i < 2; i++ {
		event, err := reader.Next()
		if err != nil || !bytes.Equal(event.Data, want) {
			t.Fatalf("event %d payload BOM changed: data=%q err=%v", i, event.Data, err)
		}
	}
}

func TestSSEBOMAndPartialBOMAtEOFAreDiscarded(t *testing.T) {
	for _, body := range []string{
		"\xef", "\xef\xbb", sseUTF8BOM,
		sseUTF8BOM + "data: incomplete", sseUTF8BOM + "data: incomplete\n", sseUTF8BOM + "data: incomplete\r",
	} {
		reader := NewSSEReader(iotest.OneByteReader(strings.NewReader(body)))
		if event, err := reader.Next(); err != io.EOF || len(event.Data) != 0 {
			t.Fatalf("BOM EOF dispatched partial body=%q event=%+v err=%v", body, event, err)
		}
	}
	sentinel := errors.New("upstream read failed during BOM")
	reader := NewSSEReader(io.MultiReader(strings.NewReader("\xef\xbb"), sseInjectedErrorReader{sentinel}))
	if _, err := reader.Next(); !errors.Is(err, sentinel) {
		t.Fatalf("partial BOM hid the upstream read error: %v", err)
	}
}

func TestSSEBOMCountsTowardRawWireLimit(t *testing.T) {
	for _, tc := range []struct {
		name, ending string
		limit        int
	}{
		{"LF", "\n", maxSSEEventBytes},
		{"CRLF", "\r\n", maxSSEEventBytes},
		{"CR reservation", "\r", maxSSEEventBytes - 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := sseUTF8BOM + sseWireEventOfSize(tc.limit-len(sseUTF8BOM), tc.ending)
			event, err := NewSSEReader(strings.NewReader(body)).Next()
			wantBytes := tc.limit - len(sseUTF8BOM) - 6 - 2*len(tc.ending)
			if err != nil || len(event.Data) != wantBytes {
				t.Fatalf("BOM wire boundary rejected: data=%d want=%d err=%v", len(event.Data), wantBytes, err)
			}
			body = sseUTF8BOM + sseWireEventOfSize(tc.limit-len(sseUTF8BOM)+1, tc.ending)
			if _, err := NewSSEReader(strings.NewReader(body)).Next(); err == nil || err == io.EOF {
				t.Fatalf("BOM wire bytes escaped the event limit: %v", err)
			}
		})
	}
	// Removing the BOM must expose the first blank line before block reset.
	// Its three bytes belong to that empty block, rather than the next event.
	body := sseUTF8BOM + "\n" + sseWireEventOfSize(maxSSEEventBytes, "\n")
	if event, err := NewSSEReader(strings.NewReader(body)).Next(); err != nil || len(event.Data) != maxSSEEventBytes-8 {
		t.Fatalf("BOM blank line borrowed the next block's budget: data=%d err=%v", len(event.Data), err)
	}
}

func TestProviderInitialBOMPreservesUsageAndCompletion(t *testing.T) {
	for _, tc := range []struct {
		kind, usage, terminal string
		want                  ObservedUsage
	}{
		{"openai", `{"usage":{"prompt_tokens":5}}`, `[DONE]`, ObservedUsage{InputTokens: observedInt(5)}},
		{"anthropic", `{"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`, `{"type":"message_stop"}`, ObservedUsage{InputTokens: observedInt(5), CachedInputTokens: observedInt(0)}},
		{"gemini", `{"usageMetadata":{"promptTokenCount":5}}`, `{"candidates":[{"finishReason":"STOP"}]}`, ObservedUsage{InputTokens: observedInt(5)}},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			usageEvent := sseUTF8BOM + "data: " + tc.usage + "\n\n"
			terminalEvent := "data: " + tc.terminal + "\n\n"
			stream := testProtocolStream(tc.kind, usageEvent+terminalEvent)
			checkObserved(t, finalObservedUsage(t, stream.Next), tc.want)

			chunk, err := testProtocolStream(tc.kind, usageEvent).Next()
			if !errors.Is(err, ErrStreamTruncated) || chunk.Done {
				t.Fatalf("BOM partial stream became completion: chunk=%+v err=%v", chunk, err)
			}
			checkObserved(t, chunk.Usage, tc.want)

			chunks := drain(t, testProtocolStream(tc.kind, sseUTF8BOM+terminalEvent))
			if len(chunks) == 0 || !chunks[len(chunks)-1].Done {
				t.Fatal("initial BOM prevented a valid protocol terminal")
			}
			chunk, err = testProtocolStream(tc.kind, sseUTF8BOM+"data: "+tc.terminal+"\n").Next()
			if !errors.Is(err, ErrStreamTruncated) || chunk.Done {
				t.Fatalf("BOM unterminated event became completion: chunk=%+v err=%v", chunk, err)
			}
		})
	}
}
