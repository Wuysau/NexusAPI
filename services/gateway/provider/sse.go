package provider

// Server-Sent Events reader.
//
// The gateway parses SSE itself rather than delegating to a library because the
// failure modes are the point: chunks arrive split at arbitrary byte offsets,
// events may span several `data:` lines, line endings may be CR, LF or CRLF, and a
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
	// A CR completes its line immediately. One following LF belongs to that
	// delimiter, even if it arrives in a later read or Next call.
	skipLF bool
	// A blank-line CR reserves its possible LF before dispatch. That LF must
	// not consume the next event's wire-byte budget.
	skipLFOutsideEvent bool
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
		line, consumed, err := s.readLine(maxSSEEventBytes - size)
		size += consumed
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
			if s.skipLF {
				// Do not wait for lookahead. Reserve the possible LF before
				// dispatch so a later byte cannot exceed this block's limit.
				if size == maxSSEEventBytes {
					return SSEEvent{}, errors.New("provider: sse event exceeds size limit")
				}
				s.skipLFOutsideEvent = true
			}
			// Blank line dispatches the event, if it carried any data.
			if hasData {
				event.Data = data.Bytes()
				return event, nil
			}
			event = SSEEvent{}
			size = 0
			continue
		}
		if line[0] == ':' {
			continue // comment / keep-alive
		}
		field, value := splitField(line)
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

// readLine reads a single CR-, LF- or CRLF-terminated line. The returned slice is
// owned by the caller (bufio reuses its buffer on the next call, and event data
// may be returned directly).
func (s *SSEReader) readLine(remaining int) ([]byte, int, error) {
	if s.pendingEOF {
		return nil, 0, io.EOF
	}
	var line []byte
	consumed := 0
	for {
		if s.r.Buffered() == 0 {
			if _, err := s.r.Peek(1); err != nil {
				if !errors.Is(err, io.EOF) {
					return nil, consumed, err
				}
				s.pendingEOF = true
				if len(line) == 0 {
					return nil, consumed, io.EOF
				}
				return line, consumed, nil
			}
		}
		// Peek only bytes already buffered. Finding a CR never waits for the
		// network to supply a possible following LF.
		fragment, _ := s.r.Peek(s.r.Buffered())
		if s.skipLF {
			s.skipLF = false
			outsideEvent := s.skipLFOutsideEvent
			s.skipLFOutsideEvent = false
			if fragment[0] == '\n' {
				if !outsideEvent {
					if consumed >= remaining {
						return nil, consumed, errors.New("provider: sse event exceeds size limit")
					}
					consumed++
				}
				_, _ = s.r.Discard(1)
				continue
			}
		}
		end := bytes.IndexByte(fragment, '\n')
		if cr := bytes.IndexByte(fragment, '\r'); cr >= 0 && (end < 0 || cr < end) {
			end = cr
		}
		n := len(fragment)
		if end >= 0 {
			n = end + 1
		}
		// Check the raw wire budget before copying a bounded fragment.
		// Comments, unknown fields and both CRLF bytes count toward it.
		if n > remaining-consumed {
			return nil, consumed, errors.New("provider: sse event exceeds size limit")
		}
		consumed += n
		if end >= 0 {
			s.skipLF = fragment[end] == '\r'
			line = append(line, fragment[:end]...)
			_, _ = s.r.Discard(n)
			return line, consumed, nil
		}
		line = append(line, fragment...)
		_, _ = s.r.Discard(n)
	}
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
