package main

import "nexus/gateway/provider"

// Validation and dispatch share the same canonical values. The upstream always
// streams internally so buffered and streaming clients have one accounting path.
func canonicalChatRequest(req *chatRequest, model *SnapshotModel) *provider.CanonicalRequest {
	return &provider.CanonicalRequest{
		Model:               model.ID,
		Messages:            req.Messages,
		MaxTokens:           effectiveMaxTokens(req, model),
		MaxCompletionTokens: req.MaxCompletionTokens,
		Temperature:         req.Temperature,
		TopP:                req.TopP,
		Stop:                req.stopSequences,
		Tools:               req.Tools,
		ToolChoice:          req.ToolChoice,
		ResponseFormat:      req.ResponseFormat,
		Stream:              true,
		User:                req.User,
	}
}
