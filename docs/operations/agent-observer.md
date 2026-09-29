# 记录不同 Agent 工具的用量

在「用量与计费」展开 **Agent 工具采集**，可以查看每种工具的接入方式、本机来源、已有会话及最近观测时间。项目分析中的「工具来源」可以分别查看不同 Agent，即使它们使用同一个自定义渠道或相同的模型。

工具身份来自对应的日志适配器或明确的遥测字段，不根据模型名称猜测。Claude Code 使用自定义模型时仍显示 Claude Code。连接绑定项目并不会自动拦截该连接的请求；项目归属以会话工作目录匹配已登记的项目目录为准。

## 开始自动采集

1. 在「项目」中登记实际代码工作目录。
2. 本机管理员打开「用量与计费 → Agent 工具采集」，启用「自动发现本机工具记录」。本机管理入口目前使用 Windows 的 `npm run dev:local`；其他部署可由管理员编辑 Observer 配置。
3. 确认采集后台运行，再正常使用 Agent。后台每次轮询都会重新发现已支持的默认日志目录，因此之后安装的新工具无需重启或重复添加连接。已有明确的 Codex/Claude 目录配置继续限定原来的范围。
4. 点击「立即同步」，等待后台完成后「刷新状态」。进入项目分析，选择时间范围和工具来源，展开会话查看记录。

「发现来源」只表示目录存在；「已有记录」是历史采集结果。同步异常、路径缺失、后台停止分别显示，不以历史记录冒充正在采集。没有安装工具或尚未产生记录时，可以看到未发现来源的状态。

## 各工具怎样接入

| 工具 | 接入方式 | 使用说明 |
| --- | --- | --- |
| Codex | 自动发现原生日志 | `~/.codex/sessions`，支持 `CODEX_HOME`；保留原有账户映射 |
| Claude Code | 自动发现原生日志 | `~/.claude/projects`，支持 `CLAUDE_CONFIG_DIR`；可记录自定义模型 |
| Gemini CLI | 自动发现原生日志 | `~/.gemini/tmp` 中的 chats JSON/JSONL；缺少工作目录时手动指定 |
| Qwen Code | 自动发现原生日志 | `~/.qwen/projects/*/chats/*.jsonl` |
| OpenCode | 导出文件 | 使用 `opencode export` 导出的会话 JSON，添加为原生格式来源；不直接读取内部 SQLite |
| Cline | 自动发现扩展日志 | VS Code 等编辑器的 `globalStorage/saoudrizwan.claude-dev/tasks` |
| Roo Code | 自动发现扩展日志 | `globalStorage/rooveterinaryinc.roo-cline/tasks` |
| Kilo Code | 自动发现兼容扩展日志 | 兼容旧版 `globalStorage/kilocode.kilo-code/tasks`；新版 CLI 使用通用接入 |
| GitHub Copilot | 自动发现 CLI 日志 | `~/.copilot/session-state/*/events.jsonl`；未持久化的 Token 显示未知；IDE 使用通用接入 |
| Kimi CLI | 自动发现原生日志 | `~/.kimi/sessions` 中的 `wire.jsonl` |
| Cursor | 官方 Hook | 配置 `afterAgentResponse` / `stop`，记录活动；官方 Hook 未提供的 Token 保持未知 |
| Windsurf、Kiro、TRAE | 通用接入 | 需要工具实际提供的 Hook、遥测或导出数据，转换成通用事件；没有已验证的原生日志适配器 |
| Continue、Aider、Goose | 通用接入 | 将实际开发数据、用量导出或遥测转换为通用事件 |
| Amp、Augment、JetBrains Junie | 通用接入 | 使用工具提供的元数据导出；没有可用导出时不能自动捕获 |
| 其他新工具 | 自定义工具 ID | 通用事件支持新的工具 ID，无需改数据库或重新发布前端 |

自动发现是对已支持日志格式的持续扫描，不是对任意软件流量的拦截。需要配置的工具会明确显示「Hook 接入」或「通用接入」。工具版本更换存储格式后，应查看采集状态并更新适配器。经过 NexusAPI 网关的模型请求仍在网关用量中记录；网关不凭模型或供应商猜测客户端工具。

## 添加自定义目录与项目归属

在采集面板添加来源，填写工具 ID、原生/通用格式以及日志文件或目录的绝对路径。未知工具请选择通用格式。添加后不改写工具的登录、密钥或模型配置。

如果原生日志只保存项目 hash，或 IDE 任务不带工作目录，应针对**单个项目/任务目录**指定工作目录。不要将包含多个项目的全局日志目录全部映射到一个项目。配置的工作目录用于补充日志缺失的目录，不覆盖日志明确报告的目录。未匹配到项目的记录进入「未归属」；登记目录后使用现有归属功能处理历史记录，已归属的历史记录不会随意移动。

默认发现支持 Windows/Linux 常见路径；自定义编辑器数据目录、容器目录、远程主机日志请添加明确的来源。Observer 必须能访问这些文件。后台不会扫描任意文件夹寻找聊天正文，也不会读取供应商认证文件。

## Hook 接入

Cursor 可按[官方 Hook 配置示例](agent-telemetry.md#cursor-官方-hooks)合并现有 `.cursor/hooks.json`。其他项目需把示例中的脚本及 TypeScript loader 改成 NexusAPI 检出目录的绝对路径。系统不会自动覆盖已有 Hook。

通用接入器从 stdin 接收规范化事件或 OTLP JSON，输出到 `~/.nexusapi/usage/<tool>.jsonl`；开启自动发现后，该目录的新工具文件也会被采集。例如，在 NexusAPI 仓库目录运行：

```powershell
Get-Content -Raw .\agent-event.json | npm run --silent agent:usage -- --tool my_agent --format canonical
```

`my_agent` 可以替换为任意符合小写字母、数字、下划线规则的工具 ID。事件必须来自真实调用，包含稳定的会话/事件 ID 与时间；不要用生成的测试计数冒充实际用量。完整格式与 OTLP/Cursor 示例见[通用元数据接入](agent-telemetry.md)。此命令是文件/stdin 适配器，不是可直接填写到工具设置中的 HTTP OTLP 服务地址。

同一调用选择一种采集路径，避免同时导入原生日志、Hook 和 OTLP 的独立事件造成重复。相同工具、会话和事件 ID 的重放可去重，后续完整计数可以补齐原来的未知值。

## 如何理解记录

- 会话按工具分别统计；不同工具出现相同会话 ID 不会被合并。
- 输入包含缓存输入，输出包含推理输出；缓存和推理是子集，不再次相加。
- 工具只报告活动而不报告 Token 时，记录保留，计数显示未知。不会按照对话正文长度估算。
- 本地记录只保存允许的用量元数据，不保存提示词、回答或凭据；也不会产生钱包扣款。
- 本地 Token、订阅剩余额度、网关实际计费是三种不同的数据。仅绑定自定义连接不能证明某条本地记录属于该渠道。
- 文件最多 64 MiB、每次快照最多 50,000 个标准化事件。达到上限会报告来源异常；先确认已导入，再轮换日志。停止自动发现不会删除历史记录。

格式依据和版本边界见 [CLI 原生适配](agent-native-cli-sources.md)、[IDE / Copilot / Kimi 原生适配](agent-native-ide-sources.md)。
