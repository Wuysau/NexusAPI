package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConnectorProductionDeployment(t *testing.T) {
	vars := map[string]string{"GATEWAY_REPLICAS": "1", "GATEWAY_TLS_CERT": "cert.pem", "GATEWAY_TLS_KEY": "key.pem"}
	get := func(k string) string { return vars[k] }
	env := &Env{Environment: "production", ControlPlaneURL: "https://control.example.com"}
	if err := validateConnectorDeployment(env, get); err != nil {
		t.Fatal(err)
	}
	env.ControlPlaneURL = "http://control.example.com"
	if validateConnectorDeployment(env, get) == nil {
		t.Fatal("plaintext control-plane credential transport accepted")
	}
	env.ControlPlaneURL = "https://control.example.com"
	for _, key := range []string{"GATEWAY_REPLICAS", "GATEWAY_TLS_CERT", "GATEWAY_TLS_KEY"} {
		old := vars[key]
		vars[key] = ""
		if validateConnectorDeployment(env, get) == nil {
			t.Fatalf("missing %s accepted", key)
		}
		vars[key] = old
	}
	vars["GATEWAY_REPLICAS"] = "2"
	if validateConnectorDeployment(env, get) == nil {
		t.Fatal("multiple replicas accepted")
	}
}

func TestConnectorUploadExtendsOrdinaryBodyDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pr, pw := io.Pipe()
	defer pr.Close()
	job := &connectorJob{Deadline: time.Now().Add(time.Second), ctx: ctx, cancel: cancel, reader: pr, writer: pw, response: make(chan *http.Response, 1)}
	hub := NewConnectorHub("", "")
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hub.result(w, r, job) }))
	server.Config.ReadTimeout = 30 * time.Millisecond
	server.Start()
	defer server.Close()
	uploadR, uploadW := io.Pipe()
	defer uploadR.Close()
	go func() {
		defer uploadW.Close()
		encoder := json.NewEncoder(uploadW)
		_ = encoder.Encode(connectorFrame{Type: "meta", Status: 200})
		time.Sleep(90 * time.Millisecond)
		_ = encoder.Encode(connectorFrame{Type: "data", Data: []byte("data: ok\n\n")})
		_ = encoder.Encode(connectorFrame{Type: "end"})
	}()
	received := make(chan string, 1)
	go func() {
		select {
		case res := <-job.response:
			b, _ := io.ReadAll(res.Body)
			received <- string(b)
		case <-ctx.Done():
			received <- "cancelled"
		}
	}()
	req, _ := http.NewRequestWithContext(ctx, "POST", server.URL, uploadR)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("upload truncated: %d", res.StatusCode)
	}
	if got := <-received; got != "data: ok\n\n" {
		t.Fatalf("body %q", got)
	}
}

func TestConnectorUploadFailureBeforeMetadataCancelsImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer pr.Close()
	job := &connectorJob{Deadline: time.Now().Add(time.Second), ctx: ctx, cancel: cancel, reader: pr, writer: pw, response: make(chan *http.Response, 1)}
	hub := NewConnectorHub("", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hub.result(w, r, job) }))
	defer server.Close()
	res, err := http.Post(server.URL, "application/x-ndjson", strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	select {
	case <-ctx.Done():
	case <-time.After(200 * time.Millisecond):
		t.Fatal("empty result kept caller waiting")
	}
}
