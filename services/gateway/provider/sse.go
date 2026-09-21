package provider

// Server-Sent Events reader.
//
// The gateway parses SSE itself rather than delegating to a library because the
// failure modes are the point: chunks arrive split at arbitrary byte offsets,
// events may span several `data:` lines, line endings may be LF or CRLF, and a
// stream may be cut mid-event. bufio.Reader buffers across reads, so a split
// inside a line, a field name or a multi-byte UTF-8 rune is handled without any
// special casing — the fragmentation tests drive this reader one byte at a time
// to prove it.

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// maxSSEEventBytes bounds a single event so a hostile upstream cannot exhaust
// gateway memory. Events are token-sized; 1 MiB is already far beyond normal.
const maxSSEEventBytes = 1 << 20

// SSEReader reads an SSE byte stream one event at a time.
type SSEReader struct {
	r *bufio.Reader
	// pendingEOF defers the EOF of a final unterminated line by one call so the
	// line is delivered before the stream ends.
	pendingEOF bool
}

func NewSSEReader(r io.Reader) *SSEReader {
	return &SSEReader{r: bufio.NewReaderSize(r, 32*1024)}
}

// SSEEvent is one dispatched event. Event is the `event:` field (default
// "message"); Data is the joined `data:` payload; ID is the `id:` field.
type SSEEvent struct {
	Event string
	Data  []byte
	ID    string
}

// Next returns the next event, or io.EOF at a clean end of stream. A stream
// that ends between events is a clean EOF; a partial trailing event is
// discarded, matching the SSE specification.
func (s *SSEReader) Next() (SSEEvent, error) {
	var (
		event   SSEEvent
		data    bytes.Buffer
		hasData bool
		size    int
	)
	for {
		line, err := s.readLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Per the SSE specification, a stream that ends without the
				// blank-line dispatch discards the pending event. Every real
				// provider terminates its last event, and dispatching a
				// truncated JSON body would turn a clean disconnect into a
				// protocol error.
				return SSEEvent{}, io.EOF
			}
			return SSEEvent{}, err
		}
		if len(line) == 0 {
			// Blank line dispatches the event, if it carried any data.
			if hasData {
				event.Data = data.Bytes()
				return event, nil
			}
			event = SSEEvent{}
			continue
		}
		if line[0] == ':' {
			continue // comment / keep-alive
		}
		field, value := splitField(line)
		size += len(line)
		if size > maxSSEEventBytes {
			return SSEEvent{}, errors.New("provider: sse event exceeds size limit")
		}
		switch field {
		case "event":
			event.Event = string(value)
		case "id":
			event.ID = string(value)
		case "data":
			if hasData {
				data.WriteByte('\n')
			}
			data.Write(value)
			hasData = true
		default:
			// retry and unknown fields are ignored per spec.
		}
	}
}

// readLine reads a single line, stripping a trailing CR. The returned slice is
// owned by the caller (bufio reuses its buffer on the next call, and event data
// may be returned directly).
func (s *SSEReader) readLine() ([]byte, error) {
	if s.pendingEOF {
		return nil, io.EOF
	}
	line, err := s.r.ReadBytes('\n')
	if err != nil {
		if !errors.Is(err, io.EOF) {
			return nil, err
		}
		s.pendingEOF = true
		if len(line) == 0 {
			return nil, io.EOF
		}
		// Fall through: deliver the final unterminated line, then EOF next call.
	}
	line = bytes.TrimSuffix(line, []byte("\n"))
	line = bytes.TrimSuffix(line, []byte("\r"))
	out := make([]byte, len(line))
	copy(out, line)
	return out, nil
}

// splitField splits "field: value" per the SSE grammar. A line without a colon
// is a field with an empty value.
func splitField(line []byte) (string, []byte) {
	idx := bytes.IndexByte(line, ':')
	if idx < 0 {
		return string(line), nil
	}
	field := string(line[:idx])
	value := line[idx+1:]
	// A single leading space after the colon is part of the framing.
	if len(value) > 0 && value[0] == ' ' {
		value = value[1:]
	}
	return field, value
}
