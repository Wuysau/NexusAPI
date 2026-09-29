# Native CLI usage parser sources

Verified against upstream source on 2026-09-29. These adapters observe locally recorded counters; they do not establish billed charges, provider identity, subscription entitlement, or account ownership. Fixtures are synthetic representations of the verified formats, not private user transcripts. Upstream branches can change; unsupported shapes produce no usage.

## Gemini CLI

- [Recording types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts) define session metadata, `gemini` messages and token summaries.
- [Recording service](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) writes initial metadata and complete message snapshots in JSONL. Repeated message IDs replace earlier snapshots; `$set.messages` contains checkpoints. Legacy JSON stores `{sessionId, projectHash, messages}`.
- The same service maps input to prompt tokens, output to candidate tokens, cached to cached input and thoughts to reasoning. Normalized output adds thoughts; cached remains a subset of input. Inconsistent totals and nonzero tool-use prompt counters are rejected because this schema has no verified mapping for the latter. Missing counters remain null. If thoughts is absent, a reported total and input may establish inclusive output; reasoning remains unknown.
- Default main records are `~/.gemini/tmp/<project>/chats/session-*.json[l]`. Current subagent records use `chats/<parentSessionId>/<subagentSessionId>.jsonl` with explicit `kind: subagent`. The parent ID is read only from that verified nesting. Project directory hashes and additional workspace directories are never guessed into a cwd; configure the workspace in the source registry.
- Rewinds and checkpoints change visible context, but do not refund tokens. This usage adapter retains observed IDs across those records, with the latest snapshot for each ID. It cannot recover usage erased before observation, or guarantee later snapshots match provider billing.

## Qwen Code

- [Recording service](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts) defines native `ChatRecord` JSONL: `uuid`, `sessionId`, `timestamp`, `cwd`, `type: assistant`, `model`, and `usageMetadata`. Current code writes `<getProjectDir()>/chats/<sessionId>.jsonl`.
- [Storage implementation](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts) resolves the default project directory under `~/.qwen/projects/<sanitized cwd>`; custom runtime roots may differ. Some upstream comments still mention the earlier `tmp` path.
- [OpenAI converter](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/openaiContentGenerator/converter.ts) maps completion tokens directly into `candidatesTokenCount`. Thus Qwen output already includes reasoning, unlike native Gemini. `thoughtsTokenCount` can be estimated by Qwen itself when a provider omits it; the adapter preserves this local observation without claiming provider verification.
- [Anthropic usage conversion](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/anthropicContentGenerator/usage.ts) already includes cache reads and writes in `promptTokenCount` and preserves inclusive output in `candidatesTokenCount`; the adapter does not add those counts again.
- Explicit `parent_session` records and `agentId` identify child usage. `forkedFrom` copied history is skipped to avoid counting inherited usage again. Unsupported managed-engine transcript variants and older formats are not claimed as supported.

## OpenCode

- [Export command](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/export.ts) emits `{info, messages}`; messages have `{info, parts}`. The supported input is an explicit `opencode export <sessionID>` JSON file, not raw console events or Markdown.
- [V1 session schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts) defines assistant `sessionID`, `modelID`, `path.cwd`, epoch-millisecond `time`, and token counters. Session `parentID` identifies a child session; an assistant's `parentID` is a message ID and is never used for session lineage.
- [Usage normalization](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts) stores exclusive counters: normalized input is `input + cache.read + cache.write`, output is `output + reasoning`, and cached input is `cache.read`. Missing operands remain unknown; reported totals must agree when normalized input/output are known. Parts and session-level totals are ignored to prevent duplication.
- No direct SQLite capture is implemented. Current exported V1 counters are supported; future exports and older counters with different semantics need explicit versioned adapters. Sanitized exports can redact cwd, so configure a workspace mapping if needed.

## Parser boundary

`parseNativeCli(tool, value, {file, workspace?})` accepts tool IDs `gemini_cli`, `qwen_code`, and `opencode`. Gemini accepts a JSON object or an array of parsed JSONL lines. Qwen accepts an array of native JSONL records or a single native record. OpenCode accepts its exported object. File reading, incomplete-line handling and byte limits belong to the importer. Parsing is capped at 100,000 visited records, including Gemini nested message arrays; oversized snapshots can be incomplete.

Stable event IDs hash tool, session ID and message ID, not file paths or content. Only IDs, timestamp, cwd, model, lineage and validated integer counters leave the parser. No prompt, message content, thoughts text, tool arguments, credentials, account data or provider/channel inference is returned. Re-reading snapshots is idempotent when the importer upserts by stable event ID.
