package provider

import (
	"bytes"
	"encoding/json"
	"errors"
)

// UnsupportedParameterError identifies a request field this adapter cannot
// preserve. Param is a fixed field name, never request content or a value.
type UnsupportedParameterError struct {
	Param string
}

func (e *UnsupportedParameterError) Error() string { return "unsupported request parameter" }

var errNilRequest = errors.New("provider: nil request")

// OpenAI-compatible endpoints receive these fields unchanged. Model names do
// not establish which optional fields a compatible implementation supports.
func (a *OpenAICompatible) ValidateRequest(req *CanonicalRequest) error {
	if req == nil {
		return errNilRequest
	}
	return nil
}

func (a *Anthropic) ValidateRequest(req *CanonicalRequest) error {
	if req == nil {
		return errNilRequest
	}
	for _, message := range req.Messages {
		if message.ReasoningContent != nil || message.Refusal != nil {
			return &UnsupportedParameterError{Param: "messages"}
		}
		if message.Role == "system" || message.Role == "developer" {
			if !textOnlyContent(message.Content) {
				return &UnsupportedParameterError{Param: "messages"}
			}
		} else if _, err := anthropicImageContent(message.Content); err != nil {
			return err
		}
	}
	if !textOnlyResponseFormat(req.ResponseFormat) {
		return &UnsupportedParameterError{Param: "response_format"}
	}
	return nil
}

func (g *Gemini) ValidateRequest(req *CanonicalRequest) error {
	if req == nil {
		return errNilRequest
	}
	if !emptyJSONList(req.Tools) {
		return &UnsupportedParameterError{Param: "tools"}
	}
	if !missingOrNull(req.ToolChoice) {
		var choice string
		if json.Unmarshal(req.ToolChoice, &choice) != nil || (choice != "auto" && choice != "none") {
			return &UnsupportedParameterError{Param: "tool_choice"}
		}
	}
	if !textOnlyResponseFormat(req.ResponseFormat) {
		return &UnsupportedParameterError{Param: "response_format"}
	}
	for _, message := range req.Messages {
		if message.ReasoningContent != nil || message.Refusal != nil || message.Role == "tool" || message.ToolCallID != "" || !emptyJSONList(message.ToolCalls) || !textOnlyContent(message.Content) {
			return &UnsupportedParameterError{Param: "messages"}
		}
	}
	return nil
}

func missingOrNull(raw json.RawMessage) bool {
	value := bytes.TrimSpace(raw)
	return len(value) == 0 || bytes.Equal(value, []byte("null"))
}

func emptyJSONList(raw json.RawMessage) bool {
	if missingOrNull(raw) {
		return true
	}
	var values []json.RawMessage
	return json.Unmarshal(raw, &values) == nil && len(values) == 0
}

// A text format has no additional constraints only when its sole field is
// type=text. Unknown fields could carry constraints that would be discarded.
func textOnlyResponseFormat(raw json.RawMessage) bool {
	if missingOrNull(raw) {
		return true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 1 {
		return false
	}
	var kind string
	return json.Unmarshal(fields["type"], &kind) == nil && kind == "text"
}

// Match the plain-text forms contentAsText can preserve. A typed non-text
// part, an extra field or malformed text cannot be reduced to an empty string.
func textOnlyContent(raw json.RawMessage) bool {
	if missingOrNull(raw) {
		return true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return true
	}
	var parts []map[string]json.RawMessage
	if json.Unmarshal(raw, &parts) != nil {
		return false
	}
	for _, part := range parts {
		var value *string
		if json.Unmarshal(part["text"], &value) != nil || value == nil {
			return false
		}
		for field := range part {
			switch field {
			case "text":
			case "type":
				var kind *string
				if json.Unmarshal(part[field], &kind) != nil || kind == nil || (*kind != "" && *kind != "text") {
					return false
				}
			default:
				return false
			}
		}
	}
	return true
}
