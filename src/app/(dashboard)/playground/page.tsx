import Link from 'next/link'
import { ArrowRight, Terminal } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/States'

export default function PlaygroundPage() {
  return (
    <>
      <PageHeader title="在线调试" description="连接网关，测试模型。" />
      <section className="panel">
        <EmptyState
          icon={<Terminal size={32} />}
          title="请通过客户端测试模型"
          description="浏览器内调试暂不可用。请在开发文档中查看网关地址，使用 cURL 或 OpenAI 兼容客户端发送请求。"
          action={
            <Link className="button primary" href="/docs">
              查看接入文档 <ArrowRight size={15} />
            </Link>
          }
        />
      </section>
    </>
  )
}
