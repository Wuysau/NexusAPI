# Provider Adapter Contract v1

每个适配器暴露相同能力，不允许核心网关读取供应商私有响应。

```ts
type CanonicalError =
  | "auth" | "rate_limit" | "quota" | "invalid_request"
  | "content_policy" | "transient" | "provider_down" | "unknown";

interface ProviderAdapterV1 {
  id: string;
  discoverModels(ctx: DiscoveryContext): Promise<DiscoveredModel[]>;
  validateCredential(ref: CredentialRef): Promise<CredentialStatus>;
  capabilities(model: string): ModelCapabilities;
  buildRequest(req: CanonicalRequest, credential: SecretHandle): ProviderRequest;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<CanonicalChunk>;
  parseUsage(result: ProviderResult): CanonicalUsage | null;
  classifyError(error: unknown): { kind: CanonicalError; retryable: boolean; retryAfterMs?: number };
  health(account: ProviderAccountRef): Promise<HealthStatus>;
}
```

要求：adapter 版本可观测；测试 fixture 覆盖正常流、分片边界、usage 缺失、错误 body、429、5xx、超时和取消；不得记录 secret 或内容；重试由核心根据分类和 request state 决定，adapter 不暗中重试生成请求。

Go 执行适配器还必须提供纯函数 `ValidateRequest(*CanonicalRequest) error`：不读取凭据、不访问网络、不修改请求。网关在现有候选完成授权、健康和价格检查后，排除无法保留请求语义的适配器，再选择支付模式和价格、解析凭据并预留预算。`BuildRequest` 也调用同一验证，保护直接调用者。`UnsupportedParameterError` 只标识固定字段名，不能包含输入值；不支持的工具、内容或输出约束不得静默丢弃。具体实现范围见 [Gateway 参数校验](../operations/gateway-limits.md#request-parameter-validation)。
