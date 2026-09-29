# NexusAPI

📖 **[在线使用手册](https://wuysau.github.io/NexusAPI/)**：面向新用户介绍项目、网关 API、多工具用量采集和任务监督的使用方法。也可直接查看 [手册源文件](docs/index.html)。

NexusAPI 是以项目为核心的 AI Resource Control Plane。统一查看 API 渠道、官方订阅、本地工具、任务、会话、配额与用量；Go 网关继续提供兼容 OpenAI 的 API 数据面。本地订阅执行与网关 API 调用遵守不同的凭据和计费边界。

**远端网关调用本机 Ollama**：使用[本地连接器两机指南](docs/operations/local-connector.md)，在连接页配置多个模型、一次性配对并启动独立 CLI。本机无需开放入站端口；Coding Agent 使用远端 Gateway 地址与项目 API Key。首版限定单 Gateway，支持普通与流式 Chat Completions。

项目使用 [MIT License](LICENSE)，可修改、分发和商业使用，需保留许可证及版权声明。当前仍在持续开发；Stripe 托管支付需管理员配置商户密钥、发布套餐并设置回调后启用。源码公开及自动化测试不代表已完成真实收款或生产环境验收。

## 功能

- **资源与路由视图**：`/resources` 从现有连接、渠道和官方配额事实生成资源目录，分别显示资源类型、执行方式、账户引用、配额与健康状态；`/routing` 按项目展示本地任务候选预览与 API 渠道。未知值保持未知，渠道配置不冒充已发布网关快照。这些页面不复制订阅凭据，也不创建另一套渠道或额度数据。
- **统一网关**：Go 数据面提供 /v1/models、/v1/chat/completions 和 SSE 流式响应，支持 OpenAI 与 Anthropic 协议适配；可显式开启 /v1/responses 的文本和函数调用子集。
- **渠道与密钥**：配置上游地址、模型和 API Key，使用 Nexus API Key 调用已配置渠道。桌面本地模式支持界面录入上游密钥并加密保存。
- **项目与用量**：按组织、项目、连接查看实际请求、Token、价格来源和对账状态；未知价格保持未知，不自动记为免费。
- **多工具用量采集**：独立 Observer 持续发现 Codex、Claude Code、Gemini CLI、Qwen Code、Cline、Roo Code、兼容 Kilo 扩展、Copilot CLI、Kimi CLI、Pi 和 Qoder IDE 的本地记录；另支持 OpenCode 导出、Factory SDK 单轮导出、OpenClaw 旧版导出与官方 Hook。目录列出 42 种工具身份，包含通用桥接和未适配项，**不表示 42 种原生支持**。Qoder IDE 与活动 Hook 未报告的 Token 保持未知，本地记录不产生 Nexus 扣费。详见[采集手册](docs/operations/agent-observer.md)与[覆盖矩阵](docs/operations/agent-tool-coverage.md)。
- **多服务订阅与账号池**：连接目录覆盖 Claude Code、Gemini、Copilot、Cursor、Kimi、GLM、MiniMax 等常见服务，逐项说明原生使用、独立 API 和监控能力。Codex 保留原生观测；其他受支持产品通过 CodexBar dashboard-v1 快照导入或已配置的服务同步额度。账号池显示多个额度窗口、数据新鲜度、耗尽及异常状态，第三方监控与官方调度依据分别展示。
- **兼容代理与付费入口**：渠道配置提供官方 API 与 CLIProxyAPI / New API / Sub2API 兼容入口模板；用量与计费页面提供已发布套餐、Stripe Checkout 与订单状态。价格在服务端读取，只有验签回调可入账。第三方订阅购买仍在相应服务商完成，不会把平台套餐当作上游订阅出售。
- **任务监督**：通过独立 Codex Profile 执行持久任务，在安全边界按兼容性和额度交接，提供资源池、策略与执行历史。配置与入口见 [任务级资源切换](docs/operations/task-resource-handoff.md)。

新增接入说明：[订阅服务覆盖](docs/provider-coverage.md) · [多服务额度监控](docs/operations/subscription-monitor.md) · [Stripe 商户与套餐配置](docs/operations/stripe-payments.md) · [开源项目借鉴记录](docs/operations/open-source-research.md)。
- **管理控制台**：成员权限、审计、账单、模型目录和价格审批。

## Performance Benchmark (2026-09-28)

- **Hardware**: Intel Core Ultra 7 255H / 16 cores, 16 logical processors / 31.6 GiB RAM / Windows 11 Home (build 26200)
- **Go version**: go1.27.0 windows/amd64
- **GOMAXPROCS**: 4, 8, or 16 as shown below; host process, not a container
- **Test method**: `cd services/gateway && go test -run '^TestPerfOverhead$' -count=5 -v .` with each `GOMAXPROCS` value set separately. Each run sends 320 streaming requests at concurrency 16 to a mock upstream with zero think time and eight SSE chunks. The reported p50/p95/p99 values are the median of the five per-run percentiles, calculated from gateway request time minus the run's mean upstream-handler time.

| Config | Concurrency | p50 | p95 | p99 | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| In-process mock, GOMAXPROCS=4 | 16 | 3.71 ms | 11.20 ms | 20.11 ms | 5 runs × 320 requests |
| In-process mock, GOMAXPROCS=8 | 16 | 4.93 ms | 10.55 ms | 14.68 ms | 5 runs × 320 requests |
| In-process mock, GOMAXPROCS=16 | 16 | 6.30 ms | 18.35 ms | 22.82 ms | 5 runs × 320 requests |

This benchmark uses an in-memory gateway harness, fixture credentials, fake budget reservation, and a mock upstream. It does **not** measure Redis admission, the real Budget service, PostgreSQL, TLS, or a production deployment. The local control plane and Docker services were running in the background, so these laptop results are indicative rather than a production latency claim. The test implementation and its limits are in [`services/gateway/perf_test.go`](services/gateway/perf_test.go).

本仓库可启用提交后自动合并与推送：运行 `npm run hooks:install`，每次 `git commit` 后将提交合并进 `main` 并推送到 `origin/main`。前提与失败恢复见 [Git 自动同步](docs/operations/git-auto-sync.md)。

## 环境

Node.js 24、npm、PostgreSQL 14+、Redis 6+。Go 网关使用 services/gateway/go.mod 指定的 Go 版本；Docker 可启动本地数据库和 Redis。

## 本地启动

```sh
npm ci
cp .env.example .env.local
docker compose up -d postgres redis
```

Windows PowerShell 使用 `Copy-Item .env.example .env.local`。编辑 .env.local，设置数据库连接和开发账号的 DEV_ADMIN_PASSWORD、DEV_VIEWER_PASSWORD；不要提交真实配置或密钥。

首次初始化：

```sh
node --env-file=.env.local scripts/db-migrate.mjs
npm run seed:dev
npm run dev
```

默认打开 <http://localhost:3000>，使用 DEV_ADMIN_EMAIL（默认 dev@nexus.local）及刚设置的密码登录。种子数据用于演示，不是实际供应商报价或账单。日常启动只需启动数据库、Redis 并运行 `npm run dev`；无需重复初始化。

### 调用模型

本地桌面模式先在 .env.local 设置：

```dotenv
NEXUS_DESKTOP_ORIGIN=http://127.0.0.1:3000
CONTROL_PLANE_URL=http://127.0.0.1:3000
NEXT_PUBLIC_GATEWAY_BASE_URL=http://127.0.0.1:8080/v1
```

同时为 SNAPSHOT_SIGNING_KEY 和 GATEWAY_INTERNAL_TOKEN 分别生成随机值，控制台与网关使用同一份配置。签名密钥至少 32 字符。以该回环地址访问控制台，在渠道管理中填入上游地址、协议、模型和 API Key；然后启动网关与用量 Worker：

```sh
npm run gateway:local
```

在控制台创建 Nexus API Key，再调用已配置的模型：

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_NEXUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_CONFIGURED_MODEL","messages":[{"role":"user","content":"Hello"}],"max_tokens":32}'
```

网关验证 Nexus Key，选取允许的渠道，以对应上游密钥发送请求，再记录返回用量。真实请求会消耗上游额度。默认网关端口为 8080；控制台端口 3000 不转发模型请求。若修改端口，请同步更新配置中的地址。

本地密钥保存在用户目录下的加密存储中。生产部署使用独立密钥服务和受限工作负载身份，不能启用本地桌面模式作为生产替代。

生产网关通过 Redis 租约限制租户和渠道并发；Redis 不可用时拒绝新请求。流式解析和缓冲输出都有大小上限，上游截断不会被记为成功，未知用量保留为未知并进入对账。连接仅在相同授权范围及有效期内复用 HTTP/1.1；详见 [网关限额与运行行为](docs/operations/gateway-limits.md)。

### Agent 工具用量与订阅观测

配置项目工作目录，在“用量与计费 → Agent 工具采集”查看来源并启用自动发现；需要 Hook/导出的工具按各自提示配置。`npm run dev` 同时启动独立 Observer，默认每 60 秒扫描一次；本机 Windows 管理入口使用 `npm run dev:local`。详见[多工具采集手册](docs/operations/agent-observer.md)。Codex 原有连接和账户配置继续可用，见 [Observer 使用说明](docs/operations/subscription-observer.md)。

新增接入指南：[Pi / Factory / OpenClaw](docs/operations/agent-extended-cli-sources.md)、[Qoder IDE 与格式边界](docs/operations/agent-extended-ide-sources.md)、[Windsurf / CodeBuddy / Qoder / Factory / Kiro / Antigravity Hook](docs/operations/agent-hooks.md)。Kiro Hook 只记录会话开始；Factory 与 OpenClaw 导出需明确配置来源，不会自动读取其私有日志或当前 SQLite。TRAE、Continue 等通用桥接需要运行方提供实际事件；标记“尚未适配”的本地或云端工具不会因安装或登记而自动采集。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| src/ | Next.js 控制台、API、数据库与业务逻辑 |
| services/gateway/ | Go 流式网关与供应商适配器 |
| services/worker/ | 用量处理、账务与对账 |
| services/budget/ | 私有预算授权与预留服务 |
| services/observer/ | 本地订阅用量观测 |
| packages/contracts/ | 跨服务类型与 JSON Schema |
| drizzle/ | 数据库迁移 |
| tests/ | 契约、集成、安全和浏览器测试 |
| infra/ | Docker 镜像和生产部署配置 |

## 检查与构建

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm run security:check
npm run secrets:scan
npm run build
npm run services:build
npm run gateway:build
npm run gateway:check
```

集成测试和迁移测试会重置数据库结构，必须指定专用的临时 DATABASE_URL。不要使用开发日常数据库或生产数据库。

```sh
npm run test:integration
npm run db:migration:verify
```

完整 CI 包含迁移、隔离测试库、浏览器流程、Go race 检查和容器验证。部署前请阅读 [运维说明](docs/operations/README.md)、[数据库权限](docs/operations/database-workload-roles.md)及[密钥登记](docs/operations/independent-secret-enrollment.md)，显式执行迁移并配置每个服务的受限数据库身份。

欢迎提交 Issue 和 Pull Request。参见 [贡献指南](CONTRIBUTING.md) 与 [安全报告](SECURITY.md)。
