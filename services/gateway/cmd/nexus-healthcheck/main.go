// nexus-healthcheck probes the local Gateway without bypassing TLS verification.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	probeTimeout = 3 * time.Second
	maxBodyBytes = 64 << 10
)

func main() {
	if err := run(context.Background(), os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv func(string) string) error {
	address := strings.TrimSpace(getenv("GATEWAY_ADDR"))
	if address == "" {
		address = ":8080"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("invalid GATEWAY_ADDR for readiness probe")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return errors.New("invalid Gateway port for readiness probe")
	}
	// The bind address controls the address family and port, never a remote
	// probe destination. A wildcard IPv6 listener is reached through ::1.
	loopback := "127.0.0.1"
	if ip, err := netip.ParseAddr(host); err == nil && ip.Is6() && !ip.Is4In6() {
		loopback = "::1"
	}
	certFile, keyFile := getenv("GATEWAY_TLS_CERT"), getenv("GATEWAY_TLS_KEY")
	if (certFile == "") != (keyFile == "") {
		return errors.New("readiness probe requires both Gateway TLS certificate and key settings")
	}
	scheme := "http"
	var tlsConfig *tls.Config
	caFile, serverName := getenv("GATEWAY_HEALTHCHECK_CA_FILE"), getenv("GATEWAY_HEALTHCHECK_TLS_SERVER_NAME")
	if certFile != "" {
		scheme = "https"
		tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName}
		if caFile != "" {
			pem, err := os.ReadFile(caFile)
			if err != nil {
				return errors.New("readiness CA file unavailable")
			}
			roots, err := x509.SystemCertPool()
			if err != nil {
				roots = x509.NewCertPool()
			}
			if !roots.AppendCertsFromPEM(pem) {
				return errors.New("invalid readiness CA file")
			}
			tlsConfig.RootCAs = roots
		}
	} else if caFile != "" || serverName != "" {
		return errors.New("readiness TLS settings require Gateway TLS")
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: probeTimeout}).DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   probeTimeout,
		ResponseHeaderTimeout: probeTimeout,
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   probeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+net.JoinHostPort(loopback, port)+"/readyz", nil)
	if err != nil {
		return errors.New("invalid readiness probe URL")
	}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("gateway readiness request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return errors.New("gateway is not ready")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		return errors.New("invalid Gateway readiness response")
	}
	var state struct {
		Status string `json:"status"`
		Checks struct {
			Snapshot bool `json:"snapshot"`
			Database bool `json:"database"`
			Redis    bool `json:"redis"`
		} `json:"checks"`
	}
	if json.Unmarshal(body, &state) != nil {
		return errors.New("invalid Gateway readiness response")
	}
	if state.Status != "ready" || !state.Checks.Snapshot || !state.Checks.Database || !state.Checks.Redis {
		return errors.New("gateway dependencies are not ready")
	}
	return nil
}
