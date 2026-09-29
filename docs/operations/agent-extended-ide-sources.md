# Extended IDE source coverage

Verified against primary sources on 2026-09-29. `parseExtendedIde(tool, value, {file, workspace?})` is a pure parser returning the shared `NativeRecord` type. The importer supplies bounded JSON/JSONL snapshots. Only Qoder IDE native activity is enabled by this adapter; the investigations below do not imply native support for the other tools.

## Qoder IDE: native activity

The official [Hooks reference, Transcript File Format](https://docs.qoder.com/extensions/hooks#transcript-file-format) documents automatically written JSONL at `~/.qoder/projects/<encoded-path>/transcript/<session>.jsonl`. The same reference is available as [Markdown](https://docs.qoder.com/extensions/hooks.md). Each assistant record has `type`, `sessionId`, `uuid`, `timestamp`, and `cwd`. The parser requires valid explicit IDs and an ISO timestamp. It accepts a parsed record or an array of parsed lines, and caps snapshots at 50,000 records.

One assistant record becomes one activity event. SHA-256 of tool/session/record IDs provides stable replay identity across file copies; content and counters are never hashed. Duplicate identities with conflicting time or cwd are discarded within a snapshot. Non-assistant records, tool results, progress, and session metadata are ignored. The documented contract specifies no model or token counters, so all five token counters and model remain null even when undocumented usage fields appear. Parent-session lineage is not inferred from message/tool IDs. Workspace attribution uses only a valid absolute recorded cwd or explicit source workspace; encoded directory names are not decoded into project paths.

This documents the IDE/JetBrains transcript contract, not an assertion that every Qoder CLI or future format is compatible. Activity counts represent assistant records, including tool-call records, rather than completed paid API requests. No content, credentials, user identity, provider, subscription, or cost enters the returned records.

## Continue: native capture deliberately unavailable

The official [dev-data guide](https://github.com/continuedev/continue/blob/main/.continue/rules/dev-data-guide.md) describes `~/.continue/dev_data/{version}/tokensGenerated.jsonl`. [Path implementation](https://github.com/continuedev/continue/blob/main/core/util/paths.ts) also supports `CONTINUE_GLOBAL_DIR`. [Local logging](https://github.com/continuedev/continue/blob/main/core/data/log.ts) currently writes schema `0.2.0`.

The [token schema](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/data/tokensGenerated/index.ts), [v0.2.0 projection](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/data/tokensGenerated/v0.2.0.ts), and [v0.1.0 projection](https://github.com/continuedev/continue/blob/main/packages/config-yaml/src/schemas/data/tokensGenerated/v0.1.0.ts) contain no durable session or event identity. Version 0.1.0 additionally lacks timestamps. User/profile IDs are not session IDs. The [LLM logger](https://github.com/continuedev/continue/blob/main/core/llm/index.ts) computes prompt/completion counts locally and counts thinking separately; treating generatedTokens as verified inclusive output would be incorrect.

The [session/history interfaces](https://github.com/continuedev/continue/blob/main/core/index.d.ts) and [history persistence](https://github.com/continuedev/continue/blob/main/core/util/history.ts) provide session IDs, workspace and cumulative usage, but no stable per-assistant timestamp/ID contract or correlation key to dev data. The session-index creation date is not each event's timestamp. Therefore this parser does not synthesize sessions from token-stream filenames, guess joins by time/model, or turn cumulative session totals into events. Continue remains available through explicitly identified metadata bridge records.

## Tencent CodeBuddy: hooks documented, native transcript schema unverified

The official [CLI Hooks reference](https://www.codebuddy.ai/docs/cli/hooks) documents session ID, cwd, transcript path and optional generation ID. It shows transcript paths under `~/.codebuddy/projects/.../<session>.jsonl` but does not specify the stored record schema or native token semantics. The hook contract is described as Beta. No Claude-style transcript assumptions are made, and no native CodeBuddy discovery/parser is implemented here. Hook/metadata bridge integration needs explicit durable identity and a captured timestamp; prompts and tool inputs should never be included in that bridge.

## Amp investigation

[Official thread docs](https://ampcode.com/docs/threads) provide `amp threads export T-…` and UI JSON export, but do not document the full export shape. The [external API](https://ampcode.com/api/external) promises stable messageID, messageVersion and optional createdAt for message listing while warning other message fields are unstable. A saved messages response alone does not establish its thread binding. This adapter does not guess a native/export schema or read Amp credential files. Amp retains its existing bridge capability.

## Verification

Synthetic fixtures cover Qoder metadata, copied-file replay, cross-session identities, duplicate conflicts, strict missing-ID/time rejection, workspace handling, record bounds and content/privacy canaries. Unsupported Continue, CodeBuddy and Amp payloads explicitly return no records. No actual user transcripts or provider logins are used.
