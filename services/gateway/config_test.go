package main

import (
	"strings"
	"testing"
)

func TestBudgetConfigIsExplicitAndIsolated(t *testing.T) {
	base := map[string]string{"GATEWAY_ENV": "production", "CONTROL_PLANE_URL": "http://control:3000", "GATEWAY_INTERNAL_TOKEN": strings.Repeat("c", 32), "SNAPSHOT_SIGNING_KEY": strings.Repeat("k", 32), "DATABASE_URL": "postgresql://fixture", "REDIS_URL": "redis://fixture:6379", "KMS_PROVIDER": "vault", "VAULT_ADDR": "https://vault:8200", "VAULT_TOKEN_FILE": "token", "SECRET_REGISTRY_FILE": "registry", "SECRET_REGISTRY_TRUST_FILE": "trust", "SECRET_REGISTRY_FLOOR_FILE": "floor", "SECRET_REGISTRY_ID": "fixture", "SECRET_VAULT_RESOURCES": "transit/key", "SECRET_ALLOWED_ORIGINS": "https://api.example.com", "BUDGET_SERVICE_URL": "http://budget:8090", "BUDGET_SERVICE_TOKEN": strings.Repeat("b", 32)}
	for _, tc := range []struct {
		key, value string
		valid      bool
	}{{"", "", true}, {"REDIS_URL", "", false}, {"BUDGET_SERVICE_URL", "", false}, {"BUDGET_SERVICE_TOKEN", "", false}, {"BUDGET_SERVICE_TOKEN", strings.Repeat("c", 32), false}, {"BUDGET_SERVICE_URL", "http://user:secret@budget", false}, {"BUDGET_SERVICE_URL", "http://budget/path", false}, {"BUDGET_SERVICE_URL", "file:///tmp/budget", false}} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			get := func(k string) string {
				if k == tc.key {
					return tc.value
				}
				return base[k]
			}
			_, err := LoadEnv(get)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	e, err := LoadEnv(func(string) string { return "" })
	if err != nil || e.BudgetServiceURL != "" || e.BudgetServiceToken != "" {
		t.Fatal("development must not inherit control credentials")
	}
}

func TestProductionSecretConfigRejectsUnknownProviderAndOldBypass(t *testing.T) {
	base := map[string]string{"GATEWAY_ENV": "production", "CONTROL_PLANE_URL": "http://control:3000", "GATEWAY_INTERNAL_TOKEN": strings.Repeat("c", 32), "UPSTREAM_ENCRYPTION_KEY": strings.Repeat("k", 32), "SNAPSHOT_SIGNING_KEY": strings.Repeat("k", 32), "DATABASE_URL": "postgresql://fixture", "REDIS_URL": "redis://fixture:6379", "KMS_PROVIDER": "local", "ALLOW_LOCAL_KMS_IN_PRODUCTION": "true", "BUDGET_SERVICE_URL": "http://budget:8090", "BUDGET_SERVICE_TOKEN": strings.Repeat("b", 32)}
	for _, provider := range []string{"local", "aws", "typo"} {
		base["KMS_PROVIDER"] = provider
		if _, err := LoadEnv(func(k string) string { return base[k] }); err == nil {
			t.Fatal("production accepted unsupported provider", provider)
		}
	}
}

func TestMetricsTokenIsOptionalButNeverHasWeakDevelopmentBypass(t *testing.T) {
	for _, environment := range []string{"development", "test", "production"} {
		t.Run(environment, func(t *testing.T) {
			_, err := LoadEnv(func(key string) string {
				switch key {
				case "GATEWAY_ENV":
					return environment
				case "GATEWAY_METRICS_TOKEN":
					return "short-metrics-fixture"
				default:
					return ""
				}
			})
			if err == nil || !strings.Contains(err.Error(), "GATEWAY_METRICS_TOKEN") || strings.Contains(err.Error(), "short-metrics-fixture") {
				t.Fatalf("weak metrics token not rejected safely: %v", err)
			}
		})
	}
	for _, value := range []string{"", strings.Repeat("m", 24)} {
		env, err := LoadEnv(func(key string) string {
			if key == "GATEWAY_METRICS_TOKEN" {
				return value
			}
			return ""
		})
		if err != nil || env.MetricsToken != value {
			t.Fatalf("valid optional token failed: %v", err)
		}
	}
}
