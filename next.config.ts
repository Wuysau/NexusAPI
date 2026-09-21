import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep development startup from generating assistant-specific instruction files.
  agentRules: false,
}

export default nextConfig
