'use client'

import { useEffect, useRef, useState } from 'react'
import { useApiData } from './lib/useApiData'
import { apiSend, errorMessage } from './lib/api'
import { useSession } from './SessionProvider'
import { Badge, money } from './ui'
import { EmptyState, ErrorState, SkeletonRows } from './States'
import { canReleasePurchaseKey } from '@/lib/payments/purchase-state'

interface Catalog {
  payment: { configured: boolean; mode: 'test' | 'live' | null }
  canPurchase: boolean
  plans: {
    id: string
    code: string
    version: number
    amount: string
    currency: string
    interval: string
    purchasable: boolean
    unavailableReason: string | null
    entitlements: { key: string; value: string | boolean | null; description: string | null }[]
  }[]
}
export function PurchasePanel({ onRefresh }: { onRefresh: () => void }) {
  const catalog = useApiData<Catalog>('/api/billing/catalog')
  const { session } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const working = useRef(false)
  const retryKeys = useRef(new Map<string, string>())
  useEffect(() => {
    const result = new URL(window.location.href).searchParams.get('checkout')
    if (result) {
      const timer = window.setTimeout(() => {
        setNotice(
          result === 'cancelled'
            ? '已返回账单页；取消跳转不会改变订单付款状态。'
            : '已从支付页面返回，付款结果以订单状态为准。请刷新查看。',
        )
        onRefresh()
      }, 1000)
      return () => window.clearTimeout(timer)
    }
  }, [onRefresh])
  async function purchase(planId: string) {
    if (working.current) return
    working.current = true
    setBusy(planId)
    setError(null)
    const storageKey = `nexus:checkout:${session?.organization.id}:${planId}`
    try {
      let key = retryKeys.current.get(storageKey)
      if (!key) {
        const existing = sessionStorage.getItem(storageKey)
        key = existing ?? crypto.randomUUID()
        retryKeys.current.set(storageKey, key)
        sessionStorage.setItem(storageKey, key)
      }
      const result = await apiSend<{ order: { id: string; status: string }; checkout: { url: string | null } }>(
        '/api/billing/purchase',
        'POST',
        { planVersionId: planId, idempotencyKey: key },
      )
      onRefresh()
      if (result.checkout.url) {
        const url = new URL(result.checkout.url)
        if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('支付链接校验失败。')
        window.location.assign(url.href)
      } else {
        const terminal = canReleasePurchaseKey(result.order.status)
        setNotice(
          terminal
            ? `订单 ${result.order.id.slice(0, 12)}：${result.order.status}。请刷新核对；下次点击会发起新的购买。`
            : `订单 ${result.order.id.slice(0, 12)} 尚未确认付款，支付链接已不可用。已保留本次购买记录，请联系财务核对；核对前请勿重新购买。`,
        )
        if (terminal) {
          sessionStorage.removeItem(storageKey)
          retryKeys.current.delete(storageKey)
        }
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      working.current = false
      setBusy(null)
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h3>购买平台套餐</h3>
        {catalog.data?.payment.configured && (
          <Badge tone={catalog.data.payment.mode === 'live' ? 'good' : 'warn'}>
            {catalog.data.payment.mode === 'live' ? 'Stripe 正式支付' : 'Stripe 测试模式 · 不产生真实付款'}
          </Badge>
        )}
        <button
          type="button"
          className="button"
          onClick={() => {
            catalog.reload()
            onRefresh()
          }}
        >
          刷新订单
        </button>
      </div>
      <div style={{ padding: '0 20px 20px' }}>
        <p className="muted">
          平台套餐与上游服务订阅分开计费。每次购买一个月或一年，到期需手动续购；新套餐付款后立即生效，无自动续费或按比例退款，也不会增加钱包余额。
        </p>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        {catalog.loading ? (
          <SkeletonRows rows={2} />
        ) : catalog.error ? (
          <ErrorState message={catalog.error} onRetry={catalog.reload} />
        ) : (
          <>
            {!catalog.data?.payment.configured && (
              <p role="status">在线支付尚未配置。请联系管理员完成商户与付款通知设置。</p>
            )}
            {!catalog.data?.canPurchase && <p className="muted">购买需要管理员或财务权限。</p>}
            {!catalog.data?.plans.length ? (
              <EmptyState
                title="暂无已发布套餐"
                description="请联系管理员按支付操作指南发布套餐、价格和权益，再刷新此页。"
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>套餐</th>
                      <th>价格 / 有效期</th>
                      <th>权益</th>
                      <th>购买</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.data.plans.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          {plan.code} <span className="muted">v{plan.version}</span>
                        </td>
                        <td>
                          {money(plan.amount, 2, plan.currency)} / {plan.interval === 'year' ? '年' : '月'}
                        </td>
                        <td>
                          <details>
                            <summary>查看权益</summary>
                            {plan.entitlements.length ? (
                              plan.entitlements.map((entry) => (
                                <p key={entry.key}>
                                  {entry.description ?? entry.key}：
                                  {typeof entry.value === 'boolean'
                                    ? entry.value
                                      ? '支持'
                                      : '不支持'
                                    : (entry.value ?? '未配置')}
                                </p>
                              ))
                            ) : (
                              <p>暂无公布权益</p>
                            )}
                          </details>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button primary"
                            disabled={!catalog.data?.canPurchase || !plan.purchasable || busy !== null}
                            onClick={() => void purchase(plan.id)}
                          >
                            {busy === plan.id ? '正在准备支付…' : '前往 Stripe 支付'}
                          </button>
                          {plan.unavailableReason && <p className="muted">{plan.unavailableReason}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
