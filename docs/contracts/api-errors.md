# Public API Error Contract v1

```json
{
  "error": {
    "code": "budget_exceeded",
    "message": "Request cannot be authorized under the active budget policy.",
    "type": "policy_error",
    "param": null,
    "request_id": "req_..."
  }
}
```

公开 `code` 稳定且可机器处理；message 不暴露渠道、余额、密钥、栈或内部策略。HTTP 映射：401 无效/撤销 key；403 scope/模型/区域策略；409 幂等冲突；413 大小限制；422 请求可解析但能力不支持；429 客户限流/预算（code 区分）；502 上游协议错误；503 无合格渠道；504 上游超时。所有错误包含 request ID。

客户端错误不会触发其他供应商尝试。生成请求在可能已被供应商接受后默认为不可安全重试；只有请求 idempotency key、供应商能力和策略均允许才可自动重试。

## Retired Control Plane endpoints

Next.js `/v1/*` returns 410 `data_plane_moved`; clients must explicitly configure the Go Gateway base URL. `/api/admin` returns 410 `legacy_admin_retired`; use authenticated typed Control Plane APIs. Both use `invalid_request_error`, `param: null`, `request_id` and `Cache-Control: no-store`. Neither redirects or forwards credentials/bodies. Unregistered HTTP methods may return framework 405 without side effects.

## Retired internal accounting endpoints

POST /api/internal/gateway/reserve and /settle return410 billing_endpoint_retired,
with error.type=invalid_request_error, param=null, request_id and no-store.
They do not parse request bodies, authenticate, redirect or move funds.
Managed authorization uses `packages/contracts/schemas/budget-request.schema.json`; final usage uses
only the durable outbox.

## Console response parsing

The browser's `apiGet`/`apiSend` helpers reject an unreadable or malformed JSON body even when the HTTP status is successful. These failures use a local `ApiError` with code `invalid_response`, the received HTTP status and a fixed message asking the user to refresh and check the operation's result. Parser excerpts and response content are not included. This local error is not a new server error code or HTTP response.

An `AbortError` during a successful response's body read retains its identity. Valid JSON `null` and explicit 204/205 no-content responses remain accepted. Existing non-success HTTP status/error normalization is unchanged. The helper does not retry: a dispatched mutation may already have taken effect, even when its response could not be read.
