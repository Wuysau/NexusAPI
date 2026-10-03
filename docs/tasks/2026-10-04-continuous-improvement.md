# Continuous autonomous maintenance

User authorization: continue inspect → characterize → minimal design → implement → test → review → commit → re-audit until an actual hard stop. Use normal main/post-commit auto-sync. Preserve execution-plane, credential, tenant/project, unknown-value, no-replay and immutable-accounting boundaries. Never operate production accounts/databases to manufacture acceptance.

## Current state

- Starting HEAD/main/origin: `5e73d1b5588f420a6c0d5b816c4c3f6c7f920724`; checkout initially clean. Prior project diagnostics and published manual are complete.
- Hosted CI `37152432079`: **FAIL**, Integration now **PASS**. Install/format/lint/typecheck/unit/contract/migration/integration/security/audit/secrets/Control Plane/services/Compose passed. Go gate failed before race during the actual health fixture executable build: `error obtaining VCS status: exit status 128`. Later images/Vault/E2E/SBOM were skipped.
- Prior local equivalent acceptance: unit754, contract391, integration582, security49, migration32, E2E15, Vault73, Linux race2359/0skip, four images, standalone startup/PG health, SBOM602 and production audit0. Native Windows race remains unverified because cgo is unavailable. These are prior facts, not a claim that hosted baseline is healthy.
- Active checkout: `codex/continuous-maintenance`, based on the starting main; existing hook merges each complete commit to main and pushes normally. Parallel characterization files are excluded from commits until verified.
- C01 submitted as topic `84b5984`, merged/pushed main `fe0661f`; hosted CI `37154185749` **SUCCESS**: complete format/lint/typecheck/unit/contract/migration/integration/security/build/services/Compose/Go/four images/Vault/E2E/SBOM chain. Repository-level baseline is now accepted on that exact main revision.
- Current topic `1c0781b`, main/origin `d7ce3a9`: C09 preview, C08 visibility, C06 policy commit, C05 commands and C07 ACK independently committed/merged/pushed through the normal hook. Exact hosted C08 `37159140167` SUCCESS; Pages `37159139572` SUCCESS. C09 `37160227338` in progress. Superseded pending runs cancel normally. Prior C04 `37156131886` FAIL retained one ACK leaf plus parents; C07 diagnoses/fixes it with full local Go acceptance. New revisions need their own hosted acceptance. Original complete accepted receipts match `fe0661f`, unit754/contract391/migration32/integration581/security49/Go2359/Vault73/E2E15, zero fail/skip. Linux integration has one fewer declared platform case than Windows (prior-PID workspace-alias case).
- Latest periodic checkpoint matches committed C09 source:unit754/contract391/Integration658 (60files,267s)/security49, zero fail/skip;915 source hashes stable. Compiler/lint/format and independent review passed. An unsupported coordinator security label was corrected without rerunning the first three passing gates; all original and continued receipts retained.
- Existing test PG/Redis are loopback disposable containers; verify exact URL and `current_database()` before resetting any named fixture. Ordinary databases/containers remain untouched.

## Current work and next candidates

| Priority | Item | Evidence / next action |
| --- | --- | --- |
| P0 resolved | Linux CI health fixture build cannot inspect VCS | C01 local proof and exact-revision complete hosted CI passed. |
| P0 fixed locally, committed | HTTP2 finite-error acknowledgment fixture races client cleanup | C07 topicf3f43f4/main0f8c727; schedulingOLDRED→observedGREEN/unobservedRED; unchanged transportACK850/fullconnector235/fullGo2359 race pass, lint0, actual Budget/Worker/health;331 relevant inputs stable, production unchanged. |
| P1 resolved | Inactive user retains existing session authority | C02 fixed/verified/reviewed below; submitting independently after full baseline acceptance. |
| P1 resolved | Project Key issuance lifecycle | C03 fixed/verified/reviewed below; independent submission. No execution or billing exploit claimed. |
| P1 resolved | Connection authority changes while request body is read | C04 fixed/reviewed, native12 GREEN plus full periodic checkpoint below; submitting independently. |
| P1 committed | Task action authority changes during body read | C05 topic90a3eac/main8e0b551; nativeOLD8RED10controls twice →18GREEN, related41 pass, total59. Production transaction and manual complete. |
| P1 committed | Task policy authorization changes before UPSERT commits | C06 topic0bcc33a/main53f91d8; nativeOLD3RED5controls→8GREEN, related52 pass. Same transaction orders authorized commit before concurrent demotion/archive. |
| P1 committed | Task policy bypasses unbound resource ownership | C08 topic1fd4cb5/mainf90853a; actualOLD3RED/5controls twice→8GREEN, related37 pass. Shared HTTP batch visibility; trusted local runtime and historical policy preserved. |
| P1 committed | Policy preview retains cached admin privilege during body read | C09 topic1c0781b/maind7ce3a9; nativeOLD4RED/10controls twice→14GREEN, full periodic checkpoint passed. Use management helper's current role for visibility. |
| P1 verified, submitting | Connector pairing/rotation caches admin authority | C10 nativeOLD2RED/6controls twice→8GREEN. Current owner/admin checked with transaction authority locks, recent-auth and connection-first order retained. Existing configuration10/formal8/real TLS Gateway+CLI19 all pass, stable565 inputs and closed fixtures. |
| P1 characterizing | Connection heartbeat retains cached role | R56 covers project-membership withdrawal, not organization demotion. Ignored native round74 investigates current capability and Connection visibility; no production changes yet. |
| P2 | Gateway semantic loss | Pure HTTP OLD: nested assistant audio silently dispatches, Anthropic unknown finish becomes completed, Gemini filtered/malformed finish becomes stop. Implement independent protocol fixes after higher-priority security. |

## Completed rounds

### C01 — Docker build trusts only its mounted checkout

Root cause: hosted runner UID1001 owns `/repo`; pinned Go container runs as root, so Git reports dubious ownership and Go cannot obtain VCS status. OLD reproduces Git128 and Go build1 on a disposable UID-owned copy of exact HEAD. Fix passes only `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=/repo` into that disposable Go container. No wildcard trust, host Git configuration change or disabled VCS stamping. GREEN builds successfully and retains the actual revision; a separate UID-owned `/other-repo` still fails Git128.

Full supported local Go gate:2359 pass/0fail/0skip, lint0issues, actual storage200→500→200 and Budget/Worker idempotent replay pass. Relevant CI contracts16/3files, syntax/format/diff pass. During the broad receipt a separate next-round TypeScript regression was added; Go/scripts were not changed after the gate started. Hosted CI after submission remains the repository-level acceptance checkpoint. Evidence: ignored `.test-artifacts/hosted-go-37152432079`.

### C02 — Existing sessions require an active user

Native OLD:5 failures/7 compatibility controls passed. Suspended/invited/deleted users retain project read/write through old sessions, despite fresh login already refusing them; suspended/invited users also rotate the token. Fix joins users in the existing session lookup and requires active/nondeleted, retaining constant-time comparison, expiry, revocation, membership and CSRF checks. No extra query, migration or Gateway Key lifecycle change. Unchanged native GREEN:12 pass/0fail/0skip; related auth/RBAC/security/contracts57/4files pass. Compiler, scoped lint/format and independent review pass. Manual documents the behavior. Guarantee is eligibility at authentication read; no transaction-wide cancellation or permanent revocation on reversible status change is claimed. Details: `2026-10-04-active-user-session.md`.

### C03 — Atomic project Key issuance

Native OLD3 failures/1 control prove publication before mandatory audit, orphan Key on binding/audit failure and false success audit on binding failure. Fix performs project binding and expiry plus mandatory redacted audit on the existing Key transaction client before COMMIT; route no longer binds afterward. Existing no-project/null/empty-string behavior and exact audit metadata remain intact. Unchanged native GREEN4/0fail/0skip; related Key scope/snapshot/auth/security82/5files pass with stable input hashes and closed clients. Compiler, scoped lint/format, independent review pass. Operations guide documents atomic issuance. No migration, repository expansion or Gateway hot-path change. Details: `2026-10-04-atomic-project-key.md`.

### C04 — Current membership authority for project connection writes

Native valid OLD2 failures/7 controls prove delayed unbind succeeds after admin demotion/removal. Fix preserves connection-first locking, reuses current workspace role plus source visibility, checks ownership/admin against that live role and holds membership/organization locks until COMMIT. Target still uses active quota eligibility; archived source recovery and immutable usage remain intact. Original9 GREEN, plus developer/archived source/archived target controls:12 pass/0fail/0skip. The existing unit query fixture now supplies live role without relaxing assertions. Compiler, scoped lint/format and independent review pass; manual updated. Periodic checkpoint:unit754/contract391/security49/Integration610 (56files,255s), all zero fail/skip. Evidence: ignored delta-verification plus cp-scope-audit. Details: `2026-10-04-connection-project-authority.md`.

### C07 — HTTP/2 ACK fixture accepts only observed peer cancellation

Latest C04 hosted Go failure is one finite-error leaf plus its two parent counts. Legal response HEADERS→client Body.Close/RST_STREAM→server DATA Flush ordering violates the fixture's unconditional success assertion. Unmodified local OLD100 iterations pass, so that is not falsely claimed as reproduction. Same retained standard-library scheduling overlay proves OLDRED, observed-ACK GREEN and remove-observation RED. Transparent real-TLS transport observer and idle cleanup validate actual expected status/protocol/TLS before accepting cancellation; live/unobserved/mismatched Flush errors still fail. Original worker bounds, upload framing, credential and no-replay assertions remain intact. Production Go unchanged. RealACK850/fullconnector235 race pass; fullGo2359/0fail/0skip/lint0 and actual storage/Budget/Worker replay pass,331 relevant inputs stable,288 seconds. Details: `2026-10-04-ack-fixture-cancellation.md`.

### C05 — Current project authority for queued Task commands

Native OLD twice:8 failures/10 controls. Resume/switch retain stale scope while reading body, allowing demoted/removed members or archived projects to queue commands. A shared transaction rechecks and locks current project authority, executes the existing command CAS on that client, then commits. Same native18 GREEN plus real routes11/store2/supervisor28:59 pass/0fail/0skip, stable input hashes and closed fixture clients. Compiler, scoped lint/format and independent review pass; manual distinguishes command acceptance from execution. Trusted local CLI/store and supervisor authority stay unchanged. Details: `2026-10-04-task-command-authority.md`.

### C06 — Lock project authority until Task policy commit

Native OLD3 failures/5 controls proves concurrent demotion/project removal/archive commits while an unlocked policy UPSERT waits. Reuse the shared project-write transaction for savePolicy on one client; already-authorized policy commits before the concurrent authority writer. Unchanged8 GREEN plus routes11/store2/router39:60 pass/0fail/0skip, stable related input hashes and closed fixture clients. Compiler, lint/format and independent final review pass; manual updated. Candidate ownership and audit atomicity remain separate boundaries. Details: `2026-10-04-task-policy-authority.md`.

### C08 — Task HTTP candidates respect Connection visibility

Native OLD twice:3 failures/5 controls, independently contrasted with Connection list and quotaGET404. One shared batch visibility helper uses fresh project role for GET and locked role for PUT. Reject hidden candidates before policy mutation/audit, omit their live resource facts and retain historical policy. Unchanged8 GREEN plus C05 commands18/C06 policy8/Task routes11:45 pass/0fail/0skip, stable scoped hashes/closed fixtures. Compiler, scoped lint/format and independent review pass; manual updated. Trusted runtime and concurrent Connection lifecycle locking remain separate. Details: `2026-10-04-task-resource-visibility.md`.

### C09 — Project preview uses current resource privileges

Native OLD twice:4 failures/10 controls proves delayed admin demotion still exposes hidden unbound/private-project connections despite retained legitimate selected-project membership. Two-line fix uses resolveManagedProject's current role only for resource query parameters; original audit/auth/archive/response behavior remains. Unchanged14 GREEN; nonempty history/domain facts and denial audit counts unchanged. Compiler/lint/format/review and full periodic checkpoint pass;915 entire-source hashes stable across unit754/contract391/Integration658/security49, zero fail/skip. No new query/lock or Gateway change. Manual updated. Details: `2026-10-04-policy-preview-authority.md`.

### C10 — Connector pairing retains current administrative authority

Native OLD twice:2 failures/6 controls. Delayed admin→project-member developer still issues initial token or rotates existing synthetic identity/lease. Existing transaction now locks current membership/organization and requires owner/admin before mutations, retaining Connection-first order and recent-auth. Same native8 GREEN with complete denial facts/audits unchanged, compiler/lint/format/secrets and independent review pass. Existing configuration10/formal8/real TLS Gateway+CLI19 pass, stable565 inputs and closed fixtures. Windows cache-directory omission in the ignored runner was classified and corrected before one actual local run; skipped setup failure does not count as acceptance. Details: `2026-10-04-connector-pairing-authority.md`.

## Verification and decisions

Receipts go into ignored `.test-artifacts/continuous-maintenance/`. Do not copy fixture secret custody into public evidence. Use targeted regression/compiler/format/lint before each commit, broad checkpoints after several rounds and complete relevant verification for Gateway or architecture changes. Update this concise file after meaningful checkpoints; prior detailed evidence remains in its original task documents.
