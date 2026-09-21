// Basic secret scanner for the secrets:scan gate.
// Scans tracked source files for high-entropy credential patterns and fails
// if a real-looking secret is committed. Does NOT catch everything; CI should
// add gitleaks/secretlint via a dedicated task. Exits 1 on findings.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const IGNORED = new Set([
  'node_modules',
  '.next',
  '.git',
  'out',
  'build',
  'dist',
  '.test-artifacts',
  '.superpowers',
  'nexus-architecture-harness',
  '.claude',
  '.codex',
  '.playwright-mcp',
  'evidence',
  'output',
  'config',
])
const EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
  '.md',
  '.go',
  '.ps1',
  '.sh',
])

// Real-looking secrets (full keys, not prefixes/placeholders).
const PATTERNS = [
  { name: 'nexus-key', re: /sk-nx-[0-9a-fA-F]{24,}/ },
  { name: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{50,}/ },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/ },
  // secret assignments with a long opaque value, excluding placeholders
  {
    name: 'secret-assign',
    re: /\b(?:SECRET|PRIVATE_KEY|TOKEN|PASSWORD|API_KEY)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{24,}["']/i,
  },
]

const findings = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') && !['.github', '.env.example'].includes(name)) continue
    if (name === 'nexus-observer.json') continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) {
      if (!IGNORED.has(name)) walk(path)
    } else {
      const ext = extname(name)
      if (!EXT.has(ext) && name !== '.env.example') continue
      scanFile(path)
    }
  }
}

function scanFile(path) {
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const { name, re } of PATTERNS) {
    for (const m of content.matchAll(new RegExp(re.source, re.flags + 'g'))) {
      const explicitTestFixture =
        /(?:\.test\.ts|_test\.go)$/.test(path) && /synthetic|fixture|(?:^|[-_])test(?:[-_]|$)/i.test(m[0])
      if (
        !explicitTestFixture &&
        !/placeholder|example|change-me|local-dev|DO-NOT-USE|YOUR_|xxxx|not-a-real|fake|dummy|sample|test-not/i.test(
          m[0],
        )
      ) {
        findings.push({ file: relative(ROOT, path), name })
      }
    }
  }
}

walk(ROOT)
if (findings.length) {
  console.error(`secrets:scan: ${findings.length} potential secret(s) found:`)
  for (const f of findings) console.error(`  [${f.name}] ${f.file}`)
  process.exit(1)
}
console.log('secrets:scan: no secrets found')
