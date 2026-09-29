# Agent 工具覆盖矩阵

更新：2026-09-29。目录中的 **42 项是工具身份，不是 42 种原生支持**。当前主接入标签为：原生日志 11 项、导出 3 项、Hook 5 项、通用桥接 7 项、尚未适配 16 项。一个工具可以另有 Hook 路径；例如 Qoder 主标签为原生日志，Factory 主标签为导出。标签描述 NexusAPI 的实现范围，不评价工具自身能力。

“原生日志”也不保证完整 Token：Qoder IDE 目前只记录活动，Copilot CLI 持久化用量有限，部分计数语义不明确时保留未知。自动发现需要启用 Observer，并且本机存在已支持版本的文件。导出、Hook 和桥接都需要额外配置；“尚未适配”不会因安装或登记工具而自动产生记录。

## 已实现的原生日志、导出与 Hook

| 工具 ID | 工具 | 主接入方式 | 实际范围与限制 | 格式 / 官方依据 |
| --- | --- | --- | --- | --- |
| `codex` | Codex | 原生日志 | 自动发现 rollout JSONL；保留现有账户映射 | [Codex Observer](subscription-observer.md) |
| `claude_code` | Claude Code | 原生日志 | 自动发现 projects JSONL；自定义模型不改变工具身份 | [采集配置](agent-observer.md) |
| `gemini_cli` | Gemini CLI | 原生日志 | chats JSON/JSONL；项目 hash 不推算工作目录 | [官方源码与语义](agent-native-cli-sources.md#gemini-cli) |
| `qwen_code` | Qwen Code | 原生日志 | projects/chats JSONL；不将所有 Gemini 衍生格式视为兼容 | [官方源码与语义](agent-native-cli-sources.md#qwen-code) |
| `opencode` | OpenCode | 导出 | 明确导入 `opencode export` JSON，不读取内部 SQLite | [官方导出格式](agent-native-cli-sources.md#opencode) |
| `cline` | Cline | 原生日志 | 扩展 tasks/ui_messages.json；缓存重叠语义不明时输入未知 | [格式与官方源码](agent-native-ide-sources.md) |
| `roo_code` | Roo Code | 原生日志 | 扩展任务快照；后续更新补齐同一请求 | [格式与官方源码](agent-native-ide-sources.md) |
| `kilo_code` | Kilo Code | 原生日志 | 兼容旧版扩展任务格式；不代表当前 CLI / SQLite 格式支持 | [旧版边界](agent-native-ide-sources.md) |
| `github_copilot` | GitHub Copilot | 原生日志 | CLI events.jsonl；未持久化的用量未知，IDE 不属该适配范围 | [CLI 持久化限制](agent-native-ide-sources.md) |
| `cursor` | Cursor | Hook | afterAgentResponse / stop 需稳定事件 ID；未报告 Token 未知 | [官方 Hook 配置](agent-telemetry.md#cursor-官方-hooks) |
| `windsurf` | Windsurf / Cascade | Hook | post_cascade_response，trajectory_id + execution_id；仅活动 | [官方 Hook 指南](agent-hooks.md#windsurf-cascade) |
| `kiro` | Kiro CLI | Hook | SessionStart / 旧 agentSpawn，每会话一次；不表示回合数 | [版本与配置](agent-hooks.md#kiro-cli) |
| `kimi_cli` | Kimi CLI | 原生日志 | wire.jsonl 的 StatusUpdate；上下文占用不作为消耗 | [格式与官方源码](agent-native-ide-sources.md) |
| `pi` | Pi Coding Agent | 原生日志 | 自动发现 v2/v3 JSONL；缓存、分支与复制历史按格式处理 | [官方源码与版本](agent-extended-cli-sources.md#pi-native-session-jsonl) |
| `qoder` | Qoder | 原生日志 | IDE transcript 自动扫描，仅活动；CLI 可选 PostToolUse Hook | [IDE 官方格式](agent-extended-ide-sources.md#qoder-ide-native-activity)、[CLI Hook](agent-hooks.md#qoder-cli) |
| `factory_droid` | Factory Droid | 导出 | SDK 单轮 DroidResult；缓存/推理包含关系不明确的计数未知；另支持带 message_id 的 Stop Hook | [SDK 导出边界](agent-extended-cli-sources.md#factory-droid-official-sdk-result-export)、[Hook](agent-hooks.md#factory-droid) |
| `codebuddy` | 腾讯 CodeBuddy | Hook | Stop 需要 generation_id；缺失时跳过，不读取未验证的原生记录 | [官方 Hook 配置](agent-hooks.md#codebuddy-code) |
| `antigravity` | Google Antigravity | Hook | 仅 PostToolUse，conversationId + stepIdx；多工作目录不猜归属 | [官方 Hook 配置](agent-hooks.md#google-antigravity) |
| `openclaw` | OpenClaw | 导出 | 仅旧版 Pi 形状 v2/v3 JSONL；不读取当前 SQLite，不自动扫描旧目录 | [官方存储与边界](agent-extended-cli-sources.md#openclaw-legacy-pi-shaped-jsonl-only) |

Pi 默认扫描 `~/.pi/agent/sessions`，支持绝对路径 `PI_CODING_AGENT_DIR`；Qoder 默认扫描 `~/.qoder/projects` 下的 transcript JSONL。Factory 与 OpenClaw 要添加明确路径、选择已实现的原生格式解析器，并按需要设置实际工作目录。它们的原始导出不要放入只接收规范化遥测的 `~/.nexusapi/usage`。

## 通用桥接：需要运行方提供实际事件

这些工具没有内置原生记录解析器。桥接接受规范化 JSON 或满足稳定身份与用量语义要求的 OTLP JSON；它不是现成的厂商 API 集成，也不会从任意聊天导出自动提取 Token。没有带稳定会话/事件 ID 的真实数据时，登记工具仍无法采集。配置见[通用元数据接入](agent-telemetry.md)。

| 工具 ID | 工具 | 当前边界 | 官方参考 |
| --- | --- | --- | --- |
| `trae` | TRAE / SOLO | 仅规范化事件桥接，无内置原生日志解析 | [产品](https://www.trae.ai/) |
| `continue` | Continue | dev_data 缺少可靠会话/事件关联，不凭时间或模型猜测联接 | [官方格式调查](agent-extended-ide-sources.md#continue-native-capture-deliberately-unavailable) |
| `aider` | Aider | 运行方转换真实元数据；经过网关的请求另按网关来源记录 | [产品](https://aider.chat/) |
| `goose` | Goose | 运行方转换实际遥测或元数据，无内置会话存储适配 | [项目](https://github.com/aaif-goose/goose) |
| `amp` | Amp | 未建立完整稳定导出格式适配；需要明确身份的桥接事件 | [官方格式调查](agent-extended-ide-sources.md#amp-investigation) |
| `augment` | Augment | 需要真实元数据，缺少计数时仅记录活动 | [产品](https://www.augmentcode.com/) |
| `jetbrains_junie` | JetBrains Junie | 不推测 IDE 内部存储；需要运行方提供事件 | [产品](https://junie.jetbrains.com/) |

## 尚未内置适配

以下 16 项仅用于如实展示工具身份与接入缺口。官方链接用于产品/项目识别，不表示 NexusAPI 已实现对应接口，也不证明该工具完全不提供导出能力。可由工具或部署方提供真实规范化事件后使用通用接口；这仍不改变“尚未内置适配”的状态。

| 工具 ID | 工具 | 当前限制 | 官方参考 |
| --- | --- | --- | --- |
| `crush` | Crush | 尚无 SQLite 格式适配 | [官方项目](https://github.com/charmbracelet/crush) |
| `hermes_agent` | Hermes Agent | 尚无会话数据库适配；汇总不能代替独立调用身份与时间 | [官方项目](https://github.com/NousResearch/hermes-agent) |
| `openhands` | OpenHands | 尚无 SDK / 云端事件解析或远程同步 | [官方项目](https://github.com/OpenHands/OpenHands) |
| `swe_agent` | SWE-agent | 尚无 trajectory 格式适配 | [官方项目](https://github.com/SWE-agent/SWE-agent) |
| `zed` | Zed Agent | 尚无原生会话适配；外部 Agent 按实际工具身份记录 | [官方 Agent 文档](https://zed.dev/docs/ai/agents) |
| `warp` | Warp Agent | 尚无会话适配；终端中的其他 Agent 不自动归为 Warp | [官方 CLI 文档](https://docs.warp.dev/agents/cli/quickstart/) |
| `amazon_q` | Amazon Q Developer | IDE 尚无适配；迁移后的 CLI 按 Kiro 接入 | [官方 CLI 项目](https://github.com/aws/amazon-q-developer-cli) |
| `tongyi_lingma` | 通义灵码 / Lingma | 尚无本地格式适配，不视为 Qwen 或 Qoder | [官方产品](https://lingma.aliyun.com/) |
| `baidu_comate` | 百度 Comate / Zulu | 尚无本地格式适配；MCP 支持不等于 Token 遥测 | [官方文档](https://comate.baidu.com/docs/vscode.html) |
| `huawei_codearts` | 华为 CodeArts Agent | 尚无记录适配，需要实际用量元数据 | [官方产品说明](https://support.huaweicloud.com/intl/en-us/productdesc-codeartsagent/codeartsagent_pd_0001.html) |
| `tabnine` | Tabnine Agent | 尚无 CLI / IDE 记录适配，不自动读取企业账户 | [官方 CLI 产品](https://www.tabnine.com/platform-cli/) |
| `devin` | Devin | 尚无远程会话同步；旧版 API 文档不代表当前版本适配 | [官方会话 API 参考](https://docs.devin.ai/api-reference/v1/sessions/retrieve-details-about-an-existing-session) |
| `replit_agent` | Replit Agent | 尚无云端记录或账户用量同步 | [官方文档](https://docs.replit.com/welcome) |
| `bolt` | Bolt.new | 尚无云端用量导出适配；导出的代码不是用量日志 | [官方项目设置](https://support.bolt.new/building/using-bolt/project-settings) |
| `lovable` | Lovable | 尚无云端记录同步；套餐 credits 不换算为 Token | [官方文档](https://docs.lovable.dev/introduction/welcome) |
| `v0` | Vercel v0 | 尚无云端对话同步；应用模型调用与构建 Agent 用量分开 | [官方文档](https://v0.app/docs) |

## 记录与计费边界

- 工具身份、模型、API 渠道和订阅是不同信息；不能根据相同供应商或模型名互相推断。
- 本地活动和 Token 不产生 NexusAPI 钱包扣费。网关账单、订阅额度与本地观测分别展示。
- Hook 不读取转录文件；原生解析只输出允许的元数据，不保存提示词、回答、工具参数或凭据。
- 对同一活动选择一种采集路径。不同适配路径没有共同事件 ID 时，无法自动识别它们是否代表同一次调用。
- 自动发现是已知目录和格式的扫描，不是任意软件流量捕获。工具更新格式后可能需要更新适配器。

主入口见[采集手册](agent-observer.md)。新增三份指南分别提供可追溯的官方格式依据：[Pi / Factory / OpenClaw](agent-extended-cli-sources.md)、[Qoder IDE 与格式调查](agent-extended-ide-sources.md)、[六类官方 Hook](agent-hooks.md)。测试使用官方形状的合成样例和本地 CLI 重放，不代表已在所有厂商客户端现场验证。
