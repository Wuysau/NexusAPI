package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The explicit runner prepares only the dedicated 28-migration fixture and
// builds production main. These requests never use an in-process Proxy/Store.
func TestStoreHealthRecoveryPostgres(t *testing.T) {
	dsn := os.Getenv("GATEWAY_HEALTH_RECOVERY_DATABASE_URL")
	binary := os.Getenv("GATEWAY_HEALTH_RECOVERY_BINARY")
	if dsn == "" || binary == "" {
		t.Skip("explicit dedicated PostgreSQL fixture and Gateway executable required")
	}
	info, binaryErr := os.Stat(binary)
	if !filepath.IsAbs(binary) || binaryErr != nil || !info.Mode().IsRegular() {
		t.Fatal("explicit absolute Gateway executable required")
	}
	artifactDir := os.Getenv("GATEWAY_HEALTH_RECOVERY_ARTIFACT_DIR")
	prefix := os.Getenv("GATEWAY_HEALTH_RECOVERY_ARTIFACT_PREFIX")
	if artifactDir != "" && (prefix == "" || strings.ContainsAny(prefix, "/\\.")) {
		t.Fatal("safe unique artifact prefix required")
	}
	u, err := url.Parse(dsn)
	if err != nil || strings.ContainsAny(dsn, "?#") || u.Scheme != "postgresql" ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Port() != "55439" ||
		u.Path != "/gateway_test_health_recovery_round57" {
		t.Fatal("exact dedicated PostgreSQL fixture required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("dedicated database connection failed")
	}
	t.Cleanup(func() {
		closeCtx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		if db.Close(closeCtx) != nil {
			t.Error("dedicated database close failed")
		}
	})
	var current string
	var migrations int
	if db.QueryRow(ctx, "SELECT current_database()").Scan(&current) != nil || current != "gateway_test_health_recovery_round57" {
		t.Fatal("dedicated database identity mismatch")
	}
	if db.QueryRow(ctx, "SELECT count(*) FROM drizzle.__drizzle_migrations").Scan(&migrations) != nil || migrations != 28 {
		t.Fatal("28 canonical migrations required")
	}
	execute := func(sql string) {
		t.Helper()
		if _, e := db.Exec(ctx, sql); e != nil {
			t.Fatal("fixture SQL operation failed")
		}
	}
	var upstreamCalls, budgetCalls, credentialCalls atomic.Int64
	h := newHarness(t, harnessOptions{UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" || r.Header.Get("authorization") != "Bearer upstream-test-secret" {
			http.Error(w, "fixed fixture upstream rejection", http.StatusBadRequest)
			return
		}
		defaultUpstreamHandler()(w, r)
	}})
	h.server.Close() // The harness Gateway is unused; all calls target the executable below.
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer round57-control-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/internal/gateway/snapshot":
			body, e := h.source.Fetch(r.Context(), r.URL.Query().Get("tenant_id"))
			if e != nil {
				http.Error(w, "unavailable", 503)
				return
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write(body)
		case "/api/internal/gateway/credential":
			credentialCalls.Add(1)
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"secret": "upstream-test-secret", "credential_id": "cred_test", "fingerprint": "fixture"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(cp.Close)
	budget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/reservations" || r.Header.Get("authorization") != "Bearer round57-budget-token" {
			http.Error(w, "unauthorized", 401)
			return
		}
		var in ReserveRequest
		if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in) != nil || in.RequestID == "" || in.TenantID != testTenantID || in.Currency != "USD" {
			http.Error(w, "invalid fixture authorization", 400)
			return
		}
		budgetCalls.Add(1)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"replayed": false, "reservation_id": "resv_" + in.RequestID, "amount_micros": "1000", "currency": "USD", "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)})
	}))
	t.Cleanup(budget.Close)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("native listener reservation failed")
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	command := exec.Command(binary)
	command.Env = []string{
		"GATEWAY_ENV=test", "GATEWAY_ADDR=" + addr, "DATABASE_URL=" + dsn,
		"CONTROL_PLANE_URL=" + cp.URL, "GATEWAY_INTERNAL_TOKEN=round57-control-token",
		"SNAPSHOT_SIGNING_KEY=harness-passphrase", "BUDGET_SERVICE_URL=" + budget.URL,
		"BUDGET_SERVICE_TOKEN=round57-budget-token", "GATEWAY_OTEL_DISABLED=true",
		"GATEWAY_SNAPSHOT_REFRESH_SECONDS=1", "GATEWAY_TOTAL_TIMEOUT_SECONDS=8",
	}
	for _, key := range []string{"PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "ComSpec"} {
		if value := os.Getenv(key); value != "" {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	var logs storeHealthProcessLog
	command.Stdout, command.Stderr = &logs, &logs
	if command.Start() != nil {
		t.Fatal("native Gateway start failed")
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var stopOnce sync.Once
	joined := false
	stop := func() {
		stopOnce.Do(func() {
			if runtime.GOOS != "windows" {
				_ = command.Process.Signal(os.Interrupt)
			} else {
				_ = command.Process.Kill()
			}
			select {
			case <-done:
				joined = true
			case <-time.After(3 * time.Second):
				_ = command.Process.Kill()
				select {
				case <-done:
					joined = true
				case <-time.After(3 * time.Second):
					t.Error("native Gateway final join timed out")
				}
			}
			safe := logs.String()
			privateValues := []string{dsn, testAPIKey, "upstream-test-secret", "round57-control-token", "round57-budget-token", "harness-passphrase"}
			if u.User != nil {
				if p, ok := u.User.Password(); ok {
					privateValues = append(privateValues, p)
				}
			}
			for _, value := range privateValues {
				if value != "" {
					safe = strings.ReplaceAll(safe, value, "<fixture-private>")
				}
			}
			if artifactDir != "" {
				if e := os.WriteFile(filepath.Join(artifactDir, prefix+"-native-sanitized.log"), []byte(safe), 0600); e != nil {
					t.Error("sanitized native log save failed")
				}
			}
		})
	}
	t.Cleanup(stop)
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	t.Cleanup(client.CloseIdleConnections)
	base := "http://" + addr
	readiness := func() bool {
		response, e := client.Get(base + "/readyz")
		if e != nil {
			return false
		}
		defer response.Body.Close()
		var value struct {
			Status string          `json:"status"`
			Checks map[string]bool `json:"checks"`
		}
		e = json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&value)
		return e == nil && response.StatusCode == 200 && value.Status == "ready" && value.Checks["database"] && value.Checks["snapshot"]
	}
	deadline := time.Now().Add(5 * time.Second)
	for !readiness() {
		if time.Now().After(deadline) {
			t.Fatal("native Gateway setup did not become ready")
		}
		time.Sleep(25 * time.Millisecond)
	}
	type result struct {
		Status int
		Code   string
		ID     string
	}
	chat := func() result {
		request, _ := http.NewRequest(http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(chatBody(chatBodyOptions{MaxTokens: 20})))
		request.Header.Set("authorization", "Bearer "+testAPIKey)
		request.Header.Set("content-type", "application/json")
		response, e := client.Do(request)
		if e != nil {
			t.Fatal("native Chat transport failed")
		}
		defer response.Body.Close()
		var value struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&value) != nil {
			t.Fatal("native Chat JSON response invalid")
		}
		return result{response.StatusCode, value.Error.Code, response.Header.Get("x-request-id")}
	}
	counts := func() [5]int64 {
		var values [5]int64
		if db.QueryRow(ctx, `SELECT (SELECT count(*) FROM request_records),(SELECT count(*) FROM attempts),(SELECT count(*) FROM outbox_events),(SELECT count(*) FROM usage_records),(SELECT count(*) FROM ledger_transactions)`).Scan(&values[0], &values[1], &values[2], &values[3], &values[4]) != nil {
			t.Fatal("durable fixture count query failed")
		}
		return values
	}
	completedFact := func(id string) *UsageEvent {
		t.Helper()
		var payload []byte
		var input, output, attemptInput, attemptOutput, attemptNumber int
		var reservation, charge int64
		var status, kind, tenant, key, price, sale, attemptID, attemptStatus, providerID, channelID, eventType string
		err := db.QueryRow(ctx, `SELECT r.status,r.channel_kind,r.tenant_id,r.downstream_key_id,
r.provider_price_version_id,r.sale_price_snapshot_id,r.input_tokens,r.output_tokens,r.reservation_amount,r.charge_amount,
a.id,a.status,a.provider_id,a.channel_id,a.attempt_number,a.input_tokens,a.output_tokens,o.event_type,o.payload
FROM request_records r JOIN attempts a ON a.request_id=r.id JOIN outbox_events o ON o.aggregate_id=r.id
WHERE r.id=$1`, id).Scan(&status, &kind, &tenant, &key, &price, &sale, &input, &output, &reservation, &charge,
			&attemptID, &attemptStatus, &providerID, &channelID, &attemptNumber, &attemptInput, &attemptOutput, &eventType, &payload)
		if err != nil || status != "completed" || kind != "platform" || tenant != testTenantID || key != testKeyID ||
			price != testPriceID || sale != "sale-fixture" || input != 11 || output != 4 || reservation != 1000 || charge != 0 ||
			attemptStatus != "completed" || providerID != "prov_openai" || channelID != "chan_test_1" || attemptNumber != 1 ||
			attemptInput != 11 || attemptOutput != 4 || eventType != "usage.completed" {
			t.Fatal("completed request/attempt/outbox projection mismatch")
		}
		var event UsageEvent
		if json.Unmarshal(payload, &event) != nil || event.Validate() != nil || event.RequestID != id || event.AttemptID != attemptID ||
			event.TenantID != testTenantID || event.Status != "completed" || event.ModelID != testModel || event.PriceVersionID != testPriceID ||
			event.CatalogVersionID != testCatalogID || event.Usage.InputTokens != 11 || event.Usage.OutputTokens != 4 || event.Usage.Estimated {
			t.Fatal("completed outbox identity and observed usage mismatch")
		}
		// Zero charge here is pending Worker authority, not a statement that the call is free.
		return &event
	}
	initial := chat()
	if initial.Status != 200 || upstreamCalls.Load() != 1 || budgetCalls.Load() != 1 || credentialCalls.Load() != 1 || counts() != [5]int64{1, 1, 1, 0, 0} {
		t.Fatal("initial native managed execution control failed; exclude from defect evidence")
	}
	initialFact := completedFact(initial.ID)
	execute(`CREATE FUNCTION round57_fail_completed_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'round57_fixture_commit_fault' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER round57_completed_commit_fault AFTER INSERT OR UPDATE ON request_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION round57_fail_completed_commit();`)
	t.Cleanup(func() {
		cleanupCtx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		if _, e := db.Exec(cleanupCtx, "DROP TRIGGER IF EXISTS round57_completed_commit_fault ON request_records; DROP FUNCTION IF EXISTS round57_fail_completed_commit()"); e != nil {
			t.Error("fixture Commit fault cleanup failed")
		}
	})
	failed := chat()
	if failed.Status != 500 || failed.Code != CodeInternal || failed.ID == initial.ID || upstreamCalls.Load() != 2 || budgetCalls.Load() != 2 || counts() != [5]int64{1, 1, 1, 0, 0} {
		t.Fatal("deferred terminal Commit fault did not reach intended native boundary")
	}
	execute("DROP TRIGGER round57_completed_commit_fault ON request_records; DROP FUNCTION round57_fail_completed_commit()")
	if db.Ping(ctx) != nil {
		t.Fatal("post-fault database recovery control failed")
	}
	// Observe bounded recovery without issuing any readiness request or retrying
	// an executed operation. Each storage rejection is a new request and must
	// add no Budget authorization, upstream execution or durable fact.
	// A change that updates admission only from public readiness Ping cannot pass.
	recoveryDeadline := time.Now().Add(4 * time.Second)
	seen := map[string]bool{initial.ID: true, failed.ID: true}
	var recovered result
	recoveryChecks := 0
	for {
		recovered = chat()
		recoveryChecks++
		if seen[recovered.ID] || !strings.HasPrefix(recovered.ID, "req_") {
			t.Fatal("recovery observation reused a server request identity")
		}
		seen[recovered.ID] = true
		if recovered.Status == 200 {
			break
		}
		if recovered.Status != 503 || recovered.Code != CodeStorageUnavailable {
			t.Fatal("unexpected recovery observation failure")
		}
		if upstreamCalls.Load() != 2 || budgetCalls.Load() != 2 || counts() != [5]int64{1, 1, 1, 0, 0} {
			t.Fatal("storage rejection replayed execution or changed durable facts")
		}
		if time.Now().After(recoveryDeadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	after := counts()
	if !readiness() {
		t.Fatal("native readiness after recovery observation failed")
	}
	if recovered.ID == failed.ID || recovered.ID == initial.ID || !strings.HasPrefix(recovered.ID, "req_") {
		t.Fatal("recovery request is not a new server-owned identity")
	}
	stop()
	if !joined {
		t.Fatal("native Gateway process did not join")
	}
	if !strings.Contains(logs.String(), "commit: ERROR: round57_fixture_commit_fault") {
		t.Fatal("native Gateway log did not prove Commit-phase fault")
	}
	var failedFacts bool
	if db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM request_records WHERE id=$1)
OR EXISTS(SELECT 1 FROM attempts WHERE request_id=$1)
OR EXISTS(SELECT 1 FROM outbox_events WHERE aggregate_id=$1)`, failed.ID).Scan(&failedFacts) != nil || failedFacts {
		t.Fatal("failed terminal transaction left facts or was replayed")
	}
	if completedFact(initial.ID).EventID != initialFact.EventID {
		t.Fatal("initial committed event was replaced during recovery")
	}
	report := map[string]any{
		"initialStatus": initial.Status, "failedStatus": failed.Status, "failedCode": failed.Code,
		"recoveryStatus": recovered.Status, "recoveryCode": recovered.Code, "databasePingAfterFaultDrop": true,
		"nativeReadinessAfterFaultDrop": true, "distinctServerRequestIDs": true, "upstreamCalls": upstreamCalls.Load(),
		"readinessQueriedOnlyAfterRecoveryRequest": true,
		"recoveryChecks":           recoveryChecks,
		"budgetAuthorizationCalls": budgetCalls.Load(), "durableRequests": after[0], "durableAttempts": after[1],
		"durableOutboxes": after[2], "usageRecords": after[3], "ledgerTransactions": after[4],
		"firstFailedOperationNotReplayed": true, "nativeProcessJoined": true,
		"budgetScope": "synthetic HTTP authorization; no real financial hold or Worker settlement claimed",
	}
	raw, _ := json.MarshalIndent(report, "", "  ")
	if artifactDir != "" {
		if os.WriteFile(filepath.Join(artifactDir, prefix+"-report.json"), raw, 0600) != nil {
			t.Fatal("safe report save failed")
		}
	}
	t.Logf("native evidence: initial=%d fault=%d/%s recovered=%d/%s calls=%d budget=%d facts=%v processJoined=true", initial.Status, failed.Status, failed.Code, recovered.Status, recovered.Code, upstreamCalls.Load(), budgetCalls.Load(), after)
	if recovered.Status != 200 {
		t.Fatalf("desired managed recovery after dropped Commit fault: status=%d code=%s; want 200", recovered.Status, recovered.Code)
	}
	if upstreamCalls.Load() != 3 || budgetCalls.Load() != 3 || after != [5]int64{2, 2, 2, 0, 0} {
		t.Fatalf("recovered execution cardinality mismatch: calls=%d budget=%d facts=%v", upstreamCalls.Load(), budgetCalls.Load(), after)
	}
	if completedFact(recovered.ID).EventID == initialFact.EventID {
		t.Fatal("independent recovered operation reused the initial event identity")
	}
}

// Subprocess pipes may continue writing while failure cleanup collects logs.
type storeHealthProcessLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *storeHealthProcessLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.Write(p)
}

func (l *storeHealthProcessLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.String()
}
