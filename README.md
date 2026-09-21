# NexusAPI

开源 LLM 网关与用量管理控制台。统一管理模型渠道、API Key、项目、请求用量和订阅观测，提供兼容 OpenAI 的调用入口。

项目使用 [MIT License](LICENSE)，可修改、分发和商业使用，需保留许可证及版权声明。当前仍在持续开发，支付使用沙箱流程；源码公开不代表已经完成生产环境验收。

## 功能

- **统一网关**：Go 数据面提供 /v1/models、/v1/chat/completions 和 SSE 流式响应，支持 OpenAI 与 Anthropic 协议适配。
- **渠道与密钥**：配置上游地址、模型和 API Key，使用 Nexus API Key 调用已配置渠道。桌面本地模式支持界面录入上游密钥并加密保存。
- **项目与用量**：按组织、项目、连接查看实际请求、Token、价格来源和对账状态；未知价格保持未知，不自动记为免费。
- **订阅观测**：独立 Observer 读取 Codex 本地会话中允许的用量字段，并展示账户与官方配额观测。订阅会话不经 Nexus 转发，不产生 Nexus 扣费。
- **管理控制台**：成员权限、审计、账单、模型目录和价格审批。

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

### Codex 订阅观测

配置项目工作目录，在连接详情的“本地同步配置”中应用 Observer 配置。`npm run dev` 同时启动独立 Observer，默认每 60 秒扫描一次；也可手动同步。详见 [Observer 使用说明](docs/operations/subscription-observer.md)。

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
