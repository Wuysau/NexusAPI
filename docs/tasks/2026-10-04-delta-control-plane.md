# GitHub delta research and project diagnostics

Date: 2026-10-04. User authorized research followed by direct implementation without feature-by-feature approval.

## Baseline evidence

- Initial HEAD: `7c12a30679f42b66dd0cb03f316f41b2748ddea1`; its tree equals local/origin main `19a9933c052ce1933a64405353eca1f7360351a9`. Tracked checkout initially clean.
- Latest hosted CI: run `37146254842`, failed Integration. Observer hardcoded `D:/AgentProject` fails Ubuntu `path.isAbsolute`; Connector requires `connector_test` but receives `convergence_ci15`. Install through canonical migration passed; later gates did not run.
- Initial local format/lint/typecheck passed. Unit: 713 tests/62 files. Contract: 266 tests/25 files. After repair, format/lint/typecheck and CI validation pass, unit713/62 files, contract269/26 files, migration32/2 files and integration523/50 files pass with zero skips. Integration ran225.859s including independent Gateway/CLI/privateTLS/mock Ollama.
- Use existing checkout. The implementation phase left changes uncommitted; the user's subsequent instruction explicitly authorizes updating the manual and submitting the changes to main through the existing auto-sync workflow. Only named disposable loopback fixture databases may be reset; verify `current_database()` first.

## Capability map

| Capability | Current implementation/evidence | Actual limit |
| --- | --- | --- |
| API execution/routing | Go signed snapshots, hard authorization, Redis admission, Budget, pre-dispatch failover/cooldown, bounded streams, durable request/attempt/outbox; TS/Go/unit/contract/native DB/mock upstream tests | Chat and opt-in Responses subset; not full multimodal/batch coverage. No uncertain execution replay. |
| Usage/accounting | Worker frozen authority/price provenance, exact nullable v2 metering, append-only ledger and project facts; contract/native PostgreSQL and independent service fixtures | Missing prices reconcile; subscription observations do not debit wallet. |
| Resource discovery | Existing `/resources` projection over channels/connections/quota, pool windows, batched connector state; unit/native DB/browser fixture evidence | Projection does not prove signed publication or model execution. |
| Local connector | Pairing, leases, outbound TLS, local model allowlist and live project Key checks; independent Gateway/CLI/private TLS/mock Ollama | Single enabled Gateway. No real two-machine Ollama acceptance. |
| Coding tasks | Codex supervisor, exact resume identity, bounded handoff, workspace/Profile locks, fresh official quota gate/cooldown; unit fake app-server and real DB fixtures | No live independent-profile cross-account supervised acceptance. Additional tools not supervised. |
| Agent observation | Metadata-only 42 identity registry with distinct native/export/hook/bridge/unadapted status, idempotent workspace attribution; unit/native DB and recorded Codex/Claude live acceptance | Identity catalog is not 42 native integrations. Prompt contents not imported. |
| Model catalog | Existing upstream capabilities + catalog evidence and display configuration | Generic boolean source defaults and adapter/model heuristics are not a proven per-model capability registry. |
| Operational UI | Request summary and latest attempt; static Playground | No complete recorded-attempt detail or interactive chat before this task. |

Prior real acceptance is limited to documented 2026-09-29 configured models, Codex quota and one Claude CLI turn. This task must report fresh results separately.

## Selection and implementation order

Scores use User Value / Architecture Fit / Reliability-Security / Novelty / Maintainability / Cost / License (30/20/15/10/10/10/5).

| Candidate | Scores | Total | Decision |
| --- | --- | --- | --- |
| Recorded request/Attempt trace detail | 28/20/14/10/9/9/5 | 95 | Adapt; metadata-only authoritative topology. |
| Project-authorized browser Playground | 27/19/12/10/9/8/5 | 90 | Adapt; real Gateway calls with explicit project Key. |
| Per-model capability-aware routing | 27/19/13/9/6/3/5 | 82 | Research only; requires capability evidence/review/publication and signing/version contract, avoid name guesses. |
| Durable unified account scheduling | 26/20/13/7/5/2/5 | 78 | Research only; one writer per plane and canonical load/capacity facts not yet specified. |
| Additional automatic Agent supervisors | 24/18/10/9/5/2/5 | 73 | Research only; proof of exact conversation and Profile credential isolation comes first. |
| MCP tool resource governance | 23/17/11/9/5/2/5 | 72 | Research only; enrollment/authorization/transport authority must precede listing UI. |

Choose two complete slices with clear authority and verifiable behavior. Research must still cover at least 20 repositories, 8 deep reads and 5 source analyses across required categories. ADRs are recorded before feature code: `docs/adr/2026-10-04-recorded-request-traces.md` and `docs/adr/2026-10-04-project-playground.md`.

## Execution plan

- [x] Repair Observer platform fixture and isolate Connector CI database; strengthen actual-database checks without weakening validators/guards. Run format, lint, typecheck, unit, contract, migration and integration before feature code.
- [x] Complete and consolidate dynamic pinned-source research, license boundaries and rejected behaviors into `docs/operations/open-source-research.md`:51 unique scans,10 deep source/test/license reviews in linked dated report.
- [x] Implement trace contract, bounded read service, authorized no-store API and log-linked UI; unit/contract/native-route/isolation/browser verification.
- [x] Implement strict Playground contract, project/Key authorization, bounded one-shot Gateway forwarding and real chat UI; unit/contract/native-route/browser/real Go Gateway fixture verification.
- [x] Independently review final slices, fix findings and run all requested applicable checks. Keep fixture/live/provider evidence separate and record exact unresolved environmental gates.
- [x] Update README, operation docs, this task and local `docs/current-task.md` with final evidence and remaining gaps.

## Verification

Implementation and independent review are complete. Final unit754, contract391, integration582, security49, migration32, E2E15, Vault73 and hooks6 pass with zero skips. Supported Linux full race2359/0skip and golangci-lint0issues pass; actual storage failure/recovery and Budget/Worker replay checks pass. Format/lint/typecheck, native Gateway build/test/vet, Next/services builds, four Docker images, Compose, secrets scan, strict SBOM602, production audit0 and workflow validation pass. Actual production standalone starts and its real PostgreSQL health query returns200; the child is closed.

Windows native `npm run gateway:race` failed exit2 because the cgo toolchain is unavailable: NOT VERIFIED on native Windows. The Linux container result is separately recorded, not substituted for that command. Hosted CI was not triggered during local implementation acceptance; subsequent main submission and its Actions results are verified separately. New Playground provider execution uses a local mock upstream; no fresh live-paid-provider, real account/Profile handoff, multi-machine Ollama, production HA or long-lived Vault renewal acceptance is claimed.

Final independent review fixed valid Unicode frozen-name/provider-ID compatibility and confirmed the bounded Windows pg alias repair/private artifact guard. Operator/test materials remain outside standalone; path checks do not inspect allowed file contents. No new schema migration, hot-path DB call or additional execution plane was introduced. All verification services are closed; only named Vault test containers started by this run are returned to stopped state. Original PG/Redis fixtures and ordinary databases are preserved.

See the [complete nine-part implementation report](../operations/delta-implementation-2026-10-04.md) for per-command statuses and remaining gaps, and [operation guide](../operations/project-diagnostics.md) for Gateway configuration, authorization, limits and cancellation semantics. Ignored receipts: `.test-artifacts/delta-verification` and `.test-artifacts/infra-verification`.
