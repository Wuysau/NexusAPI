package connectorclient

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"strings"
	"time"
)

type CheckStatus string

const (
	CheckOK              CheckStatus = "ok"
	CheckUnavailable     CheckStatus = "unavailable"
	CheckUnauthorized    CheckStatus = "unauthorized"
	CheckInvalidResponse CheckStatus = "invalid_response"
	CheckNotReady        CheckStatus = "not_ready"
	CheckTLSFailed       CheckStatus = "tls_verification_failed"
	CheckTimeout         CheckStatus = "timeout"
	CheckCanceled        CheckStatus = "canceled"
)

type ModelCheck struct {
	ID        string `json:"id"`
	Available bool   `json:"available"`
}

// CheckResult describes service health and local discovery. Authorized routing
// still requires a paired runtime and an actual request with a project API key.
type CheckResult struct {
	ControlPlane CheckStatus  `json:"controlPlane"`
	Gateway      CheckStatus  `json:"gateway"`
	Upstream     CheckStatus  `json:"upstream"`
	Models       []ModelCheck `json:"models"`
	OK           bool         `json:"ok"`
}

func checkFailure(ctx context.Context, err error) CheckStatus {
	var verification *tls.CertificateVerificationError
	if errors.As(err, &verification) {
		return CheckTLSFailed
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return CheckCanceled
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return CheckTimeout
	}
	return CheckUnavailable
}

func checkJSON(ctx context.Context, client *http.Client, request *http.Request, limit int64, out any, health bool) CheckStatus {
	res, err := client.Do(request)
	if err != nil {
		return checkFailure(ctx, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return CheckUnauthorized
	}
	if health && res.StatusCode == http.StatusServiceUnavailable {
		return CheckNotReady
	}
	if res.StatusCode != http.StatusOK {
		return CheckUnavailable
	}
	if err := decodeBoundedJSON(res.Body, limit, out); err != nil {
		if ctx.Err() != nil {
			return checkFailure(ctx, err)
		}
		return CheckInvalidResponse
	}
	return CheckOK
}

func (c *Client) checkHealth(ctx context.Context, gateway bool) CheckStatus {
	origin, path := c.config.ControlURL, "/api/health"
	if gateway {
		origin, path = c.config.GatewayURL, "/readyz"
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(origin, "/")+path, nil)
	if err != nil {
		return CheckUnavailable
	}
	var response struct {
		OK     *bool  `json:"ok"`
		Status string `json:"status"`
	}
	if status := checkJSON(ctx, c.remote, r, 16<<10, &response, true); status != CheckOK {
		return status
	}
	if gateway {
		switch response.Status {
		case "ready":
			return CheckOK
		case "not_ready":
			return CheckNotReady
		default:
			return CheckInvalidResponse
		}
	}
	if response.OK == nil {
		return CheckInvalidResponse
	}
	if !*response.OK {
		return CheckNotReady
	}
	return CheckOK
}

func (c *Client) discoverModels(ctx context.Context) ([]string, CheckStatus) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.config.UpstreamURL, "/")+"/models", nil)
	if err != nil {
		return []string{}, CheckUnavailable
	}
	c.localAuth(r)
	var catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if status := checkJSON(ctx, c.local, r, 1<<20, &catalog, false); status != CheckOK {
		return []string{}, status
	}
	if catalog.Data == nil {
		return []string{}, CheckInvalidResponse
	}
	ready := []string{}
	for _, model := range c.config.Models {
		for _, entry := range catalog.Data {
			if entry.ID == model {
				ready = append(ready, model)
				break
			}
		}
	}
	return ready, CheckOK
}

// Check only sends the three fixed GETs. Health probes have no authorization
// header; the optional upstream credential stays on the private models probe.
func (c *Client) Check(parent context.Context) CheckResult {
	result := CheckResult{Models: make([]ModelCheck, len(c.config.Models))}
	for i, model := range c.config.Models {
		result.Models[i].ID = model
	}
	if parent.Err() != nil {
		status := checkFailure(parent, parent.Err())
		result.ControlPlane, result.Gateway, result.Upstream = status, status, status
		return result
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	type probe struct {
		stage  int
		status CheckStatus
		models []string
	}
	results := make(chan probe, 3)
	go func() { results <- probe{stage: 0, status: c.checkHealth(ctx, false)} }()
	go func() { results <- probe{stage: 1, status: c.checkHealth(ctx, true)} }()
	go func() {
		models, status := c.discoverModels(ctx)
		results <- probe{stage: 2, status: status, models: models}
	}()
	for range 3 {
		value := <-results
		switch value.stage {
		case 0:
			result.ControlPlane = value.status
		case 1:
			result.Gateway = value.status
		case 2:
			result.Upstream = value.status
			available := make(map[string]bool, len(value.models))
			for _, model := range value.models {
				available[model] = true
			}
			for i := range result.Models {
				result.Models[i].Available = available[result.Models[i].ID]
			}
		}
	}
	result.OK = result.ControlPlane == CheckOK && result.Gateway == CheckOK && result.Upstream == CheckOK
	for _, model := range result.Models {
		result.OK = result.OK && model.Available
	}
	return result
}
