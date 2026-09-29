'use client'

import { Network } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { ChannelTable } from '@/components/ChannelTable'
import Link from 'next/link'

export default function ChannelsPage() {
  return (
    <>
      <PageHeader title="渠道管理" description="配置上游接口、管理 API Key 并查看连接测试结果。" />
      <div className="info-banner">
        <Network size={19} />
        <div>
          <strong>渠道配置与路由</strong>
          <p>本机控制台可直接填写 API Key，保存后可测试上游连接。测试结果与网关调用、计费记录分别展示。</p>
          <p>
            接入模板支持官方 API 和已部署的兼容代理；购买平台套餐与查看支付订单请前往{' '}
            <Link href="/billing">用量与计费</Link>。
          </p>
        </div>
      </div>
      <ChannelTable />
    </>
  )
}
