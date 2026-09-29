package main

import (
	"context"
	"sync"
	"time"
)

const (
	catalogTimeout     = 5 * time.Second
	catalogConcurrency = 4
	catalogBatchSize   = 64
)

// AvailableModels authorizes one bounded catalog batch. A grant is valid only
// for this request, identity, channel, and current connector session.
func (h *ConnectorHub) AvailableModels(ctx context.Context, channel *SnapshotChannel, identity *Identity, requested []string) *connectorGrant {
	if h == nil || channel == nil || identity == nil || len(requested) == 0 || len(requested) > catalogBatchSize ||
		identity.TenantID == "" || identity.ProjectID == "" || identity.OrganizationID == "" || identity.KeyID == "" ||
		channel.ID == "" || channel.ConnectionID == "" || channel.TenantID != identity.TenantID || channel.ProjectID != identity.ProjectID {
		return nil
	}
	session := h.session(channel)
	if session == nil || session.grant.LeaseID == "" || session.grant.ConnectorID == "" {
		return nil
	}
	input := connectorInput(session, channel, identity, "", ScopeModelsRead)
	input.RequestedModels = requested
	grant, err := h.authorize(ctx, input)
	if err != nil || ctx.Err() != nil || grant.LeaseID != session.grant.LeaseID || grant.ConnectorID != session.grant.ConnectorID ||
		grant.ConnectionID != channel.ConnectionID || grant.TenantID != identity.TenantID {
		return nil
	}
	current := h.session(channel)
	if current == nil || current.token != session.token {
		return nil
	}
	returned := make(map[string]bool, len(grant.Models))
	for _, model := range grant.Models {
		returned[model] = true
	}
	models := make([]string, 0, len(requested))
	for _, model := range requested {
		if returned[model] {
			models = append(models, model)
			delete(returned, model)
		}
	}
	grant.Models = models
	return grant
}

type catalogGroup struct {
	channel *SnapshotChannel
	models  []string
	seen    map[string]bool
}

type catalogBatch struct {
	channel *SnapshotChannel
	models  []string
}

func (p *Proxy) catalogAvailability(ctx context.Context, bundle *GatewayBundle, identity *Identity) map[string]bool {
	available := make(map[string]bool)
	connectorModels := make(map[string]bool)
	for _, channel := range bundle.Channels {
		if channel.Transport == "local_sidecar" {
			for _, model := range channel.Models {
				connectorModels[model] = true
			}
		}
	}
	var groups []catalogGroup
	groupIndex := make(map[[2]string]int)
	for _, model := range bundle.Models {
		if model.Status != "" && model.Status != "active" {
			continue
		}
		if !connectorModels[model.ID] {
			// Preserve the existing direct-provider snapshot catalog behavior.
			available[model.ID] = true
			continue
		}
		candidates, _ := p.router.Select(bundle, RouteRequest{TenantID: identity.TenantID, ProjectID: identity.ProjectID, ResolvedModel: model.ID, RequiredCapabilities: RequiredCapabilitiesForChat()})
		for _, candidate := range candidates {
			if candidate.Channel.Transport != "local_sidecar" {
				available[model.ID] = true
				break
			}
		}
		if available[model.ID] {
			continue
		}
		for _, candidate := range candidates {
			channel := candidate.Channel
			key := [2]string{channel.ID, channel.ConnectionID}
			index, exists := groupIndex[key]
			if !exists {
				index = len(groups)
				groupIndex[key] = index
				groups = append(groups, catalogGroup{channel: channel, seen: make(map[string]bool)})
			}
			group := &groups[index]
			if !group.seen[model.ID] {
				group.models = append(group.models, model.ID)
				group.seen[model.ID] = true
			}
		}
	}
	var batches []catalogBatch
	for _, group := range groups {
		for offset := 0; offset < len(group.models); offset += catalogBatchSize {
			batches = append(batches, catalogBatch{channel: group.channel, models: group.models[offset:min(offset+catalogBatchSize, len(group.models))]})
		}
	}
	jobs := make(chan catalogBatch)
	var workers sync.WaitGroup
	var mu sync.Mutex
	verifiedUntil := make(map[string]time.Time)
	for range min(catalogConcurrency, len(batches)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for batch := range jobs {
				if ctx.Err() != nil {
					return
				}
				grant := p.connectors.AvailableModels(ctx, batch.channel, identity, batch.models)
				if grant == nil {
					continue
				}
				mu.Lock()
				for _, model := range grant.Models {
					if grant.ExpiresAt.After(verifiedUntil[model]) {
						verifiedUntil[model] = grant.ExpiresAt
					}
				}
				mu.Unlock()
			}
		}()
	}
dispatch:
	for _, batch := range batches {
		select {
		case jobs <- batch:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(jobs)
	workers.Wait()
	for model, expiresAt := range verifiedUntil {
		if time.Now().Before(expiresAt) {
			available[model] = true
		}
	}
	return available
}
