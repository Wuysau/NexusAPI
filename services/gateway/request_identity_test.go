package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCallerCorrelationCannotChooseAccountingIdentity(t *testing.T) {
	for _, v2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "v1", true: "v2"}[v2], func(t *testing.T) {
			h := newHarness(t, harnessOptions{EnableUsageV2: v2, CredentialMode: "byok"})
			ids := map[string]bool{}
			for i := 0; i < 2; i++ {
				res := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"x-request-id": "client-reused-correlation"})
				body := readAll(res)
				id := res.Header.Get("x-request-id")
				if res.StatusCode != 200 || id == "client-reused-correlation" || !strings.HasPrefix(id, "req_") || ids[id] {
					t.Fatalf("caller chose/reused authoritative identity: status=%d id=%s body=%s", res.StatusCode, id, body)
				}
				if res.Header.Get("x-client-request-id") != "client-reused-correlation" {
					t.Fatal("safe correlation lost")
				}
				ids[id] = true
			}
			if len(h.store.Requests()) != 2 || h.store.OutboxCount(testTenantID) != 2 {
				t.Fatal("independent calls were deduplicated")
			}
			for _, rec := range h.store.Requests() {
				if !ids[rec.RequestID] || rec.Event.RequestID != rec.RequestID {
					t.Fatal("response and accounting identities differ")
				}
			}
		})
	}
}

func TestConcurrentCorrelationsHaveUniqueRequestIDs(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"x-request-id": "same-correlation"})
			_ = readAll(r)
			if r.StatusCode != 200 {
				t.Errorf("status=%d", r.StatusCode)
			}
			ids <- r.Header.Get("x-request-id")
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		if id == "" || seen[id] {
			t.Fatal("concurrent request identity collision")
		}
		seen[id] = true
	}
}

func TestResponsesKeepOneServerIdentityWithoutRouterMiddleware(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-4o","input":"hi"}`))
	r.Header.Set("authorization", "Bearer "+testAPIKey)
	r.Header.Set("x-request-id", "repeatable-client-id")
	w := httptest.NewRecorder()
	h.proxy.ServeResponses(w, r)
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	id := w.Header().Get("x-request-id")
	if w.Code != 200 || id == "repeatable-client-id" || payload.ID != "resp_"+id {
		t.Fatalf("inconsistent Responses identity: %d %s", w.Code, w.Body.String())
	}
	if records := h.store.Requests(); len(records) != 1 || records[0].RequestID != id || records[0].EventV2.RequestId != id {
		t.Fatal("Responses accounting identity mismatch")
	}
}

func TestDurableIdempotencyDuplicateReturnsConflictAfterCacheLoss(t *testing.T) {
	h := newHarness(t, harnessOptions{EnableUsageV2: true, CredentialMode: "byok"})
	first := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "explicit-operation"})
	_ = readAll(first)
	if first.StatusCode != 200 {
		t.Fatalf("first=%d", first.StatusCode)
	}
	h.proxy.idempotency = newIdempotencyCache(15*time.Minute, 100_000)
	second := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "explicit-operation"})
	body := readAll(second)
	if second.StatusCode != 409 || !strings.Contains(body, CodeIdempotencyConflict) || len(h.store.Requests()) != 1 {
		t.Fatalf("durable duplicate not mapped to conflict: %d %s", second.StatusCode, body)
	}
}

func TestRequestIdentityErrorsAndCorrelationSanitization(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	for _, value := range []string{"safe-correlation", strings.Repeat("a", 129), "unsafe value"} {
		r := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewBufferString(`{`))
		r.Header.Set("x-request-id", value)
		w := httptest.NewRecorder()
		h.handler.ServeHTTP(w, r)
		var payload struct {
			Error struct {
				RequestID string `json:"request_id"`
			} `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("x-request-id"), "req_") || payload.Error.RequestID != w.Header().Get("x-request-id") {
			t.Fatalf("error identity mismatch: %s", w.Body.String())
		}
		want := ""
		if value == "safe-correlation" {
			want = value
		}
		if w.Header().Get("x-client-request-id") != want {
			t.Fatal("unsafe correlation echoed")
		}
	}
}
