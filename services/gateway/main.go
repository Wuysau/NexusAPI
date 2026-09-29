package main

// nexus-gateway — the standalone Go data plane (ADR-0001).
//
// It talks to the control plane only through the signed snapshot and the thin
// configuration API; budget authorization has its own private service. Provider
// decryption uses Vault plus operator registry authority, never Control Plane.

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"nexus/gateway/provider"
)

func main() {
	if err := run(); err != nil {
		slog.Error("gateway exited with error", "err", err.Error())
		os.Exit(1)
	}
}

func run() error {
	logger := newLogger(os.Getenv("GATEWAY_LOG_LEVEL"))

	env, err := LoadEnv(os.Getenv)
	if err != nil {
		return err
	}
	limits := LoadLimits(os.Getenv)
	snapshotCfg := LoadSnapshotConfig(os.Getenv)

	keyring, err := BuildKeyringFromEnv(env)
	if err != nil {
		return fmt.Errorf("keyring: %w", err)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cleanup := &gatewayCleanup{}
	defer cleanup.closeStartup()
	controlTransport, err := controlPlaneTransport(os.Getenv("CONTROL_PLANE_CA_FILE"))
	if err != nil {
		return err
	}
	cleanup.add(controlTransport.CloseIdleConnections)
	var connectors *ConnectorHub
	if os.Getenv("NEXUS_CONNECTORS_ENABLED") == "true" {
		if err := validateConnectorDeployment(env, os.Getenv); err != nil {
			return err
		}
		closeLock, e := connectorSingleton(rootCtx, env.DatabaseURL, stop)
		if e != nil {
			return e
		}
		defer closeLock()
		connectors = NewConnectorHub(env.ControlPlaneURL, env.InternalToken)
		connectors.client.Transport = controlTransport
	}
	var credentials CredentialResolver
	if env.LocalCredentialDir != "" && env.Environment != "production" {
		resolver, e := NewLocalCredentialResolver(env.LocalCredentialDir)
		if e != nil {
			return fmt.Errorf("local secret plane: %w", e)
		}
		credentials = resolver
	} else if env.KMSProvider == "vault" {
		resolver, e := NewVaultCredentialResolver(env.Vault)
		if e != nil {
			return fmt.Errorf("secret plane: %w", e)
		}
		credentials = resolver
	} else if env.Environment != "production" {
		credentials = NewHTTPCredentialResolver(env.ControlPlaneURL, env.InternalToken, nil)
	} else {
		return errSecretPolicy
	}

	if closer, ok := credentials.(interface{ Close() error }); ok {
		cleanup.add(func() { _ = closer.Close() })
	}

	// Snapshot cache: verify every bundle before it can serve a request.
	source := &HTTPSnapshotSource{
		BaseURL: env.ControlPlaneURL,
		Token:   env.InternalToken,
		Client:  &http.Client{Timeout: snapshotCfg.FetchTimeout, Transport: controlTransport},
	}
	snapshots := NewSnapshotCache(source, keyring, snapshotCfg, logger)

	store, err := NewPostgresStore(rootCtx, env.DatabaseURL, logger)
	if err != nil {
		return fmt.Errorf("outbox store: %w", err)
	}
	cleanup.add(store.Close)
	if err := store.Ping(rootCtx); err != nil {
		logger.Warn("database not reachable at startup; terminal writes will fail closed", "err", err.Error())
	}

	limiter, err := newGatewayLimiter(env.RedisURL, limits.MaxConcurrent, logger)
	if err != nil {
		return fmt.Errorf("limiter: %w", err)
	}
	cleanup.add(func() { _ = limiter.Close() })

	registry, err := provider.NewBuiltinRegistry()
	if err != nil {
		return fmt.Errorf("provider registry: %w", err)
	}
	breaker := NewBreaker(DefaultBreakerConfig())
	router := NewRouter(registry, breaker, DefaultScoreWeights())

	httpClient := &http.Client{
		Transport: &http.Transport{
			MaxIdleConns:        512,
			MaxIdleConnsPerHost: 128,
			IdleConnTimeout:     90 * time.Second,
			ForceAttemptHTTP2:   true,
		},
	}
	cleanup.add(httpClient.CloseIdleConnections)

	proxy := NewProxy(ProxyDeps{
		EnableUsageV2: connectors != nil || (env.LocalCredentialDir != "" && env.Environment != "production"),
		Connectors:    connectors,
		Env:           env,
		Limits:        limits,
		Snapshots:     snapshots,
		Authn:         NewAuthenticator(snapshots),
		Registry:      registry,
		Breaker:       breaker,
		Router:        router,
		Limiter:       limiter,
		Store:         store,
		Credentials:   credentials,
		Managed:       NewHTTPReserver(env.BudgetServiceURL, env.BudgetServiceToken, httpClient),
		Byok:          NoopReserver{},
		Logger:        logger,
		HTTPClient:    httpClient,
		MaxAttempts:   2,
	})

	// Warm the platform snapshot before accepting traffic so the first request
	// does not pay for the fetch, and so /readyz is truthful.
	warmCtx, cancelWarm := context.WithTimeout(rootCtx, snapshotCfg.FetchTimeout)
	if _, err := snapshots.Get(warmCtx, ""); err != nil {
		logger.Warn("platform snapshot unavailable at startup; /readyz will report not ready", "err", err.Error())
	}
	cancelWarm()

	refreshCtx, cancelRefresh := context.WithCancel(rootCtx)
	refreshDone := make(chan struct{})
	go func() {
		defer close(refreshDone)
		snapshots.RunRefresher(refreshCtx)
	}()
	cleanup.add(func() {
		cancelRefresh()
		<-refreshDone
	})

	shutdownTelemetry := SetupTelemetry(os.Getenv("GATEWAY_OTEL_DISABLED") == "true", logger)
	cleanup.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = shutdownTelemetry(ctx)
	})

	handler := NewHTTPRouter(proxy, snapshots, limiter, store, RouteOptions{
		EnableResponses:  os.Getenv("GATEWAY_ENABLE_RESPONSES") == "true",
		EnableEmbeddings: os.Getenv("GATEWAY_ENABLE_EMBEDDINGS") == "true",
	})
	server := NewServer(env.Addr, handler, limits.MaxHeaderBytes, logger)
	cleanup.transferTo(server)

	errCh := make(chan error, 1)
	go func() {
		logger.Info("nexus-gateway listening",
			"addr", env.Addr,
			"env", env.Environment,
			"adapters", registry.Versions(),
			"snapshot_refresh", snapshotCfg.RefreshInterval.String(),
			"snapshot_max_age", snapshotCfg.MaxAge.String(),
		)
		if os.Getenv("GATEWAY_TLS_CERT") != "" {
			errCh <- server.http.ListenAndServeTLS(os.Getenv("GATEWAY_TLS_CERT"), os.Getenv("GATEWAY_TLS_KEY"))
		} else {
			errCh <- server.ListenAndServe()
		}
	}()

	var serveErr error
	select {
	case serveErr = <-errCh:
	case <-rootCtx.Done():
	}
	stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := finishGatewayShutdown(shutdownCtx, server, serveErr); err != nil {
		return err
	}
	logger.Info("nexus-gateway stopped")
	return nil
}

// Configure process capacity before the first acquisition. A synthetic startup
// acquisition would both reserve a slot forever and lock in the lazy default.
func newGatewayLimiter(redisURL string, maxConcurrent int, logger *slog.Logger) (*Limiter, error) {
	limiter, err := NewLimiter(redisURL, logger)
	if err != nil {
		return nil, err
	}
	concurrencyGuardSize(limiter, maxConcurrent)
	return limiter, nil
}

// concurrencyGuardSize sizes the process-wide semaphore. The guard is private
// to the limiter, so this is done through a tiny adapter rather than exporting
// the internals.
func concurrencyGuardSize(limiter *Limiter, max int) {
	if limiter == nil || limiter.conc == nil {
		return
	}
	limiter.conc.SetGlobalCap(max)
}

func newLogger(level string) *slog.Logger {
	var slogLevel slog.Level
	switch level {
	case "debug":
		slogLevel = slog.LevelDebug
	case "warn":
		slogLevel = slog.LevelWarn
	case "error":
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slogLevel}))
}
