'use client'

import { PageHeader } from '@/components/PageHeader'
import { KeyManager } from '@/components/KeyManager'

export default function KeysPage() {
  return (
    <>
      <PageHeader title="API 密钥" description="安全管理访问凭证，按调用方追溯用量。" />
      <KeyManager />
    </>
  )
}
