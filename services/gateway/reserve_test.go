package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBudgetAuthorizationProtocol(t *testing.T) {
	for _, amount := range []string{`"9007199254740993"`, `1`, `"-1"`, `"0"`, `"1.5"`, `"9223372036854775808"`} {
		t.Run(amount, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/reservations" {
					t.Errorf("path %s", r.URL.Path)
				}
				_, _ = fmt.Fprintf(w, `{"reservation_id":"r","amount_micros":%s,"currency":"USD","expires_at":%q,"replayed":false}`, amount, time.Now().Add(time.Minute).Format(time.RFC3339))
			}))
			defer s.Close()
			res, err := NewHTTPReserver(s.URL, "budget", nil).Reserve(context.Background(), ReserveRequest{Currency: "USD"})
			if amount == `"9007199254740993"` {
				if err != nil || res.AmountMicros != 9007199254740993 {
					t.Fatalf("res=%+v err=%v", res, err)
				}
			} else if err == nil {
				t.Fatal("accepted invalid amount")
			}
		})
	}
}
func TestBudgetDoesNotForwardTokenOnRedirect(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer target.Close()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer s.Close()
	_, err := NewHTTPReserver(s.URL, "secret", nil).Reserve(context.Background(), ReserveRequest{})
	if err == nil || calls != 0 {
		t.Fatalf("redirect calls=%d err=%v", calls, err)
	}
}

func TestBudgetRejectsMalformedAuthorization(t *testing.T) {
	future := time.Now().Add(time.Minute).Format(time.RFC3339)
	for _, body := range []string{
		`{}`, `{"reservation_id":"r","amount_micros":"1","currency":"USD","expires_at":"bad","replayed":false}`,
		fmt.Sprintf(`{"reservation_id":"","amount_micros":"1","currency":"USD","expires_at":%q,"replayed":false}`, future),
		fmt.Sprintf(`{"reservation_id":"r","amount_micros":"1","currency":"EUR","expires_at":%q,"replayed":false}`, future),
		fmt.Sprintf(`{"reservation_id":"r","amount_micros":"1","currency":"USD","expires_at":%q}`, future),
		`{"reservation_id":"r","amount_micros":"1","currency":"USD","expires_at":"2000-01-01T00:00:00Z","replayed":false}`,
	} {
		t.Run(body, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = fmt.Fprint(w, body) }))
			defer s.Close()
			_, err := NewHTTPReserver(s.URL, "budget", nil).Reserve(context.Background(), ReserveRequest{Currency: "USD"})
			if err == nil {
				t.Fatal("malformed authorization accepted")
			}
		})
	}
}
