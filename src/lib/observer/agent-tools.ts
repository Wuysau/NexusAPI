/** Public tool identities, independent of provider, channel and paid subscription. */
export const AGENT_TOOL_ID = /^[a-z][a-z0-9_]{0,47}$/
export const LOCAL_SOURCE_PATTERN = '^(gateway|codex_local|claude_code_local|agent:[a-z][a-z0-9_]{0,47})$'
export const AGENT_CATEGORIES = {
  cli: '终端 / CLI',
  ide: 'IDE / 编辑器',
  agent: '自托管 / 框架',
  cloud: '云端 Agent',
  other: '自定义',
} as const
export type AgentCategory = keyof typeof AGENT_CATEGORIES
const categoryTools: Record<Exclude<AgentCategory, 'other'>, string[]> = {
  cli: [
    'codex',
    'claude_code',
    'gemini_cli',
    'qwen_code',
    'opencode',
    'kimi_cli',
    'aider',
    'amp',
    'factory_droid',
    'pi',
    'crush',
    'warp',
  ],
  ide: [
    'cline',
    'roo_code',
    'kilo_code',
    'github_copilot',
    'cursor',
    'windsurf',
    'kiro',
    'trae',
    'continue',
    'augment',
    'jetbrains_junie',
    'qoder',
    'codebuddy',
    'antigravity',
    'zed',
    'amazon_q',
    'tongyi_lingma',
    'baidu_comate',
    'huawei_codearts',
    'tabnine',
  ],
  agent: ['goose', 'openclaw', 'hermes_agent', 'openhands', 'swe_agent'],
  cloud: ['devin', 'replit_agent', 'bolt', 'lovable', 'v0'],
}
export function agentCategory(tool: string): AgentCategory {
  return (Object.entries(categoryTools).find(([, ids]) => ids.includes(tool))?.[0] as AgentCategory) ?? 'other'
}
export function filterAgentTools<T extends { id: string; name: string; hint: string; capture: string }>(
  tools: readonly T[],
  query: string,
  category: string,
  capture: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return tools.filter(
    (tool) =>
      (category === 'all' || agentCategory(tool.id) === category) &&
      (capture === 'all' || tool.capture === capture) &&
      (!needle || `${tool.id} ${tool.name} ${tool.hint}`.toLocaleLowerCase().includes(needle)),
  )
}
export const AGENT_TOOLS = [
  { id: 'codex', name: 'Codex', capture: 'native', hint: '本地 rollout JSONL；沿用 Codex Observer' },
  { id: 'claude_code', name: 'Claude Code', capture: 'native', hint: '本地 projects JSONL；支持自定义模型' },
  {
    id: 'gemini_cli',
    name: 'Gemini CLI',
    capture: 'native',
    hint: '本地 chats JSON / JSONL；目录归属缺失时可手动指定工作目录',
  },
  {
    id: 'qwen_code',
    name: 'Qwen Code',
    capture: 'native',
    hint: '本地 projects/chats JSONL；基于实际记录的工作目录归属',
  },
  { id: 'opencode', name: 'OpenCode', capture: 'export', hint: '使用 opencode export 导出的会话 JSON' },
  { id: 'cline', name: 'Cline', capture: 'native', hint: 'VS Code 扩展 tasks/ui_messages.json；可设置工作目录' },
  { id: 'roo_code', name: 'Roo Code', capture: 'native', hint: 'VS Code 扩展 tasks/ui_messages.json' },
  { id: 'kilo_code', name: 'Kilo Code', capture: 'native', hint: '兼容 Cline 的扩展任务文件；CLI 使用通用接入' },
  {
    id: 'github_copilot',
    name: 'GitHub Copilot',
    capture: 'native',
    hint: 'CLI events.jsonl；未持久化的 Token 保持未知，IDE 使用通用接入',
  },
  { id: 'cursor', name: 'Cursor', capture: 'hook', hint: '官方 Hook 接入会话活动；Hook 未提供 Token 时显示未知' },
  {
    id: 'windsurf',
    name: 'Windsurf / Cascade',
    capture: 'hook',
    hint: '官方 post_cascade_response Hook；记录回合活动，Token 未知',
  },
  { id: 'kiro', name: 'Kiro', capture: 'hook', hint: 'CLI 官方会话生命周期 Hook；没有回合 ID 时不推算对话条数' },
  { id: 'trae', name: 'TRAE / SOLO', capture: 'bridge', hint: '仅通用元数据接入；尚无内置原生记录适配器' },
  {
    id: 'continue',
    name: 'Continue',
    capture: 'bridge',
    hint: 'dev_data 缺少会话/事件关联，需上报带稳定 ID 的通用事件',
  },
  { id: 'aider', name: 'Aider', capture: 'bridge', hint: '通过用量导出脚本接入通用事件，或配置网关' },
  { id: 'kimi_cli', name: 'Kimi CLI', capture: 'native', hint: '本地 wire.jsonl 的 StatusUpdate 用量' },
  { id: 'goose', name: 'Goose', capture: 'bridge', hint: '通过遥测/元数据接入或配置网关' },
  { id: 'amp', name: 'Amp', capture: 'bridge', hint: '通过工具导出的元数据接入；无法读取的用量保持未知' },
  { id: 'augment', name: 'Augment', capture: 'bridge', hint: '通过工具导出的元数据接入；未提供用量则仅记录活动' },
  {
    id: 'jetbrains_junie',
    name: 'JetBrains Junie',
    capture: 'bridge',
    hint: '通过工具导出的元数据接入；不推测 IDE 内部存储',
  },
  { id: 'pi', name: 'Pi Coding Agent', capture: 'native', hint: '原生 v2/v3 会话 JSONL；支持缓存计数与分支记录' },
  {
    id: 'qoder',
    name: 'Qoder',
    capture: 'native',
    hint: 'IDE transcript JSONL；记录会话活动，未报告的模型与 Token 保持未知',
  },
  {
    id: 'factory_droid',
    name: 'Factory Droid',
    capture: 'export',
    hint: '官方 SDK 单轮 DroidResult 导出或 Stop Hook；需配置后采集',
  },
  {
    id: 'codebuddy',
    name: '腾讯 CodeBuddy',
    capture: 'hook',
    hint: '官方 Stop Hook，generation_id 标识回合；未提供 Token 时记录活动',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    capture: 'hook',
    hint: '官方 PostToolUse Hook；记录会话中的工具执行活动，Token 未知',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    capture: 'export',
    hint: '旧版 Pi 会话 JSONL 导出；当前版本的 SQLite 存储尚未适配',
  },
  {
    id: 'crush',
    name: 'Crush',
    capture: 'unavailable',
    hint: '尚未内置其 SQLite 格式适配；安装工具不会自动产生 Nexus 记录',
  },
  {
    id: 'hermes_agent',
    name: 'Hermes Agent',
    capture: 'unavailable',
    hint: '尚未内置会话数据库适配；用量汇总文件缺少独立调用标识与时间',
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    capture: 'unavailable',
    hint: '尚未适配 SDK / 云端事件格式；可由部署方提供通用事件',
  },
  {
    id: 'swe_agent',
    name: 'SWE-agent',
    capture: 'unavailable',
    hint: '尚未内置 trajectory 格式适配；可由运行方提供通用事件',
  },
  {
    id: 'zed',
    name: 'Zed Agent',
    capture: 'unavailable',
    hint: '尚未内置 Zed 原生会话适配；外部 Agent 按实际工具来源记录',
  },
  {
    id: 'warp',
    name: 'Warp Agent',
    capture: 'unavailable',
    hint: '尚未内置 Warp 会话适配；终端内其他 Agent 不自动归为 Warp',
  },
  {
    id: 'amazon_q',
    name: 'Amazon Q Developer',
    capture: 'unavailable',
    hint: 'IDE 记录尚未内置适配；迁移后的 Kiro CLI 按 Kiro 接入',
  },
  {
    id: 'tongyi_lingma',
    name: '通义灵码 / Lingma',
    capture: 'unavailable',
    hint: '尚未内置本地记录适配；需提供带会话标识的用量元数据',
  },
  {
    id: 'baidu_comate',
    name: '百度 Comate / Zulu',
    capture: 'unavailable',
    hint: '尚未内置本地记录适配；MCP 支持本身不提供模型 Token 遥测',
  },
  {
    id: 'huawei_codearts',
    name: '华为 CodeArts Agent',
    capture: 'unavailable',
    hint: '尚未内置记录适配；需来自工具或部署方的实际用量元数据',
  },
  {
    id: 'tabnine',
    name: 'Tabnine Agent',
    capture: 'unavailable',
    hint: '尚未内置 CLI / IDE 记录适配；不自动读取企业账户数据',
  },
  { id: 'devin', name: 'Devin', capture: 'unavailable', hint: '云端记录不在本机目录；尚未内置远程会话同步' },
  {
    id: 'replit_agent',
    name: 'Replit Agent',
    capture: 'unavailable',
    hint: '云端记录不在本机目录；尚未内置账户用量同步',
  },
  { id: 'bolt', name: 'Bolt.new', capture: 'unavailable', hint: '云端记录需服务方导出；不会把导出的代码当作用量日志' },
  { id: 'lovable', name: 'Lovable', capture: 'unavailable', hint: '云端记录需服务方导出；套餐 credits 不换算成 Token' },
  {
    id: 'v0',
    name: 'Vercel v0',
    capture: 'unavailable',
    hint: '尚未内置云端对话同步；应用模型调用与构建 Agent 用量分开',
  },
] as const
export function agentToolSource(tool: string) {
  if (!AGENT_TOOL_ID.test(tool)) throw new Error('invalid_agent_tool')
  return tool === 'codex' ? 'codex_local' : tool === 'claude_code' ? 'claude_code_local' : `agent:${tool}`
}
export function sourceTool(source: string) {
  return source === 'codex_local'
    ? 'codex'
    : source === 'claude_code_local'
      ? 'claude_code'
      : source.startsWith('agent:')
        ? source.slice(6)
        : null
}
export function agentSourceLabel(source: string) {
  if (source === 'gateway') return 'NexusAPI 网关'
  const tool = sourceTool(source)
  return AGENT_TOOLS.find((x) => x.id === tool)?.name ?? tool ?? source
}
export const isUsageSource = (source: string) => source === 'all' || new RegExp(LOCAL_SOURCE_PATTERN).test(source)
