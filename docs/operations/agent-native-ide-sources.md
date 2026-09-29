# Native IDE and CLI activity adapters

`parseNativeIde(tool, value, {file, workspace?})` is a pure, metadata-only snapshot parser. The caller bounds file I/O and supplies the parsed JSON array or an array of complete JSONL records. Recognized tool IDs are `cline`, `roo_code`, `kilo_code`, `github_copilot`, and `kimi_cli`. Unknown tools and invalid records are ignored. The parser does not scan disks, call providers, execute commands, or write databases.

Each result contains only session/event identity, source timestamp, explicit workspace, model when the event records it, token counters, and optional parent/subagent identity. All event IDs are stable SHA-256 hashes that exclude message contents and mutable counters. Fallback session IDs hash the source directory; paths are never inferred to be workspaces. IDs remain within 160 characters. File identity must be an absolute path; workspace attribution requires an explicit configured absolute workspace or a documented recorded cwd.

## Supported sources

| Tool | File supplied by the reader | Recognized evidence | Limits |
| --- | --- | --- | --- |
| Cline VS Code | `tasks/<task-id>/ui_messages.json` | `type=say`, `say=api_req_started`, millisecond `ts`, JSON `text` counters; `modelInfo.modelId` | Legacy cache conventions vary by provider. Positive cache counters make inclusive input unknown; total stays unknown. |
| Roo Code | `tasks/<task-id>/ui_messages.json` | Same request row envelope; `tokensIn` is already normalized inclusive input | No model or workspace inference from prompts/settings. |
| Kilo Code legacy extension | `tasks/<task-id>/ui_messages.json` | Same normalized request row; `usageMissing=true` explicitly suppresses synthetic counters | Verified against official **kilocode-legacy**. This does not claim support for the current Kilo SQLite/session format. |
| GitHub Copilot CLI | `session-state/<session-id>/events.jsonl` | `session.start.data.sessionId`, `data.context.cwd`, subsequent recorded context updates; persistent `assistant.message` | Explicit `outputTokens` only. Ephemeral `assistant.usage`, shutdown totals and usage checkpoints are excluded. |
| Kimi CLI | `sessions/<workdir-hash>/<session-id>/wire.jsonl` | `{timestamp: seconds, message:{type,payload}}`; `StepBegin`, `StatusUpdate.token_usage`; `SubagentEvent` | No model identity in these usage records; context occupancy is not token consumption. |

Custom storage roots are allowed by several upstream tools. Configure the actual paths instead of assuming a platform-specific home directory. Cline/Roo/Kilo task snapshots mutate existing request rows as streaming completes; rescans must enrich the same event ID, not append another consumption event. Aggregated deleted-request and subagent summary rows are omitted to avoid overlapping earlier imported requests.

Roo and legacy Kilo persist `costResult.totalInputTokens`; cached reads/writes must **not** be added again. `cached` reports cache reads only. Cline's older raw input field does not reliably disclose whether cache components are included, so the parser deliberately withholds ambiguous inclusive input/total. It never guesses provider or subscription from model names, API protocol, or installation directory. Provider/subscription/channel attribution stays unknown in the caller's generic Agent source.

Copilot messages may be split around reasoning boundaries. A shared durable `apiCallId` merges those rows using the maximum reported output count, never a sum of repeated full-call counters. Split messages without a durable call ID retain activity with unknown output. `selectedModel` is a setting and is not used as evidence of the actual model. Current upstream declares full `assistant.usage` ephemeral, so ordinary local history cannot guarantee complete input/cache totals. Session aggregate counters can overlap across resumes and are intentionally not converted into additive events.

Kimi's `input_other`, `input_cache_read`, and `input_cache_creation` form inclusive input when all three are present and valid; adding output then yields total. Missing fields remain unknown, even where the upstream Python model has defaults. A `StepBegin` initially yields activity with unknown tokens; later usage enriches that step's stable event. Standalone status records require `message_id` to deduplicate; unkeyed records are ignored. Repeated status snapshots never add the same usage again. `SubagentEvent.agent_id` (or documented parent-tool ID compatibility fields) creates a separate child session linked to its parent. Context percentages, context limits, prompts, generated text, tools, costs, credentials and raw payloads are never persisted in the result.

## Numeric and privacy checks

Counts accept nonnegative safe JSON integers or exact canonical decimal strings through signed PostgreSQL bigint maximum. Negative, fractional, nonfinite, unsafe-number and overflowing values stay unknown. Known zero remains zero. Derived sums require every component and cannot overflow. A cached count larger than known inclusive input makes that input/total unknown. Timestamp conversion uses each source's documented unit; malformed timestamps are rejected. Optional metadata is allowlisted and bounded. Tests cover mutation/replay deduplication, cache semantics, partial activity, split messages, subagents, malformed numbers, overflow and absence of prompt/credential fields.

## Primary source evidence

Verified against upstream source on 2026-09-29. These local file formats can evolve; unsupported schemas remain unknown rather than gaining guessed values.

- Cline's [message and request usage types](https://github.com/cline/cline/blob/main/apps/vscode/src/shared/ExtensionMessage.ts), [model metadata](https://github.com/cline/cline/blob/main/apps/vscode/src/shared/messages/metrics.ts), and [request metrics reader](https://github.com/cline/cline/blob/main/apps/vscode/src/shared/getApiMetrics.ts). Its [upstream cache-convention report](https://github.com/cline/cline/issues/11037) describes why raw legacy counters cannot be universally added.
- Roo's [persisted message schema](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/message.ts), [request counter writer](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task/Task.ts), and [inclusive input calculation](https://github.com/RooCodeInc/Roo-Code/blob/main/src/shared/cost.ts).
- Kilo's official legacy [request counter writer](https://github.com/Kilo-Org/kilocode-legacy/blob/main/src/core/task/Task.ts) and [inclusive input calculation](https://github.com/Kilo-Org/kilocode-legacy/blob/main/src/shared/cost.ts).
- GitHub's [CLI storage documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices) and [generated runtime event contract](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts), specifically `StartData`, `WorkingDirectoryContext`, `AssistantMessageData`, and `AssistantUsageEvent`.
- Kimi's [wire file envelope](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py), [wire event types](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py), and [TokenUsage arithmetic](https://github.com/MoonshotAI/kimi-cli/blob/main/packages/kosong/src/kosong/chat_provider/__init__.py).
