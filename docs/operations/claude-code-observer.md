# Claude Code 本地会话与自定义渠道

Claude Code 直接调用自定义上游时，NexusAPI 网关不会收到请求。“我的连接”绑定项目只登记关系，不会拦截其他程序的网络请求。若希望看到网关请求，客户端必须使用 NexusAPI 的网关地址、NexusAPI 下游密钥和支持的协议；不要直接把上游密钥当作 NexusAPI 密钥。

无需改变现有 Claude Code 调用方式，也可在“项目 → 用量分析”查看本地会话。管理员在运行 Observer 的同一台机器上配置：

1. 在“项目”登记 Claude Code 实际使用的工作目录。
2. 在已有 `config/nexus-observer.json` 中保留 `tenantId`、`organizationId`、`sources`、`roots`、`providers`，添加 `claudeSources`。例如 Windows 使用 `"claudeSources": ["C:/Users/YOUR_USER/.claude/projects"]`。也可只指定该项目对应的子目录或某个 JSONL 文件。自定义 `CLAUDE_CONFIG_DIR` 的用户填写实际目录。`sources` 仍用于 Codex；只有 Claude 时可以为空数组。
3. 升级后执行正常数据库迁移，再重启 `npm run dev:local`（含 Observer）。配置变更随后自动生效，默认每 60 秒扫描。旧的 Codex 配置页面保存时会保留 Claude 路径。
4. 在“用量与计费”或项目分析选择“Claude Code · 本地观测”，时间范围包含会话时间，展开模型分组中的会话详情。

日志中的工作目录决定项目归属；未匹配的目录保留为未归属。日志通常不包含可信的历史上游地址或渠道 ID，因此连接、供应商和订阅会保持未知。不能仅凭 `glm-*` 等模型名或当前 settings.json 反推历史渠道。Claude Code 这个工具也不等于 Claude 订阅。

只提取会话/消息 ID、时间、工作目录、CLI 版本、模型和 Token 计数，不保存正文、标题或密钥。重复内容块按消息去重，后续完整计数单调更新同一观测。输入包含普通输入、缓存写入和缓存读取；“缓存输入”仅指缓存读取，已包含在输入中。自定义上游返回的统计仍属于客户端观测，不能用于认定供应商账单。工具输出、失败响应或没有 usage 的消息不产生用量记录。

本地记录不会产生费用、充值、网关请求或官方订阅额度；如同一请求同时经过网关并被本地采集，两种来源单独展示，不代表两笔收费。

回滚时移除 `claudeSources` 并重启旧版本，保留兼容的数据库约束及已导入数据。`observer:codex delete-observations` 仍仅清理 Codex 来源，不能用于清理 Claude 数据。

官方说明：[会话存储目录](https://code.claude.com/docs/en/claude-directory)、[缓存 Token 口径](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。
