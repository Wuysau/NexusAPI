'use client'

import { Network } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { ChannelTable } from '@/components/ChannelTable'

export default function ChannelsPage() {
  return (
    <>
      <PageHeader title="渠道管理" description="配置上游接口、管理 API Key 并查看连接测试结果。" />
      <div className="info-banner">
        <Network size={19} />
        <div>
          <strong>渠道配置与路由</strong>
          <p>本机控制台可直接填写 API Key，保存后可测试上游连接。测试结果与网关调用、计费记录分别展示。</p>
        </div>
      </div>
      <ChannelTable />
    </>
  )
}
