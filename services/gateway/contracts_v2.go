package main

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type usageV2Relation struct {
	Kind   string   `json:"kind"`
	Part   string   `json:"part"`
	Whole  string   `json:"whole"`
	Total  string   `json:"total"`
	Parts  []string `json:"parts"`
	When   string   `json:"when"`
	Equals []any    `json:"equals"`
	Field  string   `json:"field"`
}
type usageV2SchemaNode struct {
	Type                 any                          `json:"type"`
	Const                *float64                     `json:"const"`
	Enum                 []any                        `json:"enum"`
	Properties           map[string]usageV2SchemaNode `json:"properties"`
	Required             []string                     `json:"required"`
	AdditionalProperties *bool                        `json:"additionalProperties"`
	Minimum              *float64                     `json:"minimum"`
	Maximum              *float64                     `json:"maximum"`
	MinLength            *int                         `json:"minLength"`
	MaxLength            *int                         `json:"maxLength"`
	Format               string                       `json:"format"`
	Relations            []usageV2Relation            `json:"x-relations"`
}

var usageV2Schema = func() usageV2SchemaNode {
	var schema usageV2SchemaNode
	if err := json.Unmarshal([]byte(usageEventV2CanonicalSchema), &schema); err != nil {
		panic(err)
	}
	return schema
}()
var usageV2DatePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$`)

func usageV2DateTime(value string) bool {
	match := usageV2DatePattern.FindStringSubmatch(value)
	if match == nil {
		return false
	}
	for i, limit := range map[int]int{2: 23, 3: 59, 4: 59, 5: 23, 6: 59} {
		if match[i] != "" {
			n, _ := strconv.Atoi(match[i])
			if n > limit {
				return false
			}
		}
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}
func usageV2Contains(values []any, value any) bool {
	for _, candidate := range values {
		if reflect.DeepEqual(candidate, value) {
			return true
		}
	}
	return false
}

// Interpret only the vocabulary present in the canonical v2 schema. Fields,
// enum values and cross-field relations come from generated schema data.
func usageV2Path(object map[string]any, path string) any {
	var value any = object
	for _, key := range strings.Split(path, ".") {
		node, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = node[key]
	}
	return value
}

func validateUsageV2Node(schema usageV2SchemaNode, value any, path string) error {
	fail := func(message string) error { return fmt.Errorf("%s: %s", path, message) }
	if schema.Const != nil && value != *schema.Const {
		return fail("unexpected constant")
	}
	if schema.Enum != nil && !usageV2Contains(schema.Enum, value) {
		return fail("value is outside enum")
	}
	kind := "null"
	switch value.(type) {
	case string:
		kind = "string"
	case bool:
		kind = "boolean"
	case float64:
		kind = "number"
	case map[string]any:
		kind = "object"
	case []any:
		kind = "array"
	}
	if schema.Type != nil {
		types, ok := schema.Type.([]any)
		if !ok {
			types = []any{schema.Type}
		}
		matches := false
		for _, typ := range types {
			if typ == kind {
				matches = true
			}
			if typ == "integer" {
				if n, ok := value.(float64); ok && math.Trunc(n) == n && math.Abs(n) <= 9007199254740991 {
					matches = true
				}
			}
		}
		if !matches {
			return fail("incorrect type")
		}
	}
	if s, ok := value.(string); ok {
		length := utf8.RuneCountInString(s)
		if schema.MinLength != nil && length < *schema.MinLength {
			return fail("string too short")
		}
		if schema.MaxLength != nil && length > *schema.MaxLength {
			return fail("string too long")
		}
		if schema.Format == "date-time" && !usageV2DateTime(s) {
			return fail("invalid date-time")
		}
	}
	if n, ok := value.(float64); ok {
		if schema.Minimum != nil && n < *schema.Minimum {
			return fail("below minimum")
		}
		if schema.Maximum != nil && n > *schema.Maximum {
			return fail("above maximum")
		}
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	for _, key := range schema.Required {
		if _, exists := object[key]; !exists {
			return fail("missing " + key)
		}
	}
	for key, child := range object {
		property, exists := schema.Properties[key]
		if !exists {
			if schema.AdditionalProperties != nil && !*schema.AdditionalProperties {
				return fail("unknown field " + key)
			}
			continue
		}
		if err := validateUsageV2Node(property, child, path+"."+key); err != nil {
			return err
		}
	}
	for _, rule := range schema.Relations {
		switch rule.Kind {
		case "subset":
			part, pok := object[rule.Part].(float64)
			whole, wok := object[rule.Whole].(float64)
			if pok && wok && part > whole {
				return fail(rule.Part + " exceeds " + rule.Whole)
			}
		case "sum":
			total, known := object[rule.Total].(float64)
			sum := float64(0)
			for _, key := range rule.Parts {
				part, ok := object[key].(float64)
				known = known && ok
				sum += part
			}
			if known && total != sum {
				return fail(rule.Total + " differs from component sum")
			}
		case "requires-null":
			if usageV2Contains(rule.Equals, usageV2Path(object, rule.When)) && object[rule.Field] != nil {
				return fail(rule.Field + " must be null")
			}
		case "requires-value":
			if usageV2Contains(rule.Equals, usageV2Path(object, rule.When)) && (object[rule.Field] == nil || object[rule.Field] == "") {
				return fail(rule.Field + " must be known")
			}
		default:
			return fail("unsupported canonical relation")
		}
	}
	return nil
}

// ValidateUsageEventV2 validates the raw wire object before typed decoding, so
// missing explicit-null fields and unknown properties cannot disappear.
func ValidateUsageEventV2(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("invalid usage v2 JSON: %w", err)
	}
	return validateUsageV2Node(usageV2Schema, value, "event")
}

// JSON Schema integers include equivalent decimal/exponent representations.
// Validate before normalizing so typed decoding cannot hide missing fields,
// unknown properties, fractional counts or values outside the safe range.
func (event *UsageEventV2) UnmarshalJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if err := validateUsageV2Node(usageV2Schema, value, "event"); err != nil {
		return err
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return err
	}
	type wireEvent UsageEventV2
	var decoded wireEvent
	if err := json.Unmarshal(normalized, &decoded); err != nil {
		return err
	}
	*event = UsageEventV2(decoded)
	return nil
}
