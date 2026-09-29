package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"
)

func TestChatStopPreservesDeclaredSemanticsAtUpstream(t *testing.T) {
	for _, tc := range []struct {
		name  string
		extra map[string]any
		want  []string
	}{
		{"omitted", nil, nil},
		{"null", map[string]any{"stop": nil}, nil},
		{"empty_array", map[string]any{"stop": []string{}}, nil},
		{"single", map[string]any{"stop": "结束\n"}, []string{"结束\n"}},
		{"empty_string", map[string]any{"stop": ""}, []string{""}},
		{"four", map[string]any{"stop": []string{"one", "two", "three", "four"}}, []string{"one", "two", "three", "four"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wire := make(chan map[string]json.RawMessage, 1)
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				var fields map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&fields); err != nil {
					t.Error(err)
				}
				wire <- fields
				defaultUpstreamHandler()(w, r)
			}})
			resp := h.doChat(chatBody(chatBodyOptions{Extra: tc.extra}), nil)
			_ = readAll(resp)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("valid stop rejected: %d", resp.StatusCode)
			}
			var fields map[string]json.RawMessage
			select {
			case fields = <-wire:
			default:
				t.Fatal("no actual upstream request")
			}
			var actual []string
			if raw, exists := fields["stop"]; exists {
				if err := json.Unmarshal(raw, &actual); err != nil {
					t.Fatal(err)
				}
				if tc.want == nil {
					t.Fatal("null/omitted stop unexpectedly added a stop sequence")
				}
			}
			if !reflect.DeepEqual(actual, tc.want) {
				t.Fatalf("stop semantics changed: got %#v, want %#v", actual, tc.want)
			}
			if h.managed.reserveCount() != 1 || len(h.store.Requests()) != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("valid stop changed request accounting")
			}
		})
	}
}

func TestInvalidStopIsRejectedBeforeAnyBillableWork(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"boolean", false}, {"number", 123},
		{"object", map[string]any{"private-fixture": "private-value"}},
		{"null_element", []any{nil}}, {"mixed_elements", []any{"end", 2}},
		{"nested_array", []any{[]string{"end"}}},
		{"too_many", []string{"one", "two", "three", "four", "five"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			resp := h.doChat(chatBody(chatBodyOptions{Extra: map[string]any{"stop": tc.value}}), nil)
			var envelope errorEnvelope
			if err := json.Unmarshal([]byte(readAll(resp)), &envelope); err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != http.StatusBadRequest || envelope.Error.Code != CodeInvalidParameter || envelope.Error.Param == nil || *envelope.Error.Param != "stop" {
				t.Errorf("invalid stop was not rejected precisely: status=%d code=%s", resp.StatusCode, envelope.Error.Code)
			}
			if calls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
				t.Fatal("invalid stop entered billable execution")
			}
		})
	}
}
