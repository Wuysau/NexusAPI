package provider

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRetryAfterNormalizesAndBoundsProviderHints(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name   string
		values map[string]string
		want   time.Duration
	}{
		{"seconds", map[string]string{"Retry-After": "12"}, 12 * time.Second},
		{"milliseconds", map[string]string{"retry-after-ms": "1250"}, 1250 * time.Millisecond},
		{"azure milliseconds", map[string]string{"x-ms-retry-after-ms": "150"}, 150 * time.Millisecond},
		{"milliseconds precedence", map[string]string{"Retry-After": "20", "retry-after-ms": "50"}, 50 * time.Millisecond},
		{"invalid falls through", map[string]string{"retry-after-ms": "invalid", "x-ms-retry-after-ms": "250"}, 250 * time.Millisecond},
		{"date", map[string]string{"Retry-After": now.Add(15 * time.Second).Format(http.TimeFormat)}, 15 * time.Second},
		{"past date", map[string]string{"Retry-After": now.Add(-time.Second).Format(http.TimeFormat)}, 0},
		{"current date", map[string]string{"Retry-After": now.Format(http.TimeFormat)}, 0},
		{"future date capped", map[string]string{"Retry-After": now.Add(24 * time.Hour).Format(http.TimeFormat)}, time.Minute},
		{"overflow seconds", map[string]string{"Retry-After": strings.Repeat("9", 1024)}, time.Minute},
		{"overflow milliseconds", map[string]string{"retry-after-ms": strings.Repeat("9", 1024)}, time.Minute},
		{"invalid suffix after overflow", map[string]string{"Retry-After": strings.Repeat("9", 100) + "x"}, 0},
		{"negative", map[string]string{"Retry-After": "-4"}, 0},
		{"zero", map[string]string{"Retry-After": "0"}, 0},
		{"fraction", map[string]string{"Retry-After": "1.5"}, 0},
		{"multiple values", map[string]string{"Retry-After": "1, 2"}, 0},
		{"nonfinite", map[string]string{"retry-after-ms": "NaN"}, 0},
		{"empty", nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := make(http.Header)
			for key, value := range tc.values {
				headers.Set(key, value)
			}
			if got := retryAfter(headers, now); got != tc.want {
				t.Fatalf("duration = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAdaptersPreserveOnlyNormalizedRetryHint(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "9999999999999999999999999")
		w.Header().Set("X-Private-Provider-Header", "private-header-value")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"message":"private-error-body"}}`)
	}))
	defer upstream.Close()
	for _, adapter := range []Adapter{NewOpenAICompatible("openai", upstream.URL), NewAnthropic(), NewGemini()} {
		t.Run(adapter.ID(), func(t *testing.T) {
			_, err := adapter.Stream(context.Background(), upstream.Client(), &ProviderRequest{Method: http.MethodPost, URL: upstream.URL, Body: []byte(`{}`)})
			var responseError *UpstreamHTTPError
			if !errors.As(err, &responseError) || responseError.RetryAfter != time.Minute {
				t.Fatalf("expected normalized error hint, got %v", err)
			}
			if err.Error() != "upstream http 503" {
				t.Fatalf("error contains response details: %q", err.Error())
			}
		})
	}
}
