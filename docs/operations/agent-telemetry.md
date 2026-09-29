# Agent 本地元数据采集

此适配器接收本地 JSON 文件或 stdin，生成 `~/.nexusapi/usage/<tool>.jsonl`。它不启动 OTLP HTTP 服务、不连接数据库、不登录供应商、不读取认证文件。此数据是客户端用量观测，不是供应商账单或订阅剩余额度。

## 支持范围

- `canonical`：明确提供稳定会话、事件标识和时间的 schema v1 元数据。
- `otlp`：OTLP HTTP/JSON 的 `resourceLogs` / `scopeLogs` / `logRecords` 与 `resourceSpans` / `scopeSpans` / `spans`。不支持 protobuf、gRPC、metrics，也不将普通文本日志视为用量。
- `cursor-hook`：官方 `afterAgentResponse` 和 `stop` 输入。默认只记录会话、生成、模型和单工作目录；官方 Hook 未定义 token 用量字段，因此缺省值保持 `null`。

任意工具 ID 可使用规范化事件，格式为 `^[a-z][a-z0-9_]{0,47}$`。例如 `codex`、`claude_code`、`gemini_cli`、`qwen_code`、`opencode`、`cline`、`roo_code`、`kilo_code`、`github_copilot`、`cursor`、`windsurf`、`kiro`、`trae`、`continue`、`aider`、`kimi_cli`、`goose`、`amp`、`augment`、`jetbrains_junie`。接受 ID 不代表自动支持该工具的私有日志格式。

## 规范化事件

```json
{
  "schemaVersion": 1,
  "tool": "github_copilot",
  "sessionId": "session-20260929",
  "eventId": "request-1",
  "timestamp": "2026-09-29T12:00:00Z",
  "cwd": "D:/Projects/Example",
  "model": "authorized-model-id",
  "tokens": {
    "input": "100",
    "cached": "40",
    "output": "20",
    "reasoning": "5",
    "total": "120"
  },
  "kind": "cli",
  "parentSessionId": null
}
```

`input` 包含缓存输入，`output` 包含推理输出；`cached` 和 `reasoning` 是子集，不能重复相加。计数接受非负安全整数或十进制整数字符串，上限为 PostgreSQL signed bigint。未知字段使用 `null` 或省略；不会将缺失计数当作零，也不会凭正文长度估算 tokens。`total` 已知时必须与已知的 input + output 一致。

会话、事件和模型标识最多 160 个 ASCII 标识字符；路径必须是绝对路径。`kind` 可为 `cli`、`subagent` 或 `other`。规范化 payload 的 `tool` 必须与命令行指定工具相同。额外字段不写入输出。

```powershell
Get-Content -Raw .\event.json | node --import tsx scripts/agent-usage.ts --tool github_copilot --format canonical
```

```bash
node --import tsx scripts/agent-usage.ts --tool github_copilot --format canonical < event.json
```

stdin 接受一个 JSON 对象或对象数组，最多 1 MiB。已有 JSONL 文件应逐行解析并逐条提供，而不是一次拼成非法 JSON。CLI 默认输出 `~/.nexusapi/usage/github_copilot.jsonl`；可选 `--output` 只接受该目录的直接 `.jsonl` 子文件，不接受任意认证文件路径。输出以 UTF-8 追加，相同 session/event 的重复记录被去重；后续计数可从未知变成已知，或单调增加，作为同事件的新版本追加，并保留最初事件时间。计数倒退、模型/工作目录/父会话变化，或合并后计数关系不一致时拒绝重放。导入器必须按事件身份合并版本，不能把 JSONL 每一行相加。单文件最大 64 MiB；轮换前先完成导入并妥善保留需要的历史文件。崩溃遗留 `.lock` 时，确认没有采集进程使用该文件后再清理锁。

## Cursor 官方 Hooks

下面的项目级配置适用于本 NexusAPI 检出目录，要求已有 Node.js 和本仓库依赖。在项目根目录创建 `.cursor/hooks.json`；其他项目可将命令中的 loader 和脚本改为该检出目录的绝对路径。不要覆盖已有 hook 配置，应合并 `hooks` 下的对应数组。

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      { "command": "node --import tsx scripts/agent-usage.ts --tool cursor --format cursor-hook" }
    ],
    "stop": [
      { "command": "node --import tsx scripts/agent-usage.ts --tool cursor --format cursor-hook" }
    ]
  }
}
```

Cursor 向 stdin 提供 `conversation_id`、`generation_id`、`hook_event_name`、模型和工作目录等基础字段。适配器忽略 `text`、邮箱、transcript 路径、提示词和工具参数；不会打开 transcript。没有 `event_id` 时使用 conversation + generation + hook 类型生成稳定 ID，因此同一 generation 同一 Hook 类型只记一次。两类 Hook 是不同事件。多根工作区不猜测归属，路径保留未知。官方 Hook 没有事件时间时，记录捕获时间；重试保持相同事件 ID。CLI 向 Hook stdout 返回 `{}`，不请求后续 Agent 运行。[官方 Hooks 文档](https://cursor.com/docs/hooks)

## OTLP JSON 文件导入

```powershell
Get-Content -Raw .\otlp-export.json | node --import tsx scripts/agent-usage.ts --tool gemini_cli --format otlp
```

此命令接收已由你配置的 exporter/collector 产生的 JSON。不要把它配置为网络 OTLP endpoint。OTLP JSON 的时间戳为纳秒整数字符串，属性使用 `stringValue`、`intValue` 等类型包装；适配器按这些结构解析。[OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)

适配器仅提取以下元数据：

- `session.id` / `gen_ai.conversation.id` / `nexus.session.id`；没有稳定会话时跳过。
- 明确 event/request/response ID、trace + span ID，或 prompt/sequence + 原始时间组成的稳定事件键。缺失稳定关联字段时跳过，不对正文做指纹。
- `gen_ai.request.model` / `gen_ai.response.model`，以及标准 input/output 计数。可选缓存、推理和 total 计数只有源实际提供时保留。
- 自定义 `nexus.tool`、`nexus.cwd`、`nexus.parent_session_id`。显式工具身份不匹配时拒绝；这些 `nexus.*` 字段是本集成约定，不是供应商自带能力。

对于 Claude Code 的 `api_request` 事件，适配器将 `input_tokens`、`cache_read_tokens`、`cache_creation_tokens` 相加得到包含缓存的输入；任一缺失时不假设为零。对于 Gemini CLI 的 `gemini_cli.api_response`，输出由候选输出加 thoughts 构成，缓存输入不重复计算。工具使用 prompt 计数另有语义时不声称 total 已符合规范化分解。两种工具都应主动配置遥测；不要开启提示词或响应正文采集来获得 token 元数据。[Claude Code 监测](https://code.claude.com/docs/en/monitoring-usage)、[Gemini CLI 遥测](https://geminicli.com/docs/cli/telemetry/)

同一调用不要同时从原生日志、Hook、OTLP logs 和 traces 重复提供；仅在上游具有相同 request ID 时才可可靠跨导出路径去重。父 Agent 汇总跨度和子模型调用也不可同时作为独立消耗导入。此模块没有自动推断这些关系。

## Copilot 与其他工具

Copilot 官方 Hook 可以提供 session、时间和 cwd，但并非每个版本或事件都带唯一事件 ID 和完整 tokens。本版本不直接解析 Copilot Hook；由你控制的适配脚本生成上述 `canonical` 事件，只有存在稳定上游事件标识时才上报，缺失 tokens 保持未知。不要保存 `prompt`、`toolArgs` 或以正文 hash 替代事件标识。[Copilot Hooks 参考](https://docs.github.com/en/copilot/reference/hooks-reference)

其他 Agent 工具同样可通过真实 exporter 或获授权的 Hook 生成规范化元数据。订阅额度、服务端实际计费和经过 NexusAPI 网关的请求是不同来源；本地用量不能自动证明套餐可通过网关调用。
