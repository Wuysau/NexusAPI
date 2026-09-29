package provider

import (
	"encoding/json"
	"fmt"
)

// anthropicTools translates the canonical Chat Completions tool contract.
func anthropicTools(tools, choice json.RawMessage) (json.RawMessage, json.RawMessage, error) {
	if !missingOrNull(tools) {
		var definitions []struct {
			Type     string `json:"type"`
			Function struct {
				Name        string          `json:"name"`
				Description string          `json:"description,omitempty"`
				Parameters  json.RawMessage `json:"parameters"`
				Strict      *bool           `json:"strict,omitempty"`
			} `json:"function"`
		}
		if err := json.Unmarshal(tools, &definitions); err != nil {
			return nil, nil, &UnsupportedParameterError{Param: "tools"}
		}
		converted := make([]map[string]any, 0, len(definitions))
		for _, tool := range definitions {
			if tool.Type != "function" || tool.Function.Name == "" {
				return nil, nil, &UnsupportedParameterError{Param: "tools"}
			}
			parameters := tool.Function.Parameters
			if missingOrNull(parameters) {
				parameters = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			definition := map[string]any{"name": tool.Function.Name, "input_schema": parameters}
			if tool.Function.Description != "" {
				definition["description"] = tool.Function.Description
			}
			if tool.Function.Strict != nil {
				definition["strict"] = *tool.Function.Strict
			}
			converted = append(converted, definition)
		}
		tools, _ = json.Marshal(converted)
	}
	if !missingOrNull(choice) {
		var name string
		var converted map[string]string
		if json.Unmarshal(choice, &name) == nil {
			switch name {
			case "auto", "none":
				converted = map[string]string{"type": name}
			case "required":
				converted = map[string]string{"type": "any"}
			default:
				return nil, nil, &UnsupportedParameterError{Param: "tool_choice"}
			}
		} else {
			var function struct {
				Type     string `json:"type"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			}
			if err := json.Unmarshal(choice, &function); err != nil || function.Type != "function" || function.Function.Name == "" {
				return nil, nil, &UnsupportedParameterError{Param: "tool_choice"}
			}
			converted = map[string]string{"type": "tool", "name": function.Function.Name}
		}
		choice, _ = json.Marshal(converted)
	}
	return tools, choice, nil
}

func anthropicMessageContent(msg Message) (json.RawMessage, error) {
	content, err := anthropicImageContent(msg.Content)
	if err != nil {
		return nil, err
	}
	if msg.Role == "tool" {
		if msg.ToolCallID == "" {
			return nil, fmt.Errorf("anthropic: tool result missing call id")
		}
		if missingOrNull(content) {
			content = json.RawMessage(`""`)
		}
		return json.Marshal([]any{map[string]any{"type": "tool_result", "tool_use_id": msg.ToolCallID, "content": content}})
	}
	if missingOrNull(msg.ToolCalls) {
		return content, nil
	}
	if msg.Role != "assistant" {
		return nil, fmt.Errorf("anthropic: tool calls require assistant role")
	}
	var calls []struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	if err := json.Unmarshal(msg.ToolCalls, &calls); err != nil {
		return nil, fmt.Errorf("anthropic: invalid tool calls")
	}
	var blocks []json.RawMessage
	if !missingOrNull(content) {
		var text string
		if json.Unmarshal(content, &text) == nil {
			if text != "" {
				block, _ := json.Marshal(map[string]string{"type": "text", "text": text})
				blocks = append(blocks, block)
			}
		} else if err := json.Unmarshal(content, &blocks); err != nil {
			return nil, fmt.Errorf("anthropic: invalid assistant content")
		}
	}
	for _, call := range calls {
		var input map[string]json.RawMessage
		if call.Type != "function" || call.ID == "" || call.Function.Name == "" || json.Unmarshal([]byte(call.Function.Arguments), &input) != nil || input == nil {
			return nil, fmt.Errorf("anthropic: invalid tool call arguments")
		}
		block, err := json.Marshal(map[string]any{"type": "tool_use", "id": call.ID, "name": call.Function.Name, "input": input})
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	return json.Marshal(blocks)
}
