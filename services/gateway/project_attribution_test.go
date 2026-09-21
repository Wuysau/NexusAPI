package main

import "testing"

func TestIdentityCarriesFrozenProjectAttribution(t *testing.T) {
	identity := &Identity{
		TenantID:       "tenant-a",
		OrganizationID: "org-a",
		KeyID:          "key-a",
		ProjectID:      "project-a",
		ProjectName:    "Project A",
		ConnectionID:   "connection-a",
		ExecutionMode:  "byok",
	}
	if identity.ProjectID != "project-a" || identity.ProjectName != "Project A" || identity.ConnectionID != "connection-a" || identity.ExecutionMode != "byok" {
		t.Fatalf("project attribution was not frozen: %+v", identity)
	}
}
