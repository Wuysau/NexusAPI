import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep development startup from generating assistant-specific instruction files.
  agentRules: false,
  // Filesystem tracing can include local operator state. Keep those paths out of
  // standalone output while retaining source, schemas, docs and runtime assets.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  outputFileTracingExcludes: {
    '/*': [
      './.git/**/*',
      './.claude/**/*',
      './.codex/**/*',
      './.superpowers/**/*',
      './.test-artifacts/**/*',
      './.playwright-mcp/**/*',
      './nexus-architecture-harness/**/*',
      './evidence/**/*',
      './output/**/*',
      './docs/superpowers/**/*',
      './docs/current-task.md',
      './docs/project-state.md',
      './AGENTS.md',
      './CLAUDE.md',
      './nexus-observer.json',
      './config/nexus-observer.json',
      './config/nexus-observer.json.*.tmp',
      './**/.env*',
    ],
  },
}

export default nextConfig
