const messages = {
  already_syncing: '已有 Observer 同步正在运行，请等待本轮完成。',
  invalid_arguments: '命令参数无效。请运行 npm run observer:codex -- --help 查看用法。',
  database_missing: '未设置 DATABASE_URL。请在 .env.observer.local 或终端环境中配置与页面相同的数据库。',
  database_unreachable:
    '无法连接数据库。请确认 PostgreSQL 已启动，并核对 .env.observer.local / .env.local 的 DATABASE_URL 与页面数据库一致；终端环境变量优先。',
  database_auth_failed: '数据库认证失败。请在本机环境文件中检查数据库账号和密码；不要放进 Observer JSON。',
  database_unavailable: '目标数据库不存在或不可用。请核对 DATABASE_URL 的数据库名。',
  database_permission_denied: '数据库权限不足。请检查 Observer 数据库账号的读取/写入权限。',
  migration_required: '目标数据库缺少 Observer 所需表或字段。请确认连对数据库，并对该库执行正式迁移。',
  config_not_found:
    '找不到 Observer 配置。请在本机连接页面应用配置，或检查 CODEX_OBSERVER_CONFIG_PATH / --config 指定的路径。',
  config_unreadable: '无法读取配置文件，请检查文件权限与路径。',
  config_invalid_json: '配置文件不是有效 JSON，请重新下载 Observer 配置。',
  config_invalid: '配置字段无效。请重新下载配置，检查绝对路径、项目和连接映射；不要添加数据库密码。',
  organization_unavailable: '当前数据库中找不到配置所属组织。请先核对 CLI 与页面是否使用同一数据库。',
  project_unavailable: '当前数据库中找不到有效的项目。请核对数据库与项目状态后重新下载配置。',
  connection_unavailable:
    '当前数据库中找不到有效的订阅连接，或连接已撤销/映射不匹配。请核对数据库并从有效连接重新下载配置；页面创建的连接不需要执行 configure。',
  source_not_found: '找不到配置中的本机遥测路径，或扫描期间文件已移走。请在连接详情重新选择目录/JSONL 文件。',
  source_permission_denied: '无法读取本机遥测文件，请检查访问权限。',
  source_symlink: '遥测路径包含符号链接。请选择实际目录或 JSONL 文件。',
  observer_failed: 'Observer 操作失败。请检查本机数据库和配置；原始输入与数据库错误详情未输出。',
} as const
export type ObserverErrorCode = keyof typeof messages
export type ObserverStage = 'arguments' | 'config_read' | 'config_json' | 'config_validate' | 'database' | 'operation'
export class ObserverCliError extends Error {
  constructor(public readonly diagnosticCode: ObserverErrorCode) {
    super(diagnosticCode)
  }
}

/** Only fixed categories leave the CLI. Never return arbitrary exception text or nested input. */
export function observerDiagnostic(error: unknown, stage: ObserverStage) {
  let code: ObserverErrorCode = 'observer_failed'
  if (error instanceof ObserverCliError) code = error.diagnosticCode
  else {
    const e = error as { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } | null
    const systemCode = typeof e?.code === 'string' ? e.code : Array.isArray(e?.errors) ? e.errors[0]?.code : null
    const dbCodes: Record<string, ObserverErrorCode> = {
      ECONNREFUSED: 'database_unreachable',
      ETIMEDOUT: 'database_unreachable',
      ENOTFOUND: 'database_unreachable',
      EHOSTUNREACH: 'database_unreachable',
      ENETUNREACH: 'database_unreachable',
      ECONNRESET: 'database_unreachable',
      '28P01': 'database_auth_failed',
      '28000': 'database_auth_failed',
      '3D000': 'database_unavailable',
      '42501': 'database_permission_denied',
      '42P01': 'migration_required',
      '42703': 'migration_required',
      '57P03': 'database_unavailable',
      '53300': 'database_unavailable',
    }
    const domainMessages: Record<string, ObserverErrorCode> = {
      already_syncing: 'already_syncing',
      'Observer organization unavailable': 'organization_unavailable',
      'Observer project unavailable': 'project_unavailable',
      'Observer connection unavailable; configure before scanning': 'connection_unavailable',
      'Observer connection mapping conflicts with existing connection': 'connection_unavailable',
      'Telemetry sources must not be symbolic links': 'source_symlink',
    }
    if (typeof systemCode === 'string' && Object.hasOwn(dbCodes, systemCode)) code = dbCodes[systemCode]
    else if (stage === 'config_read') code = systemCode === 'ENOENT' ? 'config_not_found' : 'config_unreadable'
    else if (stage === 'config_json') code = 'config_invalid_json'
    else if (stage === 'config_validate') code = 'config_invalid'
    else if (stage === 'arguments') code = 'invalid_arguments'
    else if (typeof e?.message === 'string' && Object.hasOwn(domainMessages, e.message))
      code = domainMessages[e.message]
    else if (systemCode === 'ENOENT' || systemCode === 'ENOTDIR') code = 'source_not_found'
    else if (systemCode === 'EACCES' || systemCode === 'EPERM') code = 'source_permission_denied'
    else if (stage === 'database') code = 'database_unreachable'
  }
  return `Observer [${code}]: ${messages[code]}`
}
