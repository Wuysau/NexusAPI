package main

// NexusUsageEventV1 — Go side of packages/contracts/schemas/usage-event.schema.json.
//
// The outbox payload must validate against the JSON Schema before it is
// persisted; an event that fails validation is a programming error and the
// request terminal write is aborted rather than shipping a malformed billing
// fact (INVARIANT #9).

import (
	"errors"
	"fmt"
	"time"
)

// Usage event status values.
const (
	UsageStatusCompleted = "completed"
	UsageStatusFailed    = "failed"
	UsageStatusUnknown   = "unknown"
)

// UsageEventUsage mirrors the schema's `usage` object (additionalProperties:
// false). Optional counters are pointers so they are omitted rather than
// serialised as a misleading zero.
type UsageEventUsage struct {
	InputTokens       int  `json:"input_tokens"`
	CachedInputTokens *int `json:"cached_input_tokens,omitempty"`
	OutputTokens      int  `json:"output_tokens"`
	ReasoningTokens   *int `json:"reasoning_tokens,omitempty"`
	Estimated         bool `json:"estimated"`
}

// UsageEvent is the versioned billing fact written to the outbox.
type UsageEvent struct {
	SchemaVersion     int             `json:"schema_version"`
	EventID           string          `json:"event_id"`
	OccurredAt        string          `json:"occurred_at"`
	TenantID          string          `json:"tenant_id"`
	RequestID         string          `json:"request_id"`
	AttemptID         string          `json:"attempt_id"`
	ProviderRequestID *string         `json:"provider_request_id,omitempty"`
	ModelID           string          `json:"model_id"`
	Status            string          `json:"status"`
	PriceVersionID    string          `json:"price_version_id"`
	CatalogVersionID  string          `json:"catalog_version_id"`
	PolicyVersionID   *string         `json:"policy_version_id,omitempty"`
	Usage             UsageEventUsage `json:"usage"`
	Dimensions        map[string]any  `json:"dimensions,omitempty"`
}

const usageEventSchemaVersion = 1

// Validate enforces the parts of the JSON Schema that Go's type system does not:
// enumerations, string lengths and formats, and non-negative counters. A
// failure means the event must not be persisted.
func (e *UsageEvent) Validate() error {
	var problems []error
	if e.SchemaVersion != usageEventSchemaVersion {
		problems = append(problems, fmt.Errorf("schema_version must be %d", usageEventSchemaVersion))
	}
	if len(e.EventID) < 16 {
		problems = append(problems, errors.New("event_id must be at least 16 characters"))
	}
	if _, err := time.Parse(time.RFC3339, e.OccurredAt); err != nil {
		problems = append(problems, errors.New("occurred_at must be an RFC3339 date-time"))
	}
	for name, value := range map[string]string{
		"tenant_id": e.TenantID, "request_id": e.RequestID, "attempt_id": e.AttemptID,
		"model_id": e.ModelID, "price_version_id": e.PriceVersionID, "catalog_version_id": e.CatalogVersionID,
	} {
		if value == "" {
			problems = append(problems, fmt.Errorf("%s is required", name))
		}
	}
	switch e.Status {
	case UsageStatusCompleted, UsageStatusFailed, UsageStatusUnknown:
	default:
		problems = append(problems, fmt.Errorf("status %q is not in the enum", e.Status))
	}
	if e.Usage.InputTokens < 0 || e.Usage.OutputTokens < 0 {
		problems = append(problems, errors.New("token counts must be non-negative"))
	}
	if e.Usage.CachedInputTokens != nil && *e.Usage.CachedInputTokens < 0 {
		problems = append(problems, errors.New("cached_input_tokens must be non-negative"))
	}
	if e.Usage.ReasoningTokens != nil && *e.Usage.ReasoningTokens < 0 {
		problems = append(problems, errors.New("reasoning_tokens must be non-negative"))
	}
	if e.ProviderRequestID != nil && *e.ProviderRequestID == "" {
		problems = append(problems, errors.New("provider_request_id must not be empty when present"))
	}
	if len(problems) > 0 {
		return fmt.Errorf("usage event invalid: %w", errors.Join(problems...))
	}
	return nil
}

// Outcome is the terminal outcome of one attempt.
type Outcome string

const (
	OutcomeCompleted Outcome = "completed"
	OutcomeFailed    Outcome = "failed"
	// OutcomeUnknown is used when the gateway cannot prove what the upstream
	// did (e.g. connection died after bytes were sent). It goes to
	// reconciliation and is never billed as zero (INVARIANT #12).
	OutcomeUnknown Outcome = "unknown"
)
