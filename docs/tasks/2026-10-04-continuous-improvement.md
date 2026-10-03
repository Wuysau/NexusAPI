# Continuous autonomous maintenance

User authorization: continue inspect → characterize → minimal design → implement → test → review → commit → re-audit until an actual hard stop. Use normal main/post-commit auto-sync. Preserve execution-plane, credential, tenant/project, unknown-value, no-replay and immutable-accounting boundaries. Never operate production accounts/databases to manufacture acceptance.

## Current state

- Starting HEAD/main/origin: `5e73d1b5588f420a6c0d5b816c4c3f6c7f920724`; checkout initially clean. Prior project diagnostics and published manual are complete.
- Hosted CI `37152432079`: **FAIL**, Integration now **PASS**. Install/format/lint/typecheck/unit/contract/migration/integration/security/audit/secrets/Control Plane/services/Compose passed. Go gate failed before race during the actual health fixture executable build: `error obtaining VCS status: exit status 128`. Later images/Vault/E2E/SBOM were skipped.
- Prior local equivalent acceptance: unit754, contract391, integration582, security49, migration32, E2E15, Vault73, Linux race2359/0skip, four images, standalone startup/PG health, SBOM602 and production audit0. Native Windows race remains unverified because cgo is unavailable. These are prior facts, not a claim that hosted baseline is healthy.
- Active checkout: `codex/continuous-maintenance`, based on the starting main; existing hook merges each complete commit to main and pushes normally. Parallel characterization files are excluded from commits until verified.
- Existing test PG/Redis are loopback disposable containers; verify exact URL and `current_database()` before resetting any named fixture. Ordinary databases/containers remain untouched.

## Current work and next candidates

| Priority | Item | Evidence / next action |
| --- | --- | --- |
| P0 | Linux CI health fixture build cannot inspect VCS | Minimal fix verified locally; follow the new hosted run for complete baseline acceptance. |
| P1 candidate | Inactive user retains existing session authority | Login refuses inactive accounts, but session verification queries only sessions. Actual PostgreSQL characterization underway before production changes. |
| P1 | Project Key issuance lifecycle | Native OLD3 failures/1 control: blocked mandatory audit still exposes the new unbound Key in a signed directory; binding/audit failure leaves persisted orphan Key, and binding failure also leaves success audit. Plan atomic scope/expiry/audit issuance, preserving explicit unbound legacy keys. No execution or billing exploit claimed. |
| P1 candidate | Authority changes while request body is read | Controlled route/helper audit demonstrates stale resume/switch and connection-unbind authority; require native characterization before selection. |
| P2 | Gateway semantic loss | Pure HTTP OLD: nested assistant audio silently dispatches, Anthropic unknown finish becomes completed, Gemini filtered/malformed finish becomes stop. Implement independent protocol fixes after higher-priority security. |

## Completed rounds

### C01 — Docker build trusts only its mounted checkout

Root cause: hosted runner UID1001 owns `/repo`; pinned Go container runs as root, so Git reports dubious ownership and Go cannot obtain VCS status. OLD reproduces Git128 and Go build1 on a disposable UID-owned copy of exact HEAD. Fix passes only `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=/repo` into that disposable Go container. No wildcard trust, host Git configuration change or disabled VCS stamping. GREEN builds successfully and retains the actual revision; a separate UID-owned `/other-repo` still fails Git128.

Full supported local Go gate:2359 pass/0fail/0skip, lint0issues, actual storage200→500→200 and Budget/Worker idempotent replay pass. Relevant CI contracts16/3files, syntax/format/diff pass. During the broad receipt a separate next-round TypeScript regression was added; Go/scripts were not changed after the gate started. Hosted CI after submission remains the repository-level acceptance checkpoint. Evidence: ignored `.test-artifacts/hosted-go-37152432079`.

## Verification and decisions

Receipts go into ignored `.test-artifacts/continuous-maintenance/`. Do not copy fixture secret custody into public evidence. Use targeted regression/compiler/format/lint before each commit, broad checkpoints after several rounds and complete relevant verification for Gateway or architecture changes. Update this concise file after meaningful checkpoints; prior detailed evidence remains in its original task documents.
