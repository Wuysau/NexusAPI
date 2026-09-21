package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestProjectIdentityTypeScriptSignedVector(t *testing.T) {
	raw, err := os.ReadFile("../../tests/contract/fixtures/project-bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector bundleVector
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	verified, err := VerifySnapshotResponse(vector.Envelope, vectorKeyring(t, vector), vector.ExpectedTenant, testNow(t, vector))
	if err != nil {
		t.Fatal(err)
	}
	key := verified.Bundle.Keys[0]
	if key.ProjectID != "project-vector" || key.ProjectName != "Historical A" || key.KeyKind != "shared" || key.PrincipalID != nil || key.AttributionStatus != "attributed" || verified.Bundle.Channels[0].ConnectionID != "connection-vector" {
		t.Fatal("signed historical identity lost")
	}
	var envelope map[string]any
	if err := json.Unmarshal(vector.Envelope, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["bundle"].(map[string]any)["keys"].([]any)[0].(map[string]any)["project_id"] = "project-spoofed"
	altered, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifySnapshotResponse(altered, vectorKeyring(t, vector), vector.ExpectedTenant, testNow(t, vector)); err == nil {
		t.Fatal("modified project accepted")
	}
}
