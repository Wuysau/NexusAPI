import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Nexus API · 大模型统一网关',
  description: '一个接口，连接无限可能。统一管理 AI 上游渠道、API 密钥、用量与计费。',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
