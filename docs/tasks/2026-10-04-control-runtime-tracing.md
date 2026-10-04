# C29 — Trace runtime filesystem paths without bundling the repository

Starting topic `e7c8a70`, main `b41b566`. Two runtime filesystem expressions caused Turbopack to trace the whole repository into Control Plane standalone output. Six route manifests explicitly included tests, Gateway source and migration-generator metadata. The installed compiler identified the calls and recommended argument-level `turbopackIgnore` annotations.

Annotate only local credential directory resolution and the Windows Codex candidate existence check. Both remain runtime/operator inputs. Preserve production credential denial, configured absolute executable validation, PATH/architecture search order, actual existence checks and `shell: false`. No bundled Codex executable was present or promised. Private-path exclusions, final artifact inspection, bounded pg alias repair and all credential boundaries remain intact.

Final inventory review found that the project LICENSE had also depended on the broad trace. The build now explicitly copies that public file alongside its existing bootstrap copy. The existing positive build contract checks its exact contents; positive and negative temporary-build fixtures supply this required input. Existing private-file denial assertions are unchanged. Migration/provisioning remains an operator step from the repository, separate from restricted Control Plane startup.

## Verification

Fresh OLD and NEW native builds use the same HEAD, environment shape and frozen build/measurement helpers. The initial NEW comparison enforces exactly the two formatted annotations. A separate FINAL build enforces those annotations plus exactly the LICENSE copy; original OLD/NEW receipts remain unchanged. Each native build preserves all958 public input hashes during execution. Only the two fixture files and evidence/docs change after FINAL runtime verification; production inputs remain identical.

| Actual uncompressed artifact | OLD | FINAL | Reduction |
| --- | ---: | ---: | ---: |
| Windows standalone regular files | 47,978,533 bytes /3,222 files | 33,996,202 bytes /2,326 files | 13,982,331 bytes /29.14% |
| Linux production image `/app` regular files | 75,883,257 bytes /3,207 files | 62,520,997 bytes /2,315 files | 13,362,260 bytes /17.61% |

All six native route traces shrink without added members; the measured tests/Gateway/drizzle-meta groups disappear. Windows and Linux retain unchanged bootstrap/config/picker hashes and their respective static asset counts/bytes. Packaged pg remains available, and both final artifacts contain a byte-identical copy of root LICENSE. Dynamic whole-project tracing warnings disappear on both platforms. These are measured filesystem sizes, not compressed image size, latency or general build-speed guarantees. Native build cache is retained; Linux uses the existing production Dockerfile and resolved Node image.

OLD, preliminary NEW and FINAL each start the actual native production standalone entry against the explicitly guarded disposable loopback database: health200, owned child joined, other clients0, unchanged source, no schema writes or real accounts/CLI. Linux images build and pass read-only filesystem inventory checks; a Linux HTTP/database runtime smoke is not claimed.

Initial annotation-only related81PASS. After requiring LICENSE, three existing temporary build fixtures correctly fail with missing input; that failed receipt is retained. Corrected existing fixtures restore final81PASS/0skip across artifact isolation, production artifacts, local credentials, Codex sync/adapter and secret boundaries. TypeScript compiler, scoped ESLint/format, diff checks and independent review pass. No new speculative resolver tests were added. Previous C26 full cross-service checkpoint and C28 scoped Gateway checks remain separate evidence.

Receipts: ignored `.test-artifacts/control-tracing-round93/`, with OLD/NEW/FINAL, both comparisons, Linux inventories and retained failed/passing related-test logs. No production deployment, live provider or account acceptance is implied.
