package main

// Fail-closed gateway configuration.
//
// Mirrors the control-plane rules in src/lib/config.ts: in production the
// process refuses to start unless the security-critical variables are present
// and sane. There is NO default-admin bypass: if the internal token is absent
// the internal/admin surface is closed, not open (Work Item C finding C3).
//
// The gateway is the data plane. It never reads the control-plane database for
// configuration. Credential unwrap uses Gateway-only Vault identity and an
// independently signed operator registry, never a Control Plane plaintext API.

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Env carries the fully validated process configuration.
type Env struct {
	BudgetServiceURL   string
	BudgetServiceToken string
	Environment        string
	Addr               string
	ControlPlaneURL    string
	InternalToken      string
	MetricsToken       string
	DatabaseURL        string
	RedisURL           string

	// Snapshot signing keyring. Same env names and KDF as src/lib/crypto.ts so
	// the gateway verifies the exact bytes the control plane signed.
	UpstreamEncryptionKey string // Snapshot signing only; never a credential wrapping key.
	SnapshotKeyVersion    int
	PreviousKey           string
	PreviousKeyVersion    int

	// Secret plane guard (Work Item C finding C1/C2). The gateway never unwraps
	// with a local KMS in production; this is enforced here as well as in the
	// control plane so a misconfigured deployment cannot silently downgrade.
	KMSProvider               string
	AllowLocalKMSInProduction bool
	RequireSnapshotSignature  bool
	Vault                     VaultConfig
	LocalCredentialDir        string
}

// Limits holds the system-level caps from GATEWAY_SPEC "限制与取消".
type Limits struct {
	MaxHeaderBytes       int
	MaxBodyBytes         int64
	MaxTokensEstimate    int
	MaxConcurrent        int
	ChannelMaxConcurrent int
	ConcurrencyWait      time.Duration
	MaxResponseBytes     int
	RequestsPerMinute    int
	TokensPerMinute      int
	TotalDuration        time.Duration
	IdleTimeout          time.Duration
	UpstreamTimeout      time.Duration
	SlowClientBuffer     int
}

// SnapshotConfig controls snapshot freshness and the fail-closed window.
type SnapshotConfig struct {
	// RefreshInterval is how often the gateway polls the control plane.
	RefreshInterval time.Duration
	// MaxAge is the hard expiry of the last-known-good snapshot. Once exceeded
	// the gateway stops serving managed traffic (INVARIANT #8, GATEWAY_SPEC
	// "降级").
	MaxAge time.Duration
	// FetchTimeout bounds a single control-plane snapshot call.
	FetchTimeout time.Duration
	// TenantID selects the snapshot scope; empty means the platform snapshot.
	TenantID string
}

const (
	minProductionTokenLength = 24
	minProductionKeyLength   = 32

	defaultAddr            = ":8080"
	defaultControlPlaneURL = "http://127.0.0.1:3000"
	defaultRefresh         = 30 * time.Second
	defaultSnapshotMaxAge  = 5 * time.Minute
	defaultFetchTimeout    = 10 * time.Second
)

// LoadEnv validates and returns the process environment. It returns an error
// (never a permissive default) when production requirements are unmet.
func LoadEnv(getenv func(string) string) (*Env, error) {
	pick := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}

	env := &Env{
		BudgetServiceURL:      strings.TrimRight(strings.TrimSpace(getenv("BUDGET_SERVICE_URL")), "/"),
		BudgetServiceToken:    strings.TrimSpace(getenv("BUDGET_SERVICE_TOKEN")),
		Environment:           pick("GATEWAY_ENV", "development"),
		Addr:                  pick("GATEWAY_ADDR", defaultAddr),
		ControlPlaneURL:       strings.TrimRight(pick("CONTROL_PLANE_URL", defaultControlPlaneURL), "/"),
		InternalToken:         strings.TrimSpace(getenv("GATEWAY_INTERNAL_TOKEN")),
		MetricsToken:          strings.TrimSpace(getenv("GATEWAY_METRICS_TOKEN")),
		DatabaseURL:           strings.TrimSpace(getenv("DATABASE_URL")),
		RedisURL:              strings.TrimSpace(getenv("REDIS_URL")),
		UpstreamEncryptionKey: strings.TrimSpace(getenv("SNAPSHOT_SIGNING_KEY")),
		PreviousKey:           strings.TrimSpace(getenv("SNAPSHOT_SIGNING_KEY_PREVIOUS")),
		KMSProvider:           pick("KMS_PROVIDER", "local"),
		LocalCredentialDir:    strings.TrimSpace(getenv("NEXUS_LOCAL_CREDENTIAL_DIR")),
	}
	env.Vault = VaultConfig{Address: strings.TrimSpace(getenv("VAULT_ADDR")), TokenFile: getenv("VAULT_TOKEN_FILE"), CAFile: getenv("VAULT_CA_FILE"), RegistryFile: getenv("SECRET_REGISTRY_FILE"), TrustFile: getenv("SECRET_REGISTRY_TRUST_FILE"), FloorFile: getenv("SECRET_REGISTRY_FLOOR_FILE"), RegistryID: getenv("SECRET_REGISTRY_ID"), Resources: splitSecretConfig(getenv("SECRET_VAULT_RESOURCES")), Origins: splitSecretConfig(getenv("SECRET_ALLOWED_ORIGINS"))}
	env.SnapshotKeyVersion = 1
	if v := getenv("SNAPSHOT_SIGNING_KEY_VERSION"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 {
			return nil, errors.New("invalid SNAPSHOT_SIGNING_KEY_VERSION")
		}
		env.SnapshotKeyVersion = n
	}

	if env.Environment != "development" && env.Environment != "test" && env.Environment != "production" {
		return nil, errors.New("[fail-closed] GATEWAY_ENV must be development, test, or production")
	}
	if env.MetricsToken != "" && len(env.MetricsToken) < minProductionTokenLength {
		return nil, fmt.Errorf("[fail-closed] GATEWAY_METRICS_TOKEN must be at least %d chars", minProductionTokenLength)
	}

	prevVersion := strings.TrimSpace(getenv("SNAPSHOT_SIGNING_KEY_PREVIOUS_VERSION"))
	if prevVersion != "" {
		n, err := strconv.Atoi(prevVersion)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("[fail-closed] SNAPSHOT_SIGNING_KEY_PREVIOUS_VERSION must be a positive integer")
		}
		env.PreviousKeyVersion = n
	}

	allowLocal := strings.EqualFold(strings.TrimSpace(getenv("ALLOW_LOCAL_KMS_IN_PRODUCTION")), "true")
	env.AllowLocalKMSInProduction = allowLocal
	env.RequireSnapshotSignature = !strings.EqualFold(strings.TrimSpace(getenv("GATEWAY_ALLOW_UNSIGNED_SNAPSHOT")), "true")

	if _, err := url.Parse(env.ControlPlaneURL); err != nil {
		return nil, fmt.Errorf("[fail-closed] CONTROL_PLANE_URL is not a valid URL: %w", err)
	}

	if env.BudgetServiceURL != "" {
		u, err := url.Parse(env.BudgetServiceURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return nil, errors.New("[fail-closed] invalid BUDGET_SERVICE_URL")
		}
	}
	if env.BudgetServiceToken != "" && (env.BudgetServiceToken == env.InternalToken || env.BudgetServiceToken == env.UpstreamEncryptionKey) {
		return nil, errors.New("[fail-closed] BUDGET_SERVICE_TOKEN must be distinct")
	}
	if env.Environment == "production" {
		if env.LocalCredentialDir != "" {
			return nil, errors.New("[fail-closed] NEXUS_LOCAL_CREDENTIAL_DIR is forbidden in production")
		}
		if env.KMSProvider != "vault" || allowLocal || !env.RequireSnapshotSignature {
			return nil, errors.New("[fail-closed] production requires Vault and signed snapshots; no local bypass")
		}
		if env.Vault.Address == "" || env.Vault.TokenFile == "" || env.Vault.RegistryFile == "" || env.Vault.TrustFile == "" || env.Vault.FloorFile == "" || env.Vault.RegistryID == "" || len(env.Vault.Resources) == 0 || len(env.Vault.Origins) == 0 {
			return nil, errors.New("[fail-closed] missing Vault registry/workload configuration")
		}
		var missing []string
		for key, value := range map[string]string{
			"CONTROL_PLANE_URL":      getenv("CONTROL_PLANE_URL"),
			"GATEWAY_INTERNAL_TOKEN": env.InternalToken,
			"SNAPSHOT_SIGNING_KEY":   env.UpstreamEncryptionKey,
			"DATABASE_URL":           env.DatabaseURL,
			"REDIS_URL":              env.RedisURL,
			"BUDGET_SERVICE_URL":     env.BudgetServiceURL,
			"BUDGET_SERVICE_TOKEN":   env.BudgetServiceToken,
		} {
			if strings.TrimSpace(value) == "" {
				missing = append(missing, key)
			}
		}
		if len(missing) > 0 {
			return nil, fmt.Errorf("[fail-closed] missing required env in production: %s", strings.Join(missing, ", "))
		}
		if env.InternalToken == env.UpstreamEncryptionKey {
			return nil, errors.New("[fail-closed] GATEWAY_INTERNAL_TOKEN must not equal SNAPSHOT_SIGNING_KEY")
		}
		if env.UpstreamEncryptionKey == env.DatabaseURL {
			return nil, errors.New("[fail-closed] SNAPSHOT_SIGNING_KEY must not equal DATABASE_URL")
		}
		if len(env.BudgetServiceToken) < minProductionTokenLength {
			return nil, errors.New("[fail-closed] BUDGET_SERVICE_TOKEN too short")
		}
		if len(env.InternalToken) < minProductionTokenLength {
			return nil, fmt.Errorf("[fail-closed] GATEWAY_INTERNAL_TOKEN must be at least %d chars in production", minProductionTokenLength)
		}
		if len(env.UpstreamEncryptionKey) < minProductionKeyLength {
			return nil, fmt.Errorf("[fail-closed] SNAPSHOT_SIGNING_KEY must be at least %d chars in production", minProductionKeyLength)
		}
	}

	return env, nil
}

func splitSecretConfig(value string) []string {
	var out []string
	for _, v := range strings.Split(value, ",") {
		if s := strings.TrimSpace(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// LoadLimits applies the system caps, clamped into a safe range. Operators can
// raise them up to the hard ceiling; they can never disable them.
func LoadLimits(getenv func(string) string) Limits {
	return Limits{
		MaxHeaderBytes:       int(clampInt(getenv, "GATEWAY_MAX_HEADER_BYTES", 16*1024, 1*1024, 1<<20)),
		MaxBodyBytes:         clampInt64(getenv, "GATEWAY_MAX_BODY_BYTES", 1<<20, 1024, 32<<20),
		MaxTokensEstimate:    int(clampInt(getenv, "GATEWAY_MAX_TOKENS_ESTIMATE", 65536, 256, 4<<20)),
		MaxConcurrent:        int(clampInt(getenv, "GATEWAY_MAX_CONCURRENT", 256, 1, 100000)),
		ChannelMaxConcurrent: int(clampInt(getenv, "GATEWAY_CHANNEL_MAX_CONCURRENT", 64, 1, 100000)),
		ConcurrencyWait:      time.Duration(clampInt(getenv, "GATEWAY_CONCURRENCY_WAIT_MS", 0, 0, 30000)) * time.Millisecond,
		MaxResponseBytes:     int(clampInt(getenv, "GATEWAY_MAX_RESPONSE_BYTES", 16<<20, 4096, 64<<20)),
		RequestsPerMinute:    int(clampInt(getenv, "GATEWAY_REQUESTS_PER_MINUTE", 600, 1, 10_000_000)),
		TokensPerMinute:      int(clampInt(getenv, "GATEWAY_TOKENS_PER_MINUTE", 2_000_000, 1, 1<<40)),
		TotalDuration:        clampDuration(getenv, "GATEWAY_TOTAL_TIMEOUT_SECONDS", 300, time.Second, 24*time.Hour),
		IdleTimeout:          clampDuration(getenv, "GATEWAY_STREAM_IDLE_TIMEOUT_SECONDS", 60, time.Second, time.Hour),
		UpstreamTimeout:      clampDuration(getenv, "GATEWAY_UPSTREAM_TIMEOUT_SECONDS", 120, time.Second, time.Hour),
		SlowClientBuffer:     int(clampInt(getenv, "GATEWAY_SLOW_CLIENT_BUFFER_BYTES", 1<<20, 4096, 64<<20)),
	}
}

// LoadSnapshotConfig returns freshness policy. MaxAge is the fail-closed window
// and may not be shorter than the refresh interval.
func LoadSnapshotConfig(getenv func(string) string) SnapshotConfig {
	refresh := clampDuration(getenv, "GATEWAY_SNAPSHOT_REFRESH_SECONDS", int(defaultRefresh/time.Second), time.Second, time.Hour)
	maxAge := clampDuration(getenv, "GATEWAY_SNAPSHOT_MAX_AGE_SECONDS", int(defaultSnapshotMaxAge/time.Second), time.Second, 24*time.Hour)
	if maxAge < refresh {
		maxAge = refresh
	}
	return SnapshotConfig{
		RefreshInterval: refresh,
		MaxAge:          maxAge,
		FetchTimeout:    clampDuration(getenv, "GATEWAY_SNAPSHOT_FETCH_TIMEOUT_SECONDS", int(defaultFetchTimeout/time.Second), time.Second, time.Minute),
		TenantID:        strings.TrimSpace(getenv("GATEWAY_SNAPSHOT_TENANT_ID")),
	}
}

func clampInt(getenv func(string) string, key string, fallback, min, max int64) int64 {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return fallback
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func clampInt64(getenv func(string) string, key string, fallback, min, max int64) int64 {
	return clampInt(getenv, key, fallback, min, max)
}

func clampDuration(getenv func(string) string, key string, fallbackSeconds int, min, max time.Duration) time.Duration {
	d := time.Duration(clampInt(getenv, key, int64(fallbackSeconds), 1, int64(max/time.Second))) * time.Second
	if d < min {
		return min
	}
	if d > max {
		return max
	}
	return d
}
