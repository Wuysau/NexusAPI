import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseAgentHook, supportsAgentHook } from '../src/lib/observer/adapters/agent-hooks'
import {
  parseTelemetry,
  mergeTelemetryRecord,
  TelemetryError,
  validTool,
  type NativeRecord,
} from '../src/lib/observer/adapters/telemetry'

const MAX_INPUT = 1_048_576
const MAX_SPOOL = 64 * 1024 * 1024
const fail = (code: string): never => {
  throw new TelemetryError(code)
}
type Format = 'canonical' | 'otlp' | 'cursor-hook' | 'agent-hook'
export function parseArguments(args: string[]) {
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (
      !['--tool', '--format', '--output'].includes(key) ||
      options.has(key) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      fail('invalid_arguments')
    options.set(key, args[++index])
  }
  const tool = options.get('--tool')
  const format = options.get('--format')
  if (
    !validTool(tool) ||
    !['canonical', 'otlp', 'cursor-hook', 'agent-hook'].includes(format ?? '') ||
    (format === 'cursor-hook' && tool !== 'cursor') ||
    (format === 'agent-hook' && !supportsAgentHook(tool))
  )
    return fail('invalid_arguments')
  return { tool, format: format as Format, output: options.get('--output') }
}
export async function readTelemetryInput(input: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_INPUT) fail('telemetry_input_too_large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as unknown
  } catch {
    return fail('invalid_telemetry_json')
  }
}
function checkFormat(value: unknown, format: Format) {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('unsupported_telemetry_format')
    const row = item as Record<string, unknown>
    const matches =
      format === 'canonical'
        ? row.schemaVersion === 1
        : format === 'otlp'
          ? row.resourceLogs !== undefined || row.resourceSpans !== undefined
          : format === 'agent-hook'
            ? row.schemaVersion === undefined
            : row.hook_event_name !== undefined && row.schemaVersion === undefined
    if (!matches) fail('unsupported_telemetry_format')
  }
}
async function directory(location: string) {
  await mkdir(location, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const info = await lstat(location)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_telemetry_output')
}
const safeFileName = /^[a-z][a-z0-9_-]{0,63}\.jsonl$/
/** Only direct .jsonl children of the private usage spool may be appended; no arbitrary filesystem writes. */
export async function appendTelemetry(
  tool: string,
  records: NativeRecord[],
  output?: string,
  homeDirectory = homedir(),
) {
  if (!validTool(tool)) return fail('invalid_telemetry_tool')
  const home = await realpath(homeDirectory)
  const root = path.join(home, '.nexusapi')
  const usage = path.join(root, 'usage')
  const target = output === undefined ? path.join(usage, `${tool}.jsonl`) : path.resolve(output)
  if (path.dirname(target) !== usage || !safeFileName.test(path.basename(target))) fail('unsafe_telemetry_output')
  // Validation before directory creation also prevents invalid output from causing side effects.
  const clean = parseTelemetry(
    tool,
    records.map((row) => ({ ...row, schemaVersion: 1, tool })),
    { file: target },
  )
  await directory(root)
  await directory(usage)
  const lockPath = `${target}.lock`
  let lock: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      lock = await open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 39) fail('telemetry_spool_busy')
      await delay(25)
    }
  }
  try {
    const prior = await lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1)) fail('unsafe_telemetry_output')
    const file = await open(
      target,
      constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino)))
        fail('unsafe_telemetry_output')
      if (stat.size > MAX_SPOOL) fail('telemetry_spool_full')
      const existing = await file.readFile({ encoding: 'utf8' })
      if (existing && !existing.endsWith('\n')) fail('invalid_telemetry_spool')
      const known = new Map<string, NativeRecord>()
      for (const line of existing.split('\n')) {
        if (!line) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          return fail('invalid_telemetry_spool')
        }
        for (const row of parseTelemetry(tool, value, { file: target })) {
          const key = JSON.stringify([row.sessionId, row.eventId])
          const previous = known.get(key)
          known.set(key, previous ? mergeTelemetryRecord(previous, row) : row)
        }
      }
      const pending = clean.flatMap((row) => {
        const key = JSON.stringify([row.sessionId, row.eventId])
        const previous = known.get(key)
        const merged = previous ? mergeTelemetryRecord(previous, row) : row
        if (previous && JSON.stringify(previous.tokens) === JSON.stringify(merged.tokens)) return []
        known.set(key, merged)
        return [merged]
      })
      const text = pending.map((row) => JSON.stringify({ schemaVersion: 1, tool, ...row }) + '\n').join('')
      if (stat.size + Buffer.byteLength(text) > MAX_SPOOL) fail('telemetry_spool_full')
      if (text) {
        await file.writeFile(text, 'utf8')
        await file.sync()
      }
      return { appended: pending.length, duplicates: clean.length - pending.length }
    } finally {
      await file.close()
    }
  } finally {
    if (lock) {
      await lock.close()
      await unlink(lockPath)
    }
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help')) {
    console.log(
      'Usage: node --import tsx scripts/agent-usage.ts --tool <id> --format canonical|otlp|cursor-hook|agent-hook [--output <absolute ~/.nexusapi/usage/name.jsonl>]\nReads one JSON payload (max 1 MiB) from stdin; appends metadata only to ~/.nexusapi/usage/<tool>.jsonl. No network listener, database or credentials.',
    )
    return
  }
  try {
    const options = parseArguments(process.argv.slice(2))
    const value = await readTelemetryInput(process.stdin)
    checkFormat(value, options.format)
    const records =
      options.format === 'agent-hook'
        ? parseAgentHook(options.tool, value, { file: 'stdin', workspace: process.cwd() })
        : parseTelemetry(options.tool, value, { file: 'stdin' })
    const result = await appendTelemetry(options.tool, records, options.output)
    // Hook protocols expect JSON. Diagnostics/counters go to stderr, never raw inputs.
    if (options.format === 'cursor-hook' || options.format === 'agent-hook') {
      console.log('{}')
      console.error(JSON.stringify(result))
    } else console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error instanceof TelemetryError ? error.code : 'telemetry_capture_failed')
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main()
