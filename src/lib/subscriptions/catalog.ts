import { supportsSubscriptionMonitor } from './collector-providers'

/** Public onboarding metadata only. Never store credentials, live quotas or prices here. */
export interface SubscriptionEndpoint {
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  note: string
}
export interface SubscriptionProduct {
  id: string
  label: string
  provider: string
  description: string
  nativeGuideUrl: string
  apiGuideUrl?: string
  capabilities: {
    registration: true
    nativeAccountObservation: boolean
    nativeUsageObservation: boolean
    collectorObservation: boolean
    gatewayAccess: 'none' | 'separate_api_key' | 'restricted_coding_key'
  }
  channelPreset?: SubscriptionEndpoint & { auth: 'separate_api_key' | 'coding_plan_api_key' }
  nativeApi?: SubscriptionEndpoint
  setupSteps: string[]
}

const nativeSteps = [
  '在官方客户端或官网完成登录与订阅。',
  '在 NexusAPI 登记产品并绑定项目；当前不自动读取该产品的账户或额度。',
  '用量与额度请查看官方控制台；登录令牌、Cookie 与密码无需提交。',
]
const separateApiNote =
  '使用开放平台单独签发的 API Key；开通、模型权限与计费以官方控制台为准，订阅登录凭据不能替代 API Key。'
function product(
  id: string,
  label: string,
  provider: string,
  description: string,
  nativeGuideUrl: string,
  options: Partial<Pick<SubscriptionProduct, 'apiGuideUrl' | 'channelPreset' | 'nativeApi' | 'setupSteps'>> = {},
): SubscriptionProduct {
  return {
    id,
    label,
    provider,
    description,
    nativeGuideUrl,
    capabilities: {
      registration: true,
      nativeAccountObservation: id === 'openai_codex',
      nativeUsageObservation: id === 'openai_codex' || id === 'claude_code',
      collectorObservation: supportsSubscriptionMonitor(id),
      gatewayAccess: options.nativeApi ? 'restricted_coding_key' : options.channelPreset ? 'separate_api_key' : 'none',
    },
    setupSteps: nativeSteps,
    ...options,
  }
}
const api = (baseUrl: string, protocol: 'openai' | 'anthropic' = 'openai'): SubscriptionProduct['channelPreset'] => ({
  protocol,
  baseUrl,
  auth: 'separate_api_key',
  note: separateApiNote,
})

/** IDs are persisted in owned_connections.capabilities; keep them stable across product renames. */
export const SUBSCRIPTION_PRODUCTS: readonly SubscriptionProduct[] = [
  product(
    'openai_codex',
    'OpenAI Codex',
    'openai',
    '支持本机 Codex 账户、官方返回的额度与本地会话观测；字段可用性取决于客户端版本。',
    'https://developers.openai.com/codex/auth/',
    {
      apiGuideUrl: 'https://platform.openai.com/docs/quickstart',
      channelPreset: api('https://api.openai.com/v1'),
      setupSteps: [
        '在本机 Codex 中登录 ChatGPT 账户。',
        '登记后打开连接详情，同步账户与额度；配置 Observer 可导入本地会话。',
        '本地 token 总量不等于订阅剩余额度；API 调用需要单独的开放平台密钥。',
      ],
    },
  ),
  product(
    'claude_code',
    'Claude Code',
    'anthropic',
    'Claude 订阅在官方 Claude Code 中登录；Anthropic API 使用独立的 Console 密钥。',
    'https://code.claude.com/docs/en/authentication',
    {
      apiGuideUrl: 'https://platform.claude.com/docs/en/api/overview',
      channelPreset: api('https://api.anthropic.com', 'anthropic'),
    },
  ),
  product(
    'google_gemini',
    'Gemini / Google AI',
    'google',
    'Google 账号订阅与 Gemini Developer API 的认证、配额和计费分别管理。',
    'https://geminicli.com/docs/get-started/authentication/',
    {
      apiGuideUrl: 'https://ai.google.dev/gemini-api/docs/openai',
      channelPreset: api('https://generativelanguage.googleapis.com/v1beta/openai'),
    },
  ),
  product(
    'github_copilot',
    'GitHub Copilot',
    'github',
    '在官方 IDE、CLI 或 GitHub 中使用订阅。本版本未接入 Copilot 管理与用量 API。',
    'https://docs.github.com/en/copilot/get-started/about-github-copilot',
  ),
  product(
    'cursor',
    'Cursor',
    'cursor',
    '订阅在 Cursor 客户端使用；客户端的自带 API Key 功能不代表订阅可导出为通用 API。',
    'https://cursor.com/help/models-and-usage/api-keys',
  ),
  product(
    'windsurf',
    'Windsurf / Devin Desktop',
    'windsurf',
    '通过官方客户端与账户面板使用套餐；原 Windsurf 文档目前指向 Devin Desktop。',
    'https://docs.devin.ai/desktop/accounts/usage',
  ),
  product(
    'kiro',
    'Kiro',
    'kiro',
    '在 Kiro 官方客户端中登录并查看套餐；本版本仅登记与项目绑定。',
    'https://kiro.dev/docs/',
  ),
  product(
    'jetbrains_ai',
    'JetBrains AI',
    'jetbrains',
    '通过 JetBrains 账户和 IDE 使用 AI 套餐；本版本未接入其账户或额度观测。',
    'https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html',
  ),
  product(
    'trae',
    'TRAE',
    'trae',
    '通过官方 IDE 和账户面板管理订阅；本版本不导入客户端登录凭据。',
    'https://docs.trae.ai/',
  ),
  product(
    'qwen_code',
    'Qwen Code',
    'qwen',
    '按当前官方认证指南选择 Model Studio、第三方或自定义供应商；不假设历史 OAuth 免费额度仍可用。',
    'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/',
    {
      apiGuideUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
      channelPreset: api('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    },
  ),
  product(
    'kimi_coding',
    'Kimi Code / Kimi',
    'moonshot',
    'Kimi Code 会员与 Moonshot 开放平台使用不同密钥、端点和计费。',
    'https://www.kimi.com/code/docs/en/kimi-code/faq.html',
    {
      apiGuideUrl: 'https://platform.moonshot.ai/docs/guide/start-using-kimi-api',
      channelPreset: api('https://api.moonshot.ai/v1'),
      nativeApi: {
        protocol: 'anthropic',
        baseUrl: 'https://api.kimi.com/coding',
        note: 'Kimi Code 专用端点；仅在官方支持且获授权的工具中配置会员密钥。国际端点为 api.kimi.ai；与 Moonshot 开放平台密钥不可混用。',
      },
    },
  ),
  product(
    'zai_glm',
    'GLM / Z.ai Coding Plan',
    'zai',
    'Coding Plan 仅适用于官方支持的工具与场景；通用应用使用独立开放平台 API。',
    'https://docs.z.ai/devpack/tool/others',
    {
      apiGuideUrl: 'https://docs.z.ai/guides/overview/quick-start',
      channelPreset: api('https://api.z.ai/api/paas/v4'),
      nativeApi: {
        protocol: 'openai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        note: '专用 Coding Plan 端点，仅用于官方支持的工具和环境；不得把套餐当作通用 API 后端或转售。中国区智谱账号需使用其对应端点和密钥。',
      },
    },
  ),
  product(
    'minimax_coding',
    'MiniMax Coding / Token Plan',
    'minimax',
    '原 Coding Plan 已扩展为 Token Plan；订阅密钥的实际资源取决于席位与余额。',
    'https://platform.minimax.io/docs/token-plan/intro',
    {
      apiGuideUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
      channelPreset: api('https://api.minimax.io/v1'),
      setupSteps: [
        ...nativeSteps.slice(0, 2),
        '使用开放平台 API Key 可配置渠道；Subscription Key 必须有对应席位或 Credits，并按官方 Token Plan 文档使用。中国区账号请核对区域端点。',
      ],
    },
  ),
  product(
    'alibaba_bailian',
    '阿里云百炼 / Coding Plan',
    'alibaba',
    'Coding Plan 专用密钥与百炼按量 API 分离；套餐仅限获准的编程工具。',
    'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    {
      apiGuideUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
      channelPreset: api('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
      nativeApi: {
        protocol: 'openai',
        baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
        note: '国际区 Coding Plan 专用端点；仅在官方允许的编程工具中使用，不能用于自建应用后端。中国区、国际区密钥和端点需匹配。',
      },
    },
  ),
  product(
    'volcengine_ark',
    '火山方舟 / Coding · Agent Plan',
    'volcengine',
    'Coding Plan 与 Agent Plan 各有专用端点和密钥；请从对应控制台获取。',
    'https://docs.volcengine.com/docs/ark/agent-plan-personal-faq?lang=zh',
    {
      apiGuideUrl: 'https://www.volcengine.com/docs/82379/1330310',
      setupSteps: [
        ...nativeSteps.slice(0, 2),
        '从对应套餐控制台获取官方工具配置；普通 API 或获授权的兼容服务可在渠道管理中手动配置，套餐端点不与按量服务混用。',
      ],
    },
  ),
  product(
    'tencent_hunyuan',
    '腾讯混元 / TokenHub',
    'tencent',
    '混元兼容 API 需控制台签发密钥；新服务与模型逐步迁移到 TokenHub。',
    'https://cloud.tencent.cn/document/product/1729/111007',
    {
      apiGuideUrl: 'https://cloud.tencent.cn/document/product/1729/111007',
      channelPreset: {
        ...api('https://api.hunyuan.cloud.tencent.com/v1')!,
        note: '此为混元既有服务端点。新购服务请按 TokenHub 控制台配置；元宝等消费订阅不等于混元 API 授权。',
      },
    },
  ),
  product(
    'deepseek',
    'DeepSeek',
    'deepseek',
    '登记 DeepSeek 资源；API 访问使用开放平台密钥，不推定存在可转用的消费订阅额度。',
    'https://api-docs.deepseek.com/',
    {
      apiGuideUrl: 'https://api-docs.deepseek.com/zh-cn/',
      channelPreset: api('https://api.deepseek.com'),
    },
  ),
  product(
    'xai_grok',
    'Grok / xAI',
    'xai',
    'Grok 消费订阅与 xAI 开发者 API 分开配置；API 需相应团队权限与余额。',
    'https://docs.x.ai/developers/quickstart',
    {
      apiGuideUrl: 'https://docs.x.ai/developers/quickstart',
      channelPreset: api('https://api.x.ai/v1'),
    },
  ),
  product(
    'perplexity',
    'Perplexity',
    'perplexity',
    'Perplexity 订阅与 Sonar API 分开管理；API 密钥和计费以开发者控制台为准。',
    'https://docs.perplexity.ai/docs/getting-started/overview',
    {
      apiGuideUrl: 'https://docs.perplexity.ai/docs/sonar/quickstart',
      channelPreset: api('https://api.perplexity.ai'),
    },
  ),
]

export function getSubscriptionProduct(id: unknown): SubscriptionProduct | undefined {
  return typeof id === 'string' ? SUBSCRIPTION_PRODUCTS.find((entry) => entry.id === id) : undefined
}
interface SubscriptionConnection {
  mode: string
  provider: string
  subscription_product?: string | null
}
export function connectionSubscriptionProduct(connection: SubscriptionConnection) {
  if (connection.mode !== 'subscription_interactive') return undefined
  // Legacy Codex registrations had no product field. Unknown explicit products never fall back.
  return getSubscriptionProduct(
    connection.subscription_product ?? (connection.provider === 'openai' ? 'openai_codex' : undefined),
  )
}
export function isCodexSubscription(connection: SubscriptionConnection) {
  return connection.provider === 'openai' && connectionSubscriptionProduct(connection)?.id === 'openai_codex'
}
