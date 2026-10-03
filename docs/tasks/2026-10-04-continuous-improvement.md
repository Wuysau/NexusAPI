# Continuous autonomous maintenance

User authorization: continue inspect → characterize → minimal design → implement → test → review → commit → re-audit until an actual hard stop. Use normal main/post-commit auto-sync. Preserve execution-plane, credential, tenant/project, unknown-value, no-replay and immutable-accounting boundaries. Never operate production accounts/databases to manufacture acceptance.

## Current state

- Starting HEAD/main/origin: `5e73d1b5588f420a6c0d5b816c4c3f6c7f920724`; checkout initially clean. Prior project diagnostics and published manual are complete.
- Hosted CI `37152432079`: **FAIL**, Integration now **PASS**. Install/format/lint/typecheck/unit/contract/migration/integration/security/audit/secrets/Control Plane/services/Compose passed. Go gate failed before race during the actual health fixture executable build: `error obtaining VCS status: exit status 128`. Later images/Vault/E2E/SBOM were skipped.
- Prior local equivalent acceptance: unit754, contract391, integration582, security49, migration32, E2E15, Vault73, Linux race2359/0skip, four images, standalone startup/PG health, SBOM602 and production audit0. Native Windows race remains unverified because cgo is unavailable. These are prior facts, not a claim that hosted baseline is healthy.
- Active checkout: `codex/continuous-maintenance`, based on the starting main; existing hook merges each complete commit to main and pushes normally. Parallel characterization files are excluded from commits until verified.
- C01 submitted as topic `84b5984`, merged/pushed main `fe0661f`; hosted CI `37154185749` **SUCCESS**: complete format/lint/typecheck/unit/contract/migration/integration/security/build/services/Compose/Go/four images/Vault/E2E/SBOM chain. Repository-level baseline is now accepted on that exact main revision.
- Latest completed submission: C02 topic `0848dad`, merged/pushed main `75a40f2`. Further revisions require their own CI acceptance; the full green checkpoint above is explicitly revision-bound. Its downloaded receipts all match `fe0661f` with unchanged source, unit754/contract391/migration32/integration581/security49/Go2359/Vault73/E2E15, all zero fail/skip. Linux integration has one fewer declared platform case than the prior Windows run.
- Existing test PG/Redis are loopback disposable containers; verify exact URL and `current_database()` before resetting any named fixture. Ordinary databases/containers remain untouched.

## Current work and next candidates

| Priority | Item | Evidence / next action |
| --- | --- | --- |
| P0 resolved | Linux CI health fixture build cannot inspect VCS | C01 local proof and exact-revision complete hosted CI passed. |
| P1 resolved | Inactive user retains existing session authority | C02 fixed/verified/reviewed below; submitting independently after full baseline acceptance. |
| P1 resolved | Project Key issuance lifecycle | C03 fixed/verified/reviewed below; independent submission. No execution or billing exploit claimed. |
| P1 | Connection authority changes while request body is read | Native valid OLD2 failures/7 controls: delayed unbind still succeeds after admin demotion/removal and records success audit; non-null binding correctly rechecks. Root proceeding with transaction-scoped live authorization. Initial setup failures are excluded from OLD evidence. Task actions remain a separate candidate. |
| P2 | Gateway semantic loss | Pure HTTP OLD: nested assistant audio silently dispatches, Anthropic unknown finish becomes completed, Gemini filtered/malformed finish becomes stop. Implement independent protocol fixes after higher-priority security. |

## Completed rounds

### C01 — Docker build trusts only its mounted checkout

Root cause: hosted runner UID1001 owns `/repo`; pinned Go container runs as root, so Git reports dubious ownership and Go cannot obtain VCS status. OLD reproduces Git128 and Go build1 on a disposable UID-owned copy of exact HEAD. Fix passes only `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=/repo` into that disposable Go container. No wildcard trust, host Git configuration change or disabled VCS stamping. GREEN builds successfully and retains the actual revision; a separate UID-owned `/other-repo` still fails Git128.

Full supported local Go gate:2359 pass/0fail/0skip, lint0issues, actual storage200→500→200 and Budget/Worker idempotent replay pass. Relevant CI contracts16/3files, syntax/format/diff pass. During the broad receipt a separate next-round TypeScript regression was added; Go/scripts were not changed after the gate started. Hosted CI after submission remains the repository-level acceptance checkpoint. Evidence: ignored `.test-artifacts/hosted-go-37152432079`.

### C02 — Existing sessions require an active user

Native OLD:5 failures/7 compatibility controls passed. Suspended/invited/deleted users retain project read/write through old sessions, despite fresh login already refusing them; suspended/invited users also rotate the token. Fix joins users in the existing session lookup and requires active/nondeleted, retaining constant-time comparison, expiry, revocation, membership and CSRF checks. No extra query, migration or Gateway Key lifecycle change. Unchanged native GREEN:12 pass/0fail/0skip; related auth/RBAC/security/contracts57/4files pass. Compiler, scoped lint/format and independent review pass. Manual documents the behavior. Guarantee is eligibility at authentication read; no transaction-wide cancellation or permanent revocation on reversible status change is claimed. Details: `2026-10-04-active-user-session.md`.

### C03 — Atomic project Key issuance

Native OLD3 failures/1 control prove publication before mandatory audit, orphan Key on binding/audit failure and false success audit on binding failure. Fix performs project binding and expiry plus mandatory redacted audit on the existing Key transaction client before COMMIT; route no longer binds afterward. Existing no-project/null/empty-string behavior and exact audit metadata remain intact. Unchanged native GREEN4/0fail/0skip; related Key scope/snapshot/auth/security82/5files pass with stable input hashes and closed clients. Compiler, scoped lint/format, independent review pass. Operations guide documents atomic issuance. No migration, repository expansion or Gateway hot-path change. Details: `2026-10-04-atomic-project-key.md`.

## Verification and decisions

Receipts go into ignored `.test-artifacts/continuous-maintenance/`. Do not copy fixture secret custody into public evidence. Use targeted regression/compiler/format/lint before each commit, broad checkpoints after several rounds and complete relevant verification for Gateway or architecture changes. Update this concise file after meaningful checkpoints; prior detailed evidence remains in its original task documents.
