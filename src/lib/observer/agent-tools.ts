/** Public tool identities, independent of provider, channel and paid subscription. */
export const AGENT_TOOL_ID = /^[a-z][a-z0-9_]{0,47}$/
export const LOCAL_SOURCE_PATTERN = '^(gateway|codex_local|claude_code_local|agent:[a-z][a-z0-9_]{0,47})$'
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
  { id: 'windsurf', name: 'Windsurf', capture: 'bridge', hint: '元数据/遥测或网关接入；无已验证本地用量文件' },
  { id: 'kiro', name: 'Kiro', capture: 'bridge', hint: '元数据/遥测或网关接入；不读取登录凭据' },
  { id: 'trae', name: 'TRAE', capture: 'bridge', hint: '元数据/遥测或网关接入；不推测客户端内部存储' },
  { id: 'continue', name: 'Continue', capture: 'bridge', hint: '将开发数据或遥测转换为通用事件，或配置网关' },
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
