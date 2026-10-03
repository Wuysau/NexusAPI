import { PageHeader } from '@/components/PageHeader'
import { Playground } from '@/components/Playground'

export default function PlaygroundPage() {
  return (
    <>
      <PageHeader title="在线调试" description="使用项目 API Key，通过网关测试模型与文本对话。" />
      <Playground />
    </>
  )
}
