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
