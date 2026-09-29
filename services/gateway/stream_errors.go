package main

import (
	"encoding/json"
	"net/http"
)

type downstreamWriteError struct{ err error }

func (e *downstreamWriteError) Error() string { return e.err.Error() }
func (e *downstreamWriteError) Unwrap() error { return e.err }

func (p *Proxy) writeStreamError(w http.ResponseWriter, requestID string, e *APIError) {
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"code": e.Code, "type": e.Type, "message": e.Message, "param": e.Param, "request_id": requestID}})
	_ = p.writeFinalSSE(w, append(append([]byte("data: "), body...), '\n', '\n'))
}
