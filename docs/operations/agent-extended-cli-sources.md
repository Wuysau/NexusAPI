# Pi, Factory Droid and OpenClaw adapter evidence

Verified on 2026-09-29. These adapters emit client-observed metadata, not provider billing or subscription balances. Tool IDs are `pi`, `factory_droid`, and `openclaw`. The pure `parseExtendedCli(tool, value, {file, workspace?})` function returns the shared `NativeRecord[]`; the reader owns file access, byte limits and incomplete JSONL lines.

## Pi: native session JSONL

The original `badlogic/pi-mono` repository redirects to `earendil-works/pi`. Sources inspected at commit `cb7969d212836b8939001dce159fbd2ed6ad395f`:

- [Session manager](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/coding-agent/src/core/session-manager.ts): V2/V3 session header; assistant message entries; usage, compaction and branch-summary entries; fork copying; filename and directory construction.
- [Usage types](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/types.ts): output already includes optional reasoning; absent reasoning remains unknown.
- [OpenAI normalization](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/api/openai-completions.ts): input excludes cache read/write; total sums those components and output.
- [Configuration paths](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/coding-agent/src/config.ts): default agent directory and environment override.

Default discovery root: `~/.pi/agent/sessions/`. If configured, use `PI_CODING_AGENT_DIR/sessions/`. Files are `--<encoded-cwd>--/<ISO-time-with-colons-and-dots-replaced>_<session-uuid>.jsonl`. Match `.jsonl` files under an explicit session root; custom session directories require explicit configuration.

Supported input is an array of parsed JSONL rows. A header has `type: session`, `version: 2|3`, `id`, `timestamp`, `cwd` and optional `parentSession`. Assistant rows have `type: message`, `id`, `timestamp`, and `message.role: assistant`; model and usage come from that message. The adapter also accepts Pi's explicit `usage`, `compaction`, and `branch_summary` rows when they contain `usage`. Summary rows do not prove a model; their model remains null.

Normalized input is `usage.input + usage.cacheRead + usage.cacheWrite`; cached is cache-read only. Output is `usage.output`, reasoning is optional `usage.reasoning`, and total is the reported `usage.totalTokens`. Missing operands remain unknown. Negative, fractional, unsafe or inconsistent numbers are rejected. Costs, provider identity, context occupancy and prompt contents are ignored.

Replays deduplicate by session and entry ID, retaining the latest snapshot. In-file branches preserve consumed usage. Forks copy original IDs and timestamps; copied entries at or before the new header's timestamp are excluded. This assumes the source clock is monotonic across the fork; equal-millisecond new entries are conservatively omitted. A parent session UUID is recovered only from Pi's verified standard filename; renamed paths remain unknown. A fork is not automatically classified as a subagent. Legacy V1 entries without stable IDs are unsupported.

## Factory Droid: official SDK result export

Evidence:

- [SDK documentation](https://docs.factory.ai/sdk/typescript#token-and-context-usage): `DroidResult.tokenUsage` covers one SDK turn, includes delegated work, and can be null. Streaming token updates instead describe cumulative session usage.
- [SDK repository](https://github.com/Factory-AI/droid-sdk-typescript/tree/6c1e3e33002f096b45dff27dcc2e15481ee9937e) and [public package metadata](https://registry.npmjs.org/@factory/droid-sdk/0.9.1): published SDK version `0.9.1`.
- Published package `dist/index-C06W9tbN.d.ts` and `dist/chunk-TWSTJMV7.mjs`: `DroidResultBase`, `DroidAssistantMessage`, `DroidUserMessage`, `FactoryDroidMessageSchema` and `TokenUsageSchema` confirm the fields below. These package artifacts were inspected without installing or running Droid.
- [Headless CLI](https://docs.factory.ai/droid-exec/overview#output-formats-and-artifacts) and [telemetry reference](https://docs.factory.ai/enterprise/telemetry/data-reference): raw CLI result JSON and OTEL are separate surfaces, not interchangeable with SDK result exports.

Use explicit JSON or JSONL exports of SDK `run()` results or the terminal `result` of `session.stream()`. No default Factory directory is auto-discovered for this adapter. Although SDK discovery verifies `~/.factory/sessions/` exists as native storage, its published session header and message schemas do not establish a native per-request token event format. This adapter does not claim native transcript support.

The supported object has `type: result`, `sessionId`, `turnCount: 1`, an official result subtype, `tokenUsage`, and `messages`. Each usable entry is a `user` or `assistant` SDK message whose nested `message` includes matching `role`, `id`, and epoch-millisecond `createdAt`. The first user ID, or first assistant ID when no user exists, anchors replay identity. The latest actual message creation time is the observation timestamp. Empty or timestamp-free result exports cannot be imported. Configure `workspace` because the result carries no cwd. Aggregate model remains unknown because delegated work can use different models.

Factory describes provider-reported counters without guaranteeing cache/reasoning overlap across all providers. Therefore cache reads and thinking counts are preserved, but inclusive input is accepted only when cache-read and cache-creation are both explicitly zero; inclusive output is accepted only when thinking is explicitly zero. Ambiguous inclusive counters and the unreported total stay null. Credits are not imported as money. No model-name heuristic decides token semantics. Raw CLI `--output-format json`, cumulative `token_usage_update`, JSON-RPC notifications and context occupancy are not parsed by this adapter.

An existing SDK integration can export just the allowlist, omitting response content:

```ts
import { appendFile } from 'node:fs/promises'

// result is the official SDK DroidResult returned for an existing turn.
const exported = {
  type: result.type,
  subtype: result.subtype,
  sessionId: result.sessionId,
  turnCount: result.turnCount,
  tokenUsage: result.tokenUsage && {
    inputTokens: result.tokenUsage.inputTokens,
    outputTokens: result.tokenUsage.outputTokens,
    cacheReadTokens: result.tokenUsage.cacheReadTokens,
    cacheCreationTokens: result.tokenUsage.cacheCreationTokens,
    thinkingTokens: result.tokenUsage.thinkingTokens,
  },
  messages: result.messages.flatMap((entry) =>
    entry.type === 'user' || entry.type === 'assistant'
      ? [{ type: entry.type, message: {
          id: entry.message.id,
          role: entry.message.role,
          createdAt: entry.message.createdAt,
        } }]
      : [],
  ),
}
await appendFile('/absolute/path/droid-sdk-results.jsonl', JSON.stringify(exported) + '\n')
```

Register that explicit path with tool `factory_droid`, format `native`, and the actual workspace. Do not put it in the generic telemetry auto-discovery spool: it is SDK export JSONL, not NexusAPI's generic telemetry schema. Do not independently import both delegated results and their parent's aggregate, which would double-count delegated usage.

## OpenClaw: legacy Pi-shaped JSONL only

Official evidence at commit `82aec10d4e051e498499f6adcfda2b05534ba886`:

- [Session storage](https://github.com/openclaw/openclaw/blob/82aec10d4e051e498499f6adcfda2b05534ba886/docs/reference/session-management-compaction/store.md): current runtime writes per-agent SQLite; legacy transcript artifacts reside under `~/.openclaw/agents/<agentId>/sessions/`.
- [Transcript schema](https://github.com/openclaw/openclaw/blob/82aec10d4e051e498499f6adcfda2b05534ba886/docs/reference/session-management-compaction/schema.md): header and tree-structured message entries.
- [Usage normalization](https://github.com/openclaw/openclaw/blob/82aec10d4e051e498499f6adcfda2b05534ba886/src/agents/usage.ts): normalized input, cache-read and cache-write components are distinct; inclusive prompt usage adds them.

Use an explicit legacy `.jsonl` transcript containing a V2/V3 Pi-shaped header and assistant messages with the Pi usage shape above. Counters, replay IDs and fork-copy handling use the same conservative rules as Pi. Classification is `other`; the adapter does not infer subagents from session keys. Current `openclaw-agent.sqlite`, `sessions.json`, arbitrary new OpenClaw event variants and unsupported exports are not read. There is no claim that current OpenClaw activity is automatically captured by scanning old JSONL directories.

## Limits and verification

At most 100,000 outer and, for Factory, nested message records are visited; oversized snapshots throw `extended_cli_record_limit` instead of returning silently partial accounting. No recursion or file I/O occurs. Only validated identities, timestamps, cwd, model and counters leave the parser; prompts, summaries, tool inputs/results, errors, account data and costs never do. Event IDs hash tool, session and stable message identity, independent of path or text.

Tests were written before implementation. Focused Vitest covers supported source-shaped fixtures, cache/reasoning semantics, missing counters, malformed records, replay stability, branches/fork copies, explicit usage records, multiple Factory turns, privacy canaries and bounds.
