# Replace obsolete credential rotation instructions

## Source-proven problem and design

The current runbook uses obsolete api_keys/channel_credentials table names, treats reversible disable as terminal revoke, and assumes an unmeasured p99 propagation bound. Its CP KMS_KEY_VERSION procedure conflicts with the production envelope boundary: CP refuses encryption/decryption and accepts opaque credential references. The companion rotate-key.sh exports that variable, restarts app, then treats /api/health's PostgreSQL SELECT1 as successful key rotation. The variable still belongs to a development legacy helper; it does not drive current production Gateway/Vault or local desktop credential-file rotation. The script performs no Transit rotation or credential verification. No command from the old runbook/script is executed for this audit.

[Vault v1.18.5 Transit rotation](https://github.com/hashicorp/vault/blob/v1.18.5/builtin/logical/transit/path_rotate.go#L84-L89) sends new encryption to a new key version while preserving older-version decryption. Apply that separation in the operational explanation: operator Transit rotation, credential enrollment/registry publication and old-version retirement are distinct operations. NexusAPI does not gain a CP bulk-rewrap implementation from this reference.

Rewrite the runbook around actual key POST/recent-auth DELETE and reversible PATCH, local desktop credential replacement versus independent production enrollment, and current internal token consumers. Remove the obsolete script endorsement from the operations index. Make that legacy executable return a fixed unsupported diagnostic and nonzero exit before inspecting environment, restarting services or probing HTTP. Point to the supported runbooks. Preserve evidence and backups before retiring old decryption versions; claim no propagation or zero-downtime bound from a health check.

## Scope and verification

Root owns docs/operations/key-rotation.md, docs/operations/README.md, scripts/ops/rotate-key.sh, the research note and this task document. No provider material, private environment, application/DB state, migration or subscription credential is read or changed. Independent read-only design review checks the exact current source consumers and script withdrawal. No production deployment or real credential rotation is authorized by this documentation task.

Validate source links and routes, shell syntax and actual fixed nonzero behavior under an empty environment with/without the legacy version argument. Use only the cached Linux tool image with network disabled and the single script mounted read-only; expose no workspace/environment/credential files or Docker socket. No new test file is needed for this reversible documentation and unsupported-entrypoint change. Secret scan and diff checks apply; Round62's fresh compiler/TypeScript/native and TLS checks remain prior evidence for untouched application code. Review exact completed paths and use the existing explicit commit/automatic main hook.

Independent read-only design review is clear, including the distinction between development KMS_KEY_VERSION consumption and the current production credential boundary. The existing supported APIs/workflows do not invoke the obsolete script. Its retained path will explicitly fail instead of falsely reporting a successful operation.

## Implemented result and verification

The runbook now describes actual downstream creation/terminal revocation/reversible suspension, local desktop replacement, independent production enrollment/registry publication, Transit versions and distinct service-token consumers. The operations index no longer advertises the retired production automation. The retained script consists only of its interpreter/comment, a fixed stderr diagnostic and exit 1; it reads no version variable and starts no service or HTTP operation. Its LF line ending and existing tracked file mode are retained.

Three independent cached Linux container invocations mount only this script read-only, use env -i and disable networking. Bash syntax exits0 (0.777s); actual execution with no version exits1 (0.842s), and execution with NEW_VERSION=2 exits1 (0.769s), with the identical fixed diagnostic. Each container closes/removes on completion. No repository/environment/credential file, network or Docker socket is exposed to those processes. The original script is never executed.

Local documentation references and actual source consumers are checked; secret scanning and diff checks pass. There is no new application, Go, migration or test change. Round62's fresh compilation, 146 TypeScript checks, seven native issuance cases and nineteen actual TLS cases remain applicable prior evidence for that application code; they are not represented as rerun checks for this documentation/entrypoint round. No production credential or KMS was rotated. Exact read-only final review and explicit integration close the round.

The actual isolated execution command is:

```sh
docker run --rm --pull never --network none --mount type=bind,source=D:/Projects/TypeScript/NexusAPI/scripts/ops/rotate-key.sh,target=/rotate-key.sh,readonly golang:1.27 env -i PATH=/usr/bin:/bin NEW_VERSION=2 /bin/bash --noprofile --norc /rotate-key.sh
```

Expected exit is 1 with the fixed diagnostic. Omit NEW_VERSION=2 for the no-version control; add -n before the script path for syntax verification (expected exit0). The cached tool image is required; no pull or live KMS operation is part of this verification.

Independent final read-only review of the exact five commit paths is clear. It confirms source-supported workflows, version/token boundaries, fixed unsupported execution and unchanged tracked mode. No live deployment or credential operation was performed. All isolated verification processes have closed; integration uses the explicit paths and separate-main-worktree automatic hook.
