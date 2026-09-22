package main

// Responses is a stateless wire adapter over the same authenticated execution
// path as Chat Completions. It never creates its own reservation or ledger.
import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"nexus/gateway/provider"
)

type responsesRequest struct {
	Model           string          `json:"model"`
	Input           json.RawMessage `json:"input"`
	Instructions    string          `json:"instructions"`
	Stream          bool            `json:"stream"`
	MaxOutputTokens *int            `json:"max_output_tokens"`
	Temperature     *float64        `json:"temperature"`
	TopP            *float64        `json:"top_p"`
	Tools           json.RawMessage `json:"tools"`
	ToolChoice      json.RawMessage `json:"tool_choice"`
	Store           bool            `json:"store"`
	Background      bool            `json:"background"`
}

func errUnsupportedParam(param string) *APIError {
	return &APIError{Status: http.StatusBadRequest, Code: CodeUnsupportedParam, Type: TypeInvalidRequest, Message: "Unsupported parameter.", Param: &param}
}

func (p *Proxy) ServeResponses(w http.ResponseWriter, r *http.Request) {
	requestID := ensureRequestID(r)
	body, apiErr := readBounded(r, p.limits.MaxBodyBytes)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}
	req, chat, apiErr := parseResponsesRequest(body)
	if apiErr != nil {
		writeAPIError(w, requestID, apiErr)
		return
	}
	encoded, err := json.Marshal(chat)
	if err != nil {
		writeAPIError(w, requestID, errInvalidJSON())
		return
	}
	forward := r.Clone(r.Context())
	forward.Header = r.Header.Clone()
	forward.Header.Set("x-request-id", requestID)
	forward.Body = io.NopCloser(bytes.NewReader(encoded))
	forward.ContentLength = int64(len(encoded))
	limit := p.limits.MaxResponseBytes
	if limit <= 0 {
		limit = defaultMaxResponseBytes
	}
	mapper := &responsesWriter{w: w, header: make(http.Header), request: req, id: "resp_" + requestID, created: p.now().Unix(), maxBytes: limit, textIndex: -1, tools: make(map[int]int)}
	p.ServeChatCompletions(mapper, forward)
	mapper.finish()
}

func parseResponsesRequest(body []byte) (*responsesRequest, map[string]any, *APIError) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, nil, errInvalidJSON()
	}
	allowed := map[string]bool{"model": true, "input": true, "instructions": true, "stream": true, "max_output_tokens": true, "temperature": true, "top_p": true, "tools": true, "tool_choice": true, "store": true, "background": true}
	for key := range fields {
		if !allowed[key] {
			return nil, nil, errUnsupportedParam(key)
		}
	}
	var req responsesRequest
	if json.Unmarshal(body, &req) != nil {
		return nil, nil, errInvalidJSON()
	}
	if req.Store {
		return nil, nil, errUnsupportedParam("store")
	}
	if req.Background {
		return nil, nil, errUnsupportedParam("background")
	}
	messages, apiErr := responsesInput(req.Input)
	if apiErr != nil {
		return nil, nil, apiErr
	}
	if req.Instructions != "" {
		raw, _ := json.Marshal(req.Instructions)
		messages = append([]provider.Message{{Role: "developer", Content: raw}}, messages...)
	}
	chat := map[string]any{"model": req.Model, "messages": messages, "stream": req.Stream}
	if req.MaxOutputTokens != nil {
		chat["max_completion_tokens"] = req.MaxOutputTokens
	}
	if req.Temperature != nil {
		chat["temperature"] = req.Temperature
	}
	if req.TopP != nil {
		chat["top_p"] = req.TopP
	}
	if len(req.Tools) > 0 && string(req.Tools) != "null" {
		var tools []map[string]json.RawMessage
		if json.Unmarshal(req.Tools, &tools) != nil {
			return nil, nil, errInvalidParam("tools", "Invalid function tools.")
		}
		out := make([]map[string]any, 0, len(tools))
		for _, tool := range tools {
			var kind, name string
			if json.Unmarshal(tool["type"], &kind) != nil || kind != "function" || json.Unmarshal(tool["name"], &name) != nil || name == "" {
				return nil, nil, errUnsupportedParam("tools")
			}
			fn := map[string]json.RawMessage{}
			for k, v := range tool {
				switch k {
				case "type":
				case "name", "description", "parameters", "strict":
					fn[k] = v
				default:
					return nil, nil, errUnsupportedParam("tools." + k)
				}
			}
			out = append(out, map[string]any{"type": "function", "function": fn})
		}
		chat["tools"] = out
	}
	if len(req.ToolChoice) > 0 && string(req.ToolChoice) != "null" {
		var choice string
		if json.Unmarshal(req.ToolChoice, &choice) == nil {
			if choice != "auto" && choice != "none" && choice != "required" {
				return nil, nil, errInvalidParam("tool_choice", "Unsupported tool choice.")
			}
			chat["tool_choice"] = choice
		} else {
			var choice struct{ Type, Name string }
			if json.Unmarshal(req.ToolChoice, &choice) != nil || choice.Type != "function" || choice.Name == "" {
				return nil, nil, errUnsupportedParam("tool_choice")
			}
			chat["tool_choice"] = map[string]any{"type": "function", "function": map[string]string{"name": choice.Name}}
		}
	}
	return &req, chat, nil
}

func responsesInput(raw json.RawMessage) ([]provider.Message, *APIError) {
	var text string
	if json.Unmarshal(raw, &text) == nil && string(raw) != "null" {
		return []provider.Message{{Role: "user", Content: raw}}, nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return nil, errInvalidParam("input", "Input must be text or a nonempty item array.")
	}
	messages := make([]provider.Message, 0, len(items))
	for _, rawItem := range items {
		var item struct {
			Type      string          `json:"type"`
			Role      string          `json:"role"`
			CallID    string          `json:"call_id"`
			Name      string          `json:"name"`
			Arguments string          `json:"arguments"`
			Content   json.RawMessage `json:"content"`
			Output    json.RawMessage `json:"output"`
		}
		if json.Unmarshal(rawItem, &item) != nil {
			return nil, errInvalidParam("input", "Invalid input item.")
		}
		switch item.Type {
		case "", "message":
			switch item.Role {
			case "user", "assistant", "system", "developer":
			default:
				return nil, errInvalidParam("input", "Unsupported message role.")
			}
			content, apiErr := responsesTextContent(item.Content, item.Role == "assistant")
			if apiErr != nil {
				return nil, apiErr
			}
			messages = append(messages, provider.Message{Role: item.Role, Content: content})
		case "function_call":
			if item.CallID == "" || item.Name == "" || !json.Valid([]byte(item.Arguments)) {
				return nil, errInvalidParam("input", "Invalid function call.")
			}
			calls, _ := json.Marshal([]any{map[string]any{"id": item.CallID, "type": "function", "function": map[string]string{"name": item.Name, "arguments": item.Arguments}}})
			if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
				last := &messages[len(messages)-1]
				var existing []json.RawMessage
				_ = json.Unmarshal(last.ToolCalls, &existing)
				var additional []json.RawMessage
				_ = json.Unmarshal(calls, &additional)
				existing = append(existing, additional...)
				last.ToolCalls, _ = json.Marshal(existing)
			} else {
				messages = append(messages, provider.Message{Role: "assistant", ToolCalls: calls})
			}
		case "function_call_output":
			if item.CallID == "" {
				return nil, errInvalidParam("input", "Function output requires call_id.")
			}
			content, apiErr := responsesTextContent(item.Output, false)
			if apiErr != nil {
				return nil, apiErr
			}
			messages = append(messages, provider.Message{Role: "tool", ToolCallID: item.CallID, Content: content})
		default:
			return nil, errUnsupportedParam("input")
		}
	}
	return messages, nil
}

func responsesTextContent(raw json.RawMessage, allowOutput bool) (json.RawMessage, *APIError) {
	var text string
	if json.Unmarshal(raw, &text) == nil && string(raw) != "null" {
		return raw, nil
	}
	var parts []struct{ Type, Text string }
	if json.Unmarshal(raw, &parts) != nil || string(raw) == "null" {
		return nil, errInvalidParam("input", "Message content must be text.")
	}
	var content strings.Builder
	for _, part := range parts {
		if part.Type != "input_text" && (!allowOutput || part.Type != "output_text") {
			return nil, errUnsupportedParam("input.content")
		}
		content.WriteString(part.Text)
	}
	encoded, _ := json.Marshal(content.String())
	return encoded, nil
}

type responsesItem struct {
	kind, id, callID, name string
	text                   strings.Builder
	announced              bool
}

func (i *responsesItem) value(status string) map[string]any {
	if i.kind == "function_call" {
		return map[string]any{"type": "function_call", "id": i.id, "call_id": i.callID, "name": i.name, "arguments": i.text.String(), "status": status}
	}
	return map[string]any{"type": "message", "id": i.id, "role": "assistant", "status": status, "content": []any{responsesTextPart(i.text.String())}}
}
func responsesTextPart(text string) map[string]any {
	return map[string]any{"type": "output_text", "text": text, "annotations": []any{}, "logprobs": []any{}}
}

type responsesWriter struct {
	w                                           http.ResponseWriter
	header                                      http.Header
	request                                     *responsesRequest
	id                                          string
	created                                     int64
	status, maxBytes, used, sequence, textIndex int
	buffer                                      []byte
	items                                       []*responsesItem
	tools                                       map[int]int
	usage                                       any
	finishReason                                string
	started, done, failed                       bool
	writeErr                                    error
	validationChecked                           bool
	validationErr                               error
	validatedJSON                               []byte
	validatedEvents                             []responsesEvent
}

type responsesEvent struct {
	kind   string
	fields map[string]any
}

func (w *responsesWriter) Header() http.Header         { return w.header }
func (w *responsesWriter) Unwrap() http.ResponseWriter { return w.w }
func (w *responsesWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *responsesWriter) Flush() { _ = w.FlushError() }
func (w *responsesWriter) FlushError() error {
	if !w.started {
		return nil
	}
	return http.NewResponseController(w.w).Flush()
}
func (w *responsesWriter) copyHeaders() {
	for key, values := range w.header {
		w.w.Header()[key] = append([]string(nil), values...)
	}
	w.w.Header().Del("Content-Length")
}

func (w *responsesWriter) Write(p []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if len(p) > w.maxBytes-len(w.buffer) {
		w.writeErr = fmt.Errorf("responses: response exceeds size limit")
		return 0, w.writeErr
	}
	w.buffer = append(w.buffer, p...)
	if !w.request.Stream || w.status >= 400 {
		return len(p), nil
	}
	for {
		end := bytes.Index(w.buffer, []byte("\n\n"))
		if end < 0 {
			break
		}
		frame := w.buffer[:end]
		w.buffer = w.buffer[end+2:]
		var payload []byte
		for _, line := range bytes.Split(frame, []byte("\n")) {
			if bytes.HasPrefix(line, []byte("data:")) {
				if len(payload) > 0 {
					payload = append(payload, '\n')
				}
				payload = append(payload, bytes.TrimSpace(line[5:])...)
			}
		}
		if len(payload) == 0 {
			continue
		}
		if err := w.consume(payload); err != nil {
			w.writeErr = err
			return 0, err
		}
	}
	return len(p), nil
}

func (w *responsesWriter) response(status string) map[string]any {
	output := make([]any, 0, len(w.items))
	for _, item := range w.items {
		output = append(output, item.value(status))
	}
	var incomplete any
	if status == "incomplete" {
		reason := "max_output_tokens"
		if w.finishReason == "content_filter" {
			reason = "content_filter"
		}
		incomplete = map[string]string{"reason": reason}
	}
	var tools any = []any{}
	if len(w.request.Tools) > 0 && string(w.request.Tools) != "null" {
		tools = w.request.Tools
	}
	var choice any = "auto"
	if len(w.request.ToolChoice) > 0 && string(w.request.ToolChoice) != "null" {
		choice = w.request.ToolChoice
	}
	return map[string]any{"id": w.id, "object": "response", "created_at": w.created, "status": status, "model": w.request.Model, "output": output, "usage": w.usage, "error": nil, "incomplete_details": incomplete, "store": false, "background": false, "parallel_tool_calls": true, "tools": tools, "tool_choice": choice}
}

func (w *responsesWriter) event(kind string, fields map[string]any) error {
	fields["type"] = kind
	fields["response_id"] = w.id
	fields["sequence_number"] = w.sequence
	raw, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	if len(raw) > w.maxBytes {
		return fmt.Errorf("responses: event exceeds size limit")
	}
	if !w.started {
		w.copyHeaders()
		w.w.Header().Set("Content-Type", "text/event-stream")
		w.w.WriteHeader(http.StatusOK)
		w.started = true
	}
	_, err = fmt.Fprintf(w.w, "event: %s\ndata: %s\n\n", kind, raw)
	if err == nil {
		w.sequence++
	}
	return err
}

func (w *responsesWriter) start() error {
	if w.started {
		return nil
	}
	if err := w.event("response.created", map[string]any{"response": w.response("in_progress")}); err != nil {
		return err
	}
	return w.event("response.in_progress", map[string]any{"response": w.response("in_progress")})
}

func (w *responsesWriter) addBytes(n int) error {
	if n > w.maxBytes-w.used {
		return fmt.Errorf("responses: output exceeds size limit")
	}
	w.used += n
	return nil
}

func (w *responsesWriter) textDelta(text string, stream bool) error {
	if text == "" {
		return nil
	}
	if err := w.addBytes(responsesStringSize(text)); err != nil {
		return err
	}
	// Keep item ordering when a fragmented tool identity precedes new text.
	if len(w.tools) > 0 && (w.textIndex < 0 || !w.items[w.textIndex].announced) {
		stream = false
	}
	if w.textIndex < 0 {
		if err := w.addBytes(256); err != nil {
			return err
		}
		w.textIndex = len(w.items)
		item := &responsesItem{kind: "message", id: fmt.Sprintf("msg_%s_%d", w.id, w.textIndex)}
		w.items = append(w.items, item)
		if stream {
			added := item.value("in_progress")
			added["content"] = []any{}
			if err := w.event("response.output_item.added", map[string]any{"output_index": w.textIndex, "item": added}); err != nil {
				return err
			}
			if err := w.event("response.content_part.added", map[string]any{"item_id": item.id, "output_index": w.textIndex, "content_index": 0, "part": responsesTextPart("")}); err != nil {
				return err
			}
			item.announced = true
		}
	}
	item := w.items[w.textIndex]
	item.text.WriteString(text)
	if stream {
		return w.event("response.output_text.delta", map[string]any{"item_id": item.id, "output_index": w.textIndex, "content_index": 0, "delta": text, "logprobs": []any{}})
	}
	return nil
}

// Tool metadata has no separate end marker in Chat Completions. Buffer calls
// until termination so output_item.added carries complete IDs and names.
func (w *responsesWriter) toolDelta(raw json.RawMessage, stream bool) error {
	var calls []struct {
		Index    *int   `json:"index"`
		ID       string `json:"id"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &calls) != nil {
		return fmt.Errorf("responses: invalid tool delta")
	}
	for position, call := range calls {
		index := position
		if call.Index != nil {
			index = *call.Index
		}
		if index < 0 {
			return fmt.Errorf("responses: invalid tool index")
		}
		if err := w.addBytes(responsesStringSize(call.ID) + responsesStringSize(call.Function.Name) + responsesStringSize(call.Function.Arguments)); err != nil {
			return err
		}
		outIndex, exists := w.tools[index]
		if !exists {
			if err := w.addBytes(256); err != nil {
				return err
			}
			outIndex = len(w.items)
			w.tools[index] = outIndex
			item := &responsesItem{kind: "function_call", id: fmt.Sprintf("fc_%s_%d", w.id, outIndex)}
			w.items = append(w.items, item)
		}
		item := w.items[outIndex]
		item.callID += call.ID
		item.name += call.Function.Name
		item.text.WriteString(call.Function.Arguments)
	}
	return nil
}

func responsesUsage(raw json.RawMessage) any {
	var usage map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &usage) != nil || usage == nil {
		return nil
	}
	var inputDetails, outputDetails map[string]json.RawMessage
	_ = json.Unmarshal(usage["prompt_tokens_details"], &inputDetails)
	_ = json.Unmarshal(usage["completion_tokens_details"], &outputDetails)
	return map[string]any{"input_tokens": usage["prompt_tokens"], "output_tokens": usage["completion_tokens"], "total_tokens": usage["total_tokens"], "input_tokens_details": map[string]any{"cached_tokens": inputDetails["cached_tokens"]}, "output_tokens_details": map[string]any{"reasoning_tokens": outputDetails["reasoning_tokens"]}}
}

// Budget escaped JSON bytes, not only decoded text: control characters can
// expand sixfold in the final output object.
func responsesStringSize(value string) int { raw, _ := json.Marshal(value); return len(raw) - 2 }

func (w *responsesWriter) consume(payload []byte) error {
	if err := w.start(); err != nil {
		return err
	}
	if bytes.Equal(payload, []byte("[DONE]")) {
		w.done = true
		return nil
	}
	var chunk struct {
		Error   json.RawMessage `json:"error"`
		Usage   json.RawMessage `json:"usage"`
		Choices []struct {
			Delta struct {
				Content   string          `json:"content"`
				ToolCalls json.RawMessage `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return fmt.Errorf("responses: invalid internal stream")
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		w.failed = true
		return nil
	}
	if len(chunk.Usage) > 0 {
		w.usage = responsesUsage(chunk.Usage)
	}
	for _, choice := range chunk.Choices {
		if err := w.textDelta(choice.Delta.Content, true); err != nil {
			return err
		}
		if len(choice.Delta.ToolCalls) > 0 && string(choice.Delta.ToolCalls) != "null" {
			if err := w.toolDelta(choice.Delta.ToolCalls, true); err != nil {
				return err
			}
		}
		if choice.FinishReason != "" {
			w.finishReason = choice.FinishReason
		}
	}
	return nil
}

func (w *responsesWriter) finalStatus() string {
	if w.finishReason == "length" || w.finishReason == "content_filter" {
		return "incomplete"
	}
	return "completed"
}

// ValidateCompletion runs while the upstream attempt is still pending, before
// the shared execution path records success or persists a completed request.
// DONE is intentionally not required: it is released only after persistence.
func (w *responsesWriter) ValidateCompletion(body []byte) error {
	if w.validationChecked {
		return w.validationErr
	}
	w.validationChecked = true
	w.validationErr = w.prepareCompletion(body)
	return w.validationErr
}

func (w *responsesWriter) prepareCompletion(body []byte) error {
	if w.writeErr != nil {
		return w.writeErr
	}
	if w.failed {
		return fmt.Errorf("responses: failed internal stream")
	}
	if w.request.Stream {
		if len(bytes.TrimSpace(w.buffer)) > 0 {
			return fmt.Errorf("responses: incomplete internal frame")
		}
	} else {
		if len(body) > w.maxBytes {
			return fmt.Errorf("responses: completion exceeds size limit")
		}
		var completion struct {
			Choices []struct {
				Message struct {
					Content   string          `json:"content"`
					ToolCalls json.RawMessage `json:"tool_calls"`
				} `json:"message"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(body, &completion) != nil || len(completion.Choices) != 1 {
			return fmt.Errorf("responses: invalid completion")
		}
		choice := completion.Choices[0]
		w.finishReason = choice.FinishReason
		w.usage = responsesUsage(completion.Usage)
		if err := w.textDelta(choice.Message.Content, false); err != nil {
			return err
		}
		if len(choice.Message.ToolCalls) > 0 && string(choice.Message.ToolCalls) != "null" {
			if err := w.toolDelta(choice.Message.ToolCalls, false); err != nil {
				return err
			}
		}
	}
	for _, item := range w.items {
		if item.kind == "function_call" && (item.callID == "" || item.name == "") {
			return fmt.Errorf("responses: incomplete function identity")
		}
	}
	final, err := json.Marshal(w.response(w.finalStatus()))
	if err != nil {
		return err
	}
	if len(final) > w.maxBytes {
		return fmt.Errorf("responses: final object exceeds size limit")
	}
	w.validatedJSON = final
	if !w.request.Stream {
		return nil
	}
	events := w.completionEvents(final)
	// Check the actual terminal event envelopes, including sequence/id overhead.
	// Rendering uses these same events, so a later serialization-size error
	// cannot contradict the durable outcome after the transaction commits.
	for index, event := range events {
		event.fields["type"] = event.kind
		event.fields["response_id"] = w.id
		event.fields["sequence_number"] = w.sequence + index
		encoded, err := json.Marshal(event.fields)
		if err != nil {
			return err
		}
		if len(encoded) > w.maxBytes {
			return fmt.Errorf("responses: final event exceeds size limit")
		}
	}
	w.validatedEvents = events
	return nil
}

func (w *responsesWriter) completionEvents(final []byte) []responsesEvent {
	var events []responsesEvent
	add := func(kind string, fields map[string]any) {
		events = append(events, responsesEvent{kind: kind, fields: fields})
	}
	for index, item := range w.items {
		if !item.announced {
			added := item.value("in_progress")
			if item.kind == "function_call" {
				added["arguments"] = ""
			} else {
				added["content"] = []any{}
			}
			add("response.output_item.added", map[string]any{"output_index": index, "item": added})
			if item.kind == "function_call" {
				add("response.function_call_arguments.delta", map[string]any{"item_id": item.id, "output_index": index, "delta": item.text.String()})
			} else {
				add("response.content_part.added", map[string]any{"item_id": item.id, "output_index": index, "content_index": 0, "part": responsesTextPart("")})
				add("response.output_text.delta", map[string]any{"item_id": item.id, "output_index": index, "content_index": 0, "delta": item.text.String(), "logprobs": []any{}})
			}
		}
		if item.kind == "function_call" {
			add("response.function_call_arguments.done", map[string]any{"item_id": item.id, "output_index": index, "arguments": item.text.String(), "name": item.name})
		} else {
			add("response.output_text.done", map[string]any{"item_id": item.id, "output_index": index, "content_index": 0, "text": item.text.String(), "logprobs": []any{}})
			add("response.content_part.done", map[string]any{"item_id": item.id, "output_index": index, "content_index": 0, "part": responsesTextPart(item.text.String())})
		}
		add("response.output_item.done", map[string]any{"output_index": index, "item": item.value(w.finalStatus())})
	}
	add("response."+w.finalStatus(), map[string]any{"response": json.RawMessage(final)})
	return events
}

func (w *responsesWriter) finish() {
	if w.status >= 400 {
		w.copyHeaders()
		w.w.WriteHeader(w.status)
		_, _ = w.w.Write(w.buffer)
		return
	}
	if !w.request.Stream {
		w.finishJSON()
		return
	}
	if w.writeErr != nil || w.failed || !w.done || w.ValidateCompletion(nil) != nil {
		w.failStream()
		return
	}
	for _, event := range w.validatedEvents {
		if w.event(event.kind, event.fields) != nil {
			w.failStream()
			return
		}
	}
	_ = w.FlushError()
}

func (w *responsesWriter) failStream() {
	// Deltas already delivered remain visible, but do not duplicate a possibly
	// oversized partial object in the failure event.
	response := map[string]any{"id": w.id, "object": "response", "created_at": w.created, "model": w.request.Model, "status": "failed", "output": []any{}, "usage": w.usage, "incomplete_details": nil, "error": map[string]string{"code": "server_error", "message": "The response did not complete successfully."}}
	_ = w.event("response.failed", map[string]any{"response": response})
	_ = w.FlushError()
}

func (w *responsesWriter) finishJSON() {
	if w.ValidateCompletion(w.buffer) != nil {
		writeAPIError(w.w, w.id, errUpstreamProtocol())
		return
	}
	w.copyHeaders()
	w.w.Header().Set("Content-Type", "application/json")
	w.w.WriteHeader(http.StatusOK)
	_, _ = w.w.Write(w.validatedJSON)
}
