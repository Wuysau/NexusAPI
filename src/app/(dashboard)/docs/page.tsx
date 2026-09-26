'use client'

import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Code2, Copy, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { EmptyState } from '@/components/States'
import { gatewayEndpoint } from '@/lib/gateway-endpoint'

export default function DocsPage() {
  const { notify } = useToast()
  const endpoint = gatewayEndpoint(process.env.NEXT_PUBLIC_GATEWAY_BASE_URL)

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      notify('已复制到剪贴板')
    } catch {
      notify('无法自动复制，请手动选择文本', 'error')
    }
  }

  const curl = `curl '${endpoint}/chat/completions' \\\n  -H "Authorization: Bearer YOUR_NEXUS_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "YOUR_CONFIGURED_MODEL_ID",\n    "messages": [{"role": "user", "content": "Hello!"}],\n    "max_tokens": 64\n  }'`

  return (
    <>
      <PageHeader title="开发文档" description="配置凭据、路由与价格后，通过独立网关调用模型。">
        <a
          className="button primary"
          href="https://wuysau.github.io/NexusAPI/"
          target="_blank"
          rel="noopener noreferrer"
        >
          完整使用手册 <ArrowUpRight size={14} />
        </a>
      </PageHeader>
      <div className="docs-grid">
        <section className="panel docs-content">
          <span className="doc-eyebrow">QUICK START</span>
          <h2>通过网关接入模型</h2>
          <p>
            Nexus API 提供兼容 OpenAI 格式的文本对话接口。以下为接入模板，不表示当前部署已有可用模型或成功调用记录。
          </p>

          <div className="doc-step">
            <span>1</span>
            <div>
              <h3>添加渠道</h3>
              <p>
                先通过独立凭据流程录入并授权上游密钥，再在渠道管理中登记凭据引用。由部署方发布有效的模型路由与价格快照。
              </p>
              <Link className="text-link" href="/channels">
                前往渠道管理 <ArrowRight size={14} />
              </Link>
            </div>
          </div>
          <div className="doc-step">
            <span>2</span>
            <div>
              <h3>创建网关 API 密钥</h3>
              <p>为每个应用创建独立的下游密钥，可设置权限范围与过期时间。</p>
              <Link className="text-link" href="/keys">
                创建密钥 <ArrowRight size={14} />
              </Link>
            </div>
          </div>
          <div className="doc-step">
            <span>3</span>
            <div>
              <h3>发送第一个请求</h3>
              <p>
                先确认网关、渠道与价格已就绪，再用您的下游密钥查询网关 /v1/models，并将模板中的 YOUR_CONFIGURED_MODEL_ID
                替换为已配置的模型 ID。目录记录本身不保证调用成功。
              </p>
            </div>
          </div>

          {endpoint ? (
            <>
              <div className="code-header">
                <span>cURL</span>
                <button onClick={() => copy(curl)}>
                  <Copy size={14} /> 复制代码
                </button>
              </div>
              <pre>
                <span className="code-green">curl</span>
                {curl.slice(4)}
              </pre>
            </>
          ) : (
            <EmptyState
              title="网关地址尚未配置"
              description="请联系部署管理员配置独立网关的 Base URL，配置完成后此处将显示接入示例。"
            />
          )}

          <h3 className="doc-subtitle">接口与支持范围</h3>
          <div className="doc-endpoint">
            <span>POST</span>
            <code>/v1/chat/completions</code>
            <p>文本对话 · system / user / assistant</p>
          </div>
          <div className="doc-endpoint">
            <span>GET</span>
            <code>/v1/models</code>
            <p>列出当前租户网关快照中的模型；实际可用性需调用验证</p>
          </div>
          <p className="doc-note">
            独立 Go 数据面（services/gateway）承载热路径与流式 SSE；控制面仅负责配置、定价与账务。
          </p>

          <h3 className="doc-subtitle">故障排查</h3>
          <div className="troubleshooting">
            <p>
              <strong>401</strong> 检查网关密钥是否正确，或已被停用 / 撤销。
            </p>
            <p>
              <strong>403</strong> 控制台角色缺少对应能力，或需要重新验证身份。
            </p>
            <p>
              <strong>429</strong> 密钥额度不足，或上游限流。
            </p>
            <p>
              <strong>503</strong> 没有已配置且启用的对应模型渠道。
            </p>
          </div>
        </section>

        <aside className="docs-aside">
          <section className="panel">
            <h3>
              <Code2 size={18} /> 接入信息
            </h3>
            <small>Base URL</small>
            {endpoint ? (
              <div className="copy-url">
                <code>{endpoint}</code>
                <button onClick={() => copy(endpoint)} aria-label="复制接入地址">
                  <Copy size={14} />
                </button>
              </div>
            ) : (
              <p>网关地址尚未配置</p>
            )}
            <small>认证方式</small>
            <code>Authorization: Bearer sk-nx-...</code>
            <small>计费货币</small>
            <strong>以已生效的价格快照与账本币种为准</strong>
          </section>
          <div className="info-banner">
            <ShieldCheck size={20} />
            <div>
              <strong>安全提示</strong>
              <p>请仅在服务端使用 API 密钥，不要将密钥提交到公开仓库。</p>
            </div>
          </div>
        </aside>
      </div>
      <p className="section-note">
        从首次启动到任务监督，请阅读{' '}
        <a href="https://wuysau.github.io/NexusAPI/" target="_blank" rel="noopener noreferrer">
          在线使用手册 <ArrowUpRight size={12} />
        </a>
        。接口契约见仓库中的 docs/contracts。
      </p>
    </>
  )
}
