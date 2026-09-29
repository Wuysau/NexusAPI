# Agent Hook activity capture

Verified against official documentation on 2026-09-29. These opt-in adapters append local **activity metadata**, not billing or token usage. All five token counters remain `null`, even if an unrecognized payload contains counters. They do not recover previous history or monitor subscription balances. Native telemetry with documented usage semantics should use the existing [telemetry bridge](agent-telemetry.md).

| Tool ID | Accepted official events | Stable identity |
| --- | --- | --- |
| `windsurf` | `post_cascade_response` | `trajectory_id` + `execution_id` |
| `codebuddy` | `Stop`; session start/end | `session_id` + optional `generation_id`; lifecycle once/session |
| `factory_droid` | `Stop`; session start/end | `session_id` + optional `message_id`; lifecycle once/session |
| `qoder` | `PostToolUse`; session start/end | `session_id` + `tool_use_id`; lifecycle once/session |
| `kiro` | `SessionStart`, legacy `agentSpawn` | `session_id`, once/session |
| `antigravity` | `PostToolUse` only | `conversationId` + `stepIdx` |

`Stop` events missing the documented ID are skipped. Qoder and Kiro Stop events need an explicit wrapper-supplied `nexus_event_id` to be accepted; that extension is not a vendor field. A wrapper must persist one ID per event and reuse it on retries. Do not create a new random ID on every retry or derive it from prompt text. Resumes and compactions are skipped as session starts. Lifecycle end records capture presence once/session, not each close of a resumed session or duration. Conflicting metadata for a replay is rejected.

The parser reads only allowlisted identifiers, optional timestamp, workspace and model identifier. Response text, prompts, tool arguments/results, transcript paths, credentials and errors are dropped. It never opens transcript files. Antigravity supplies its model identifier; other adapters currently leave model unknown. Without an event timestamp, the first successful capture time is retained. Multi-workspace Antigravity activity remains unattributed (`cwd: null`). Common snake_case hook envelopes cannot identify their vendor, so the configured `--tool` determines that identity.

## Run the bridge

Requirements: the existing NexusAPI checkout with its dependencies installed, and Node on the hook's PATH. Use absolute paths to both the installed `tsx` runner and the script. Replace `/absolute/NexusAPI` below with your checkout; quote paths containing spaces. On Windows, forward-slash paths such as `D:/Projects/NexusAPI` work with Node. Keep the hook's working directory at the observed project; do not `cd` into NexusAPI.

```sh
node "/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs" "/absolute/NexusAPI/scripts/agent-usage.ts" --tool qoder --format agent-hook
```

Each invocation consumes one JSON payload from stdin (maximum 1 MiB). It appends canonical metadata JSONL to `~/.nexusapi/usage/<tool>.jsonl`; repeats append nothing. The observer imports that spool through its existing agent telemetry discovery. Success prints exactly `{}` to stdout and aggregate counters to stderr. Errors use redacted diagnostic codes and exit 1; this command emits no block/continue/permission decisions. It starts no listener and accesses no database. Configure only the events described below. Merge these entries into existing settings; the bridge does not install or replace hook configuration.

## Windsurf Cascade

Add to workspace `.devin/hooks.json`. Current documentation retains `.windsurf/hooks.json` as a fallback when the newer file has no hooks. Register `post_cascade_response`, not the transcript variant. Workspace attribution uses the hook process directory. Human-readable `model_name` is not treated as a stable model ID. [Official Cascade hooks](https://docs.windsurf.com/windsurf/cascade/hooks).

```json
{
  "hooks": {
    "post_cascade_response": [{
      "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool windsurf --format agent-hook",
      "show_output": false
    }]
  }
}
```

## CodeBuddy Code

Merge into `.codebuddy/settings.json` or user `~/.codebuddy/settings.json`; review changes in `/hooks`. CodeBuddy on Windows uses Git Bash for hook commands. `generation_id` is optional; missing IDs produce no Stop record. A lifecycle `SessionEnd` entry with the same command can provide once/session presence when generation IDs are unavailable. [Official CodeBuddy CLI hooks](https://www.codebuddy.ai/docs/cli/hooks), [Chinese reference](https://www.codebuddy.cn/docs/cli/hooks).

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool codebuddy --format agent-hook",
      "timeout": 30
    }] }]
  }
}
```

## Factory Droid

Standalone `.factory/hooks.json` or `~/.factory/hooks.json` is keyed directly by event, without an outer `hooks` property. `message_id` is optional; missing IDs produce no Stop record. Add `SessionEnd` using the same matcher-group structure if once/session presence is also useful. [Official Factory hooks](https://docs.factory.ai/harness/hooks).

```json
{
  "Stop": [{ "hooks": [{
    "type": "command",
    "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool factory_droid --format agent-hook",
    "timeout": 30
  }] }]
}
```

## Qoder CLI

Merge into `.qoder/settings.json` or user `~/.qoder/settings.json`. Successful post-tool events include `tool_use_id`; no prompt or tool content is needed. This adapter does not claim Qoder IDE hook compatibility or token capture. SessionStart with source startup/new and SessionEnd are also accepted, once/session. [Official Qoder CLI hooks](https://docs.qoder.com/cli/hooks).

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool qoder --format agent-hook",
      "timeout": 30
    }] }]
  }
}
```

## Kiro CLI

For CLI 3.x, create `.kiro/hooks/nexus-activity.json` using the standalone format below. The migration guide maps old `agentSpawn` to `SessionStart`. Legacy CLI 2.x agent configurations can add `hooks.agentSpawn: [{"command": "..."}]` using the same command. This is session presence only: no documented stable turn ID or usage counters are inferred. [Kiro hooks](https://kiro.dev/docs/hooks/), [official CLI 3.0 migration](https://kiro.dev/docs/cli/v3/migration-guide/).

```json
{
  "version": "v1",
  "hooks": [{
    "name": "nexus-session-activity",
    "trigger": "SessionStart",
    "action": {
      "type": "command",
      "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool kiro --format agent-hook"
    },
    "timeout": 30,
    "enabled": true
  }]
}
```

## Google Antigravity

Merge this named hook into workspace `.agents/hooks.json` or global `~/.gemini/config/hooks.json`. The official PostToolUse payload has no event-name field: this adapter interprets `toolCall` plus `stepIdx` as the configured post-tool event. **Register only PostToolUse**; do not register it as PreToolUse, which has an indistinguishable payload and a different permission contract. The documented PostToolUse response is `{}`. [Official Antigravity hooks](https://www.antigravity.google/docs/hooks).

```json
{
  "nexus-activity": {
    "PostToolUse": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node \"/absolute/NexusAPI/node_modules/tsx/dist/cli.mjs\" \"/absolute/NexusAPI/scripts/agent-usage.ts\" --tool antigravity --format agent-hook",
      "timeout": 30
    }] }]
  }
}
```

These adapters have fixture and CLI replay tests against documented shapes. They have not been exercised inside each vendor's installed client; vendor updates or policies can change hook availability. To verify a local installation, trigger the configured event and check the corresponding metadata spool and observer status. A zero-record import can mean a missing stable event ID, an unsupported event, or a disabled hook; it is not evidence of zero token usage.
