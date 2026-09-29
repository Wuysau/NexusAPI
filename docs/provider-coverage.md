# 订阅产品接入与能力边界

核对日期：2026-09-29。以下记录本版本实现能力与官方接入来源。产品名称、套餐、区域端点与模型权限会变化；不内置价格或推测的额度 API，也未使用真实供应商账号逐一联调。

## NexusAPI 中的三种能力

- **登记与项目绑定**：所有目录产品均可登记。`POST /api/connections` 的 `subscription_interactive` 模式接受已知 `subscriptionProduct`，校验供应商匹配，不接收密码、Cookie、API Key、令牌或客户端自报能力。未指定产品保留旧版 OpenAI Codex 行为。登记始终 `routing: false`。
- **账户与额度观测**：Codex 保留原生 App Server 与本地 Observer。其他支持项可使用 CodexBar 采集器导入/本机读取的账户快照，来源标记 `collector_reported`，不冒充原生官方接口。采集器是否能读取某个账号仍受平台、版本、授权与登录状态影响。未观测和过期数据保持未知；本地 token 量不能换算成订阅剩余额度。
- **授权 API 渠道**：目录的普通 API 预设使用开放平台独立密钥，由现有渠道密钥平面保存。受限 Coding Plan 端点仅作为官方工具配置指南展示，不自动成为通用网关渠道。兼容协议只是技术前提，不代表套餐允许转售、通用后端或任意工具调用。

## 产品覆盖与官方来源

“采集器”表示已实现 CodexBar 数据导入路径和显式产品映射，不表示 NexusAPI 内置供应商登录、轮询 API 或保证所有额度字段存在。

| 产品 | 本版本观测 | 授权调用 / 主要限制 | 官方来源 |
| --- | --- | --- | --- |
| OpenAI Codex | 原生本机账户、额度与本地会话 | ChatGPT 登录用于 Codex；普通 API 另用开放平台密钥 | [Codex 认证](https://developers.openai.com/codex/auth/) |
| Claude Code | 采集器 | Claude 账号订阅与 Console API 认证分离；不抽取登录令牌作为网关密钥 | [认证](https://code.claude.com/docs/en/authentication) |
| Gemini / Google AI | 采集器 | CLI 可用 Google 账号；Developer API 独立配置，用其 OpenAI 兼容接口接入渠道 | [CLI 认证](https://geminicli.com/docs/get-started/authentication/)、[兼容 API](https://ai.google.dev/gemini-api/docs/openai) |
| GitHub Copilot | 采集器 | 本版本无 Copilot 推理网关。官方有管理与用量 REST API，但此版本没有直接实现 | [产品说明](https://docs.github.com/en/copilot/get-started/about-github-copilot)、[REST API](https://docs.github.com/en/rest/copilot) |
| Cursor | 采集器 | BYOK 是 Cursor 使用供应商密钥，不等于 Cursor 订阅可导出为 API | [BYOK](https://cursor.com/help/models-and-usage/api-keys) |
| Windsurf / Devin Desktop | 采集器，需确认安装版本仍对应 Windsurf 数据源 | 原 Windsurf 用量文档已重定向至 Devin Desktop；不宣称订阅可当通用 API | [当前用量文档](https://docs.devin.ai/desktop/accounts/usage) |
| Kiro | 采集器 | 官方客户端登录；本版本不提供订阅推理转接 | [官方文档](https://kiro.dev/docs/) |
| JetBrains AI | 采集器 | IDE 套餐与供应商 API 权限分离 | [套餐与用量](https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html) |
| TRAE | 仅登记 | 官方文档为动态页面，此次未能提取具体认证/额度接口，未添加自动观测或 API 预设 | [文档入口](https://docs.trae.ai/) |
| Qwen Code | 仅登记 | 当前文档不再推荐历史 Qwen OAuth；选择 Model Studio / 第三方 / 自定义认证，普通百炼 API 单独配置 | [当前认证](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)、[主仓库](https://github.com/QwenLM/qwen-code) |
| Kimi Code / Kimi | 采集器 | Code 会员端点与开放平台端点、密钥不互换；渠道预设为开放平台 | [官方 FAQ](https://www.kimi.com/code/docs/en/kimi-code/faq.html)、[开放平台](https://platform.moonshot.ai/docs/guide/start-using-kimi-api) |
| GLM / Z.ai Coding Plan | 采集器 | Coding Plan 限官方支持工具/环境；通用 API 预设使用 `/api/paas/v4`，专用 coding 端点只作指南 | [工具与端点限制](https://docs.z.ai/devpack/tool/others)、[普通 API](https://docs.z.ai/guides/overview/quick-start) |
| MiniMax Coding / Token Plan | 采集器 | 旧 Coding Plan 文档现指向 Token Plan。Subscription Key 可用资源依席位与 Credits；普通 API 密钥与订阅授权不要混淆 | [Token Plan](https://platform.minimax.io/docs/token-plan/intro)、[OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api) |
| 阿里云百炼 / Coding Plan | 采集器 | Coding Plan 专用密钥与区域端点必须匹配，限制为编程工具用途；渠道预设使用普通按量 API | [Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)、[普通兼容 API](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) |
| 火山方舟 / Coding · Agent Plan | 仅登记 | Coding Plan 与 Agent Plan 从各自控制台获取端点/密钥；此次不固定区域或套餐专用 URL | [官方套餐 FAQ](https://docs.volcengine.com/docs/ark/agent-plan-personal-faq?lang=zh) |
| 腾讯混元 / TokenHub | 仅登记 | 预设仅适用于既有混元兼容 API；官方提示新购/新模型向 TokenHub 迁移，新服务需核对控制台。元宝订阅不等同 API 权限 | [官方兼容接口](https://cloud.tencent.cn/document/product/1729/111007) |
| DeepSeek | 采集器 | 普通开放平台 API；不推定消费订阅可复用 | [首次 API 调用](https://api-docs.deepseek.com/zh-cn/) |
| Grok / xAI | 采集器 | 消费订阅与开发者 API 分离；管理 API 另有管理密钥，本版本不直接调用 | [开发者接入](https://docs.x.ai/developers/quickstart)、[管理 API](https://docs.x.ai/developers/management-api-guide) |
| Perplexity | 采集器 | 普通 Sonar API 使用开发者密钥；不假设消费套餐自动提供 API 余额 | [概览](https://docs.perplexity.ai/docs/getting-started/overview)、[Sonar](https://docs.perplexity.ai/docs/sonar/quickstart) |

## 采集器与授权渠道的配置

1. 添加订阅连接，选择产品并绑定项目。原生 Codex 使用现有账户同步和 Observer。
2. 其他支持采集器的产品在详情中导入 CodexBar JSON 或读取本机已配置采集器；预览后明确绑定账号。采集器返回未知/脱敏身份时不能猜测匹配到当前连接。
3. 如需网关调用，点击“配置授权 API 渠道”，选用普通开放平台密钥、正确区域端点与获授权模型。界面不会复制订阅登录令牌。模型列表和具体协议扩展能力仍需渠道测试确认。
4. 官方支持的 Coding Plan 编程工具按官方文档直连配置；其专用 URL 展示不构成通用网关支持或授权承诺。独立代理端点必须由操作者自行运营/授权并符合上游许可范围。

CodexBar 产品映射依据其[主仓库](https://github.com/steipete/CodexBar)和[provider IDs 文档](https://github.com/steipete/CodexBar/blob/main/docs/provider-ids.md)。只集成数据边界，不复制采集器代码。NexusAPI 内的官方原生观测、采集器快照与网关请求用量各有独立来源，不相互补造额度。
