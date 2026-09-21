// Structured JSON logger with field allowlist and secret redaction.
//
// The logger writes one JSON object per line to stdout. Every field is passed
// through `sanitizeFields` (allowlist + denylist) before emission, so a caller
// that accidentally passes `authorization` or `prompt` cannot leak it.
//
// Context (request_id, trace_id, tenant_id_hash, attempt_id) is bound once per
// logger instance and merged into every line. A child logger inherits the
// parent's context and can override individual fields.
//
// This is the shared logging primitive for the control plane and the worker.
// The Go gateway has its own slog-based logger (services/gateway/telemetry.go)
// with the same allowlist discipline.

import { sanitizeFields, redactInlineSecrets } from './redaction'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerContext {
  request_id?: string
  trace_id?: string
  tenant_id_hash?: string
  attempt_id?: string
  service?: string
  worker_id?: string
}

export interface LoggerOptions extends LoggerContext {
  level?: LogLevel
  /** Override the output stream (defaults to process.stdout). Test-only. */
  stream?: { write: (chunk: string) => void }
}

export class Logger {
  private readonly ctx: Record<string, unknown>
  private readonly level: number
  private readonly stream: { write: (chunk: string) => void }

  constructor(opts: LoggerOptions = {}) {
    this.ctx = {}
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && k !== 'level' && k !== 'stream') {
        this.ctx[k] = v
      }
    }
    this.level = LEVEL_PRIORITY[opts.level ?? 'info'] ?? LEVEL_PRIORITY.info
    this.stream = opts.stream ?? process.stdout
  }

  /** Create a child logger with additional/overridden context. */
  child(ctx: LoggerContext): Logger {
    const merged = { ...this.ctx, ...ctx }
    return new Logger({
      ...merged,
      level: this.levelName(),
      stream: this.stream,
    } as LoggerOptions)
  }

  debug(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', msg, fields)
  }
  info(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('info', msg, fields)
  }
  warn(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', msg, fields)
  }
  error(msg: string, fields: Record<string, unknown> = {}): void {
    this.write('error', msg, fields)
  }

  private write(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.level) return
    const sanitized = sanitizeFields({ ...this.ctx, level, msg, time: new Date().toISOString(), ...fields })
    // Redact the message itself in case a caller passed a raw error string
    // that contains an inline secret.
    sanitized.msg = redactInlineSecrets(String(sanitized.msg ?? msg))
    try {
      this.stream.write(JSON.stringify(sanitized) + '\n')
    } catch {
      // A serialization failure must never crash the request path.
    }
  }

  private levelName(): LogLevel | undefined {
    for (const [name, prio] of Object.entries(LEVEL_PRIORITY)) {
      if (prio === this.level) return name as LogLevel
    }
    return undefined
  }
}

/**
 * Hash a tenant id for logging. Tenant ids are not secret, but hashing them in
 * logs avoids correlating a log stream to a specific customer without a join.
 */
export function hashTenantId(tenantId: string): string {
  const { createHash } = require('node:crypto') as {
    createHash: (a: string) => { update: (d: string) => { digest: (e: string) => string } }
  }
  return createHash('sha256').update(`nexus:${tenantId}`).digest('hex').slice(0, 16)
}

/** Singleton root logger for the control plane. */
let rootLogger: Logger | null = null

export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = new Logger({
      service: 'control-plane',
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
    })
  }
  return rootLogger
}

/** Test-only reset of the singleton. */
export function __resetLoggerForTests(): void {
  rootLogger = null
}
