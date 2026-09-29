package provider

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"strings"
)

// anthropicImageContent translates only canonical image_url blocks. Existing
// text and native Anthropic blocks retain their fields and ordering. It is pure:
// URL sources are forwarded to the provider, never fetched by the gateway.
func anthropicImageContent(raw json.RawMessage) (json.RawMessage, error) {
	value := bytes.TrimSpace(raw)
	if len(value) == 0 || value[0] != '[' {
		return raw, nil
	}
	var blocks []json.RawMessage
	if json.Unmarshal(value, &blocks) != nil {
		return nil, &UnsupportedParameterError{Param: "messages"}
	}
	changed := false
	for i, block := range blocks {
		var fields map[string]json.RawMessage
		if json.Unmarshal(block, &fields) != nil {
			continue
		}
		var kind string
		if json.Unmarshal(fields["type"], &kind) != nil || kind != "image_url" {
			continue
		}
		converted, err := anthropicImageBlock(fields)
		if err != nil {
			return nil, err
		}
		blocks[i] = converted
		changed = true
	}
	if !changed {
		return raw, nil
	}
	return json.Marshal(blocks)
}

type anthropicImageSource struct {
	Type      string `json:"type"`
	URL       string `json:"url,omitempty"`
	MediaType string `json:"media_type,omitempty"`
	Data      string `json:"data,omitempty"`
}

func anthropicImageBlock(fields map[string]json.RawMessage) (json.RawMessage, error) {
	unsupported := &UnsupportedParameterError{Param: "messages"}
	for field := range fields {
		if field != "type" && field != "image_url" {
			return nil, unsupported
		}
	}
	var image map[string]json.RawMessage
	if json.Unmarshal(fields["image_url"], &image) != nil || image == nil {
		return nil, unsupported
	}
	for field := range image {
		if field != "url" && field != "detail" {
			return nil, unsupported
		}
	}
	if !missingOrNull(image["detail"]) {
		var detail string
		if json.Unmarshal(image["detail"], &detail) != nil || detail != "auto" {
			return nil, unsupported
		}
	}
	var imageURL *string
	if json.Unmarshal(image["url"], &imageURL) != nil || imageURL == nil {
		return nil, unsupported
	}
	source, ok := anthropicImageSourceForURL(*imageURL)
	if !ok {
		return nil, unsupported
	}
	return json.Marshal(struct {
		Type   string               `json:"type"`
		Source anthropicImageSource `json:"source"`
	}{Type: "image", Source: source})
}

func anthropicImageSourceForURL(value string) (anthropicImageSource, bool) {
	if strings.HasPrefix(value, "data:") {
		header, data, found := strings.Cut(value, ",")
		if !found || data == "" || strings.ContainsAny(data, "\r\n") {
			return anthropicImageSource{}, false
		}
		switch header {
		case "data:image/jpeg;base64", "data:image/png;base64", "data:image/gif;base64", "data:image/webp;base64":
		default:
			return anthropicImageSource{}, false
		}
		// Validate the encoding without retaining decoded image bytes or trying
		// to interpret the image. The incoming request already bounds its size.
		decoded, err := io.Copy(io.Discard, base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(data)))
		if err != nil || decoded == 0 {
			return anthropicImageSource{}, false
		}
		mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		return anthropicImageSource{Type: "base64", MediaType: mediaType, Data: data}, true
	}
	parsed, err := url.Parse(value)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" || strings.ContainsAny(value, " \\\t\r\n") {
		return anthropicImageSource{}, false
	}
	return anthropicImageSource{Type: "url", URL: value}, true
}
