import Link from 'next/link'
import type { SubscriptionProduct } from '@/lib/subscriptions/catalog'
import styles from './workspace.module.css'

export function SubscriptionProductGuide({ product }: { product: SubscriptionProduct }) {
  return (
    <section className={styles.form} aria-label={`${product.label} 接入能力`}>
      <p className={styles.description}>{product.description}</p>
      <dl className={styles.details}>
        <dt>项目登记</dt>
        <dd>支持，登记本身不创建可调用渠道</dd>
        <dt>原生账户与额度</dt>
        <dd>
          {product.capabilities.nativeAccountObservation
            ? '支持 Codex 本机同步；未返回的额度保持未知'
            : '当前未接入，额度请查看官方控制台'}
        </dd>
        <dt>本地会话采集</dt>
        <dd>
          {product.id === 'claude_code'
            ? '支持 Claude Code JSONL；管理员需在 Observer 配置 claudeSources，按工作目录归属项目，不自动认定渠道或订阅'
            : product.capabilities.nativeUsageObservation
              ? '支持 Codex Observer'
              : '当前未接入'}
        </dd>
        <dt>外部额度采集</dt>
        <dd>
          {product.capabilities.collectorObservation
            ? '支持导入 CodexBar 的账户与额度快照；需明确绑定身份，保留来源和观测时间'
            : '当前未接入'}
        </dd>
        <dt>网关调用</dt>
        <dd>{product.channelPreset ? '单独配置获授权的 API 渠道后可用' : '本产品登记不提供网关调用能力'}</dd>
      </dl>
      <ol className={styles.description}>
        {product.setupSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {product.nativeApi && (
        <div className={styles.notice}>
          <p>{product.nativeApi.note}</p>
          <p className={styles.hint}>
            官方工具配置 ·{' '}
            {product.nativeApi.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}
          </p>
          <code>{product.nativeApi.baseUrl}</code>
        </div>
      )}
      {product.channelPreset && <p className={styles.hint}>{product.channelPreset.note}</p>}
      <div className={styles.toolbar}>
        <a className={styles.link} href={product.nativeGuideUrl} target="_blank" rel="noreferrer">
          官方接入文档 ↗
        </a>
        {product.apiGuideUrl && (
          <a className={styles.link} href={product.apiGuideUrl} target="_blank" rel="noreferrer">
            官方 API 文档 ↗
          </a>
        )}
        {product.channelPreset && (
          <Link className={styles.link} href={`/channels?subscriptionProduct=${encodeURIComponent(product.id)}`}>
            配置授权 API 渠道
          </Link>
        )}
      </div>
    </section>
  )
}
