package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"nexus/gateway/provider"
	"os"
	"time"
)

func controlPlaneTransport(caFile string) (*http.Transport, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, errors.New("control plane CA file unavailable")
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid Control Plane CA file")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return transport, nil
}

func validateConnectorDeployment(env *Env, getenv func(string) string) error {
	if getenv("GATEWAY_REPLICAS") != "1" {
		return errors.New("connector transport requires GATEWAY_REPLICAS=1 and one shared endpoint")
	}
	if env.Environment == "production" {
		if getenv("GATEWAY_TLS_CERT") == "" || getenv("GATEWAY_TLS_KEY") == "" {
			return errors.New("connector production Gateway requires native TLS certificate and key")
		}
		u, err := url.Parse(env.ControlPlaneURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("connector production Control Plane requires verified HTTPS")
		}
	}
	return nil
}

func (p *Proxy) resolveChannelCredential(ctx context.Context, c *SnapshotChannel, ref CredentialRef) (provider.Credential, error) {
	if c.Transport == "local_sidecar" {
		if p.connectors == nil || c.CredentialMode != "byok" {
			return provider.Credential{}, errConnectorUnavailable
		}
		return provider.Credential{Ref: c.CredentialRef, Fingerprint: c.CredentialFingerprint}, nil
	}
	return p.credentials.Resolve(ctx, ref)
}

// A dedicated database session holds the lock for the entire Gateway lifetime.
// Heartbeat failure cancels the process, so a disconnected lock holder cannot keep serving.
func connectorSingleton(ctx context.Context, databaseURL string, stop context.CancelFunc) (func(), error) {
	acquireCtx, cancelAcquire := context.WithTimeout(ctx, readinessTimeout)
	defer cancelAcquire()
	conn, err := pgx.Connect(acquireCtx, databaseURL)
	if err != nil {
		return nil, errors.New("connector singleton database unavailable")
	}
	var acquired bool
	if conn.QueryRow(acquireCtx, "SELECT pg_try_advisory_lock(782349201,1)").Scan(&acquired) != nil || !acquired {
		_ = conn.Close(acquireCtx)
		return nil, errors.New("connector transport requires exactly one Gateway; singleton lock is held")
	}
	leaseCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				check, c := context.WithTimeout(leaseCtx, time.Second)
				err := conn.Ping(check)
				c()
				if err != nil {
					stop()
					return
				}
			}
		}
	}()
	return func() { cancel(); <-done; _ = conn.Close(context.Background()) }, nil
}
