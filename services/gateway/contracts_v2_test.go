package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestUsageEventV2EquivalentJSONNumbers(t *testing.T) {
	raw, err := os.ReadFile("../../tests/contract/fixtures/usage-event-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Event json.RawMessage `json:"event"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(fixtures[0].Event, &value); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	encoded = bytes.Replace(encoded, []byte(`"schema_version":2`), []byte(`"schema_version":2.0`), 1)
	encoded = bytes.Replace(encoded, []byte(`"input_tokens":100`), []byte(`"input_tokens":1e2`), 1)
	if err := ValidateUsageEventV2(encoded); err != nil {
		t.Fatal(err)
	}
	var event UsageEventV2
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatal(err)
	}
	if event.SchemaVersion != 2 || event.Usage.InputTokens == nil || *event.Usage.InputTokens != 100 {
		t.Fatal("equivalent JSON integers lost")
	}
}

func TestUsageEventV2SharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../tests/contract/fixtures/usage-event-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name    string          `json:"name"`
		Valid   bool            `json:"valid"`
		Event   json.RawMessage `json:"event"`
		ValidV1 *bool           `json:"valid_v1"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			if f.ValidV1 != nil {
				var old UsageEvent
				if err := json.Unmarshal(f.Event, &old); err != nil {
					t.Fatal(err)
				}
				if (old.Validate() == nil) != *f.ValidV1 {
					t.Fatal("N-1 compatibility mismatch")
				}
			}
			err := ValidateUsageEventV2(f.Event)
			if (err == nil) != f.Valid {
				t.Fatalf("valid=%v error=%v", f.Valid, err)
			}
			if f.Valid {
				var event UsageEventV2
				if err := json.Unmarshal(f.Event, &event); err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(event)
				if err != nil {
					t.Fatal(err)
				}
				if err := ValidateUsageEventV2(encoded); err != nil {
					t.Fatalf("generated Go type lost facts: %v", err)
				}
			}
		})
	}
}
