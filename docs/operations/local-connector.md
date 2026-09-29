# 两台机器使用本地 Ollama

远端运行 NexusAPI Control Plane、Go Gateway、PostgreSQL 和既有计量服务。本机运行 Ollama 与 `nexus-connector`。本机只发起出站连接，无需开放 Ollama 的公网端口。

```text
Coding Agent --项目 API Key--> 远端 Gateway
                                  |
                     HTTPS 领取任务 / 流式回传
                                  |
                          本机 nexus-connector
                                  |
                       127.0.0.1:11434 Ollama
```

## 1. 管理员准备远端

按项目既有部署流程配置签名快照、Gateway 内部身份、数据库与 Worker。生产环境继续使用既有 Vault/预算服务配置要求；本地上游密钥不进入这些服务。使用数据库管理身份执行新增迁移，再重新执行既有工作负载权限配置，让控制平面访问新增表：

```sh
npm ci
npm run db:migrate
# 按 docs/operations/database-workload-roles.md 重新应用角色授权
```

在 Control Plane 和 Gateway **同时**设置 `NEXUS_CONNECTORS_ENABLED=true`。Control Plane 设置 `NEXUS_GATEWAY_URL=https://gateway.example.com`，供连接页执行真实测试调用。构建前设置 `NEXT_PUBLIC_GATEWAY_BASE_URL=https://gateway.example.com/v1`。

Gateway 的新增配置：

```dotenv
NEXUS_CONNECTORS_ENABLED=true
GATEWAY_REPLICAS=1
CONTROL_PLANE_URL=https://control.example.com
GATEWAY_TLS_CERT=/run/tls/fullchain.pem
GATEWAY_TLS_KEY=/run/tls/key.pem
# 私有 CA 时另设 CONTROL_PLANE_CA_FILE=/run/tls/control-ca.pem
```

生产 Gateway 要求原生 TLS 证书与私钥，连接器验证服务端证书和主机名。Control Plane 也须提供 HTTPS。可通过四层负载均衡转发到这个 Gateway；首版不支持在多个副本之间分配连接器会话。`GATEWAY_REPLICAS=1` 与数据库会话排他锁会阻止第二个启用连接器的 Gateway 启动。数据库锁连接失效会停止该 Gateway。所有 `/connector/*` 与 `/v1/*` 请求必须到达这一个实例，不能混入关闭连接器功能的副本。

代理需允许至少 30 秒长轮询和流式请求体上传，不能缓冲 `/connector/result/*`。首版连接器每个进程最多同时执行 4 个调用，单次调用最长 600 秒（默认 120 秒），Gateway 还施加现有请求、流空闲和输出限制。升级采用停止旧实例后启动新实例；不支持滚动重叠。

## 2. 本机准备模型与程序

启动本机 Ollama，保留回环监听，下载所需模型。例如：

```sh
ollama pull qwen2.5:7b
ollama pull llama3.2:3b
curl http://127.0.0.1:11434/v1/models
```

从项目源码构建 CLI（Go 1.24 或更新版本）：

```sh
cd services/gateway
go build -o nexus-connector ./cmd/nexus-connector
```

Windows 使用 `go build -o nexus-connector.exe ./cmd/nexus-connector`，随后以 `./nexus-connector.exe` 运行。二进制可复制到另一台同操作系统、同架构电脑，不需要本机 Node.js、NexusAPI 服务或数据库。

在本机私有目录创建 `connector.json`：

```json
{
  "controlUrl": "https://control.example.com",
  "gatewayUrl": "https://gateway.example.com",
  "upstreamUrl": "http://127.0.0.1:11434/v1",
  "models": ["qwen2.5:7b", "llama3.2:3b"],
  "upstreamTimeoutSeconds": 120
}
```

模型 ID 必须同时位于管理员批准列表、本机配置列表和本机 `/v1/models` 返回列表中。地址必须是明确配置的回环或私有 IP，固定使用 `/v1/models` 和 `/v1/chat/completions`；不跟随重定向，不使用上游代理环境变量。`localhost` 会固定为 `127.0.0.1`。如果本机兼容服务需要密钥，设置 `apiKeyEnv` 为本机环境变量名；密钥值不会上传。私有 CA 可通过 `caFile` 指向本机 PEM 文件；没有跳过证书验证的选项。

开发测试可设置 `allowHttpDevelopment: true`，但它只允许远端地址为回环 HTTP，不能用于连接公网或内网远端机器。正式两机部署必须使用 HTTPS。

## 3. 创建、配对、启动

1. 管理员在控制台创建项目，再在“连接”添加 **本地连接器**，选择该项目。供应商为 Ollama。
2. 打开“配置与详情”，填写上述多个模型 ID，点击“保存模型并生成一次性配对令牌”。服务端只保存令牌散列；令牌有效期 10 分钟，只显示一次，兑换后不可重用。
3. 在本机运行以下命令，并在提示后粘贴令牌，不把它放进命令行参数或脚本：

```sh
./nexus-connector pair --config connector.json --identity connector-identity.json
./nexus-connector run --config connector.json --identity connector-identity.json
```

身份文件包含该连接器的长期身份凭据，应保存在当前用户私有目录。Unix 新文件权限为 `0600`；Windows 使用用户个人目录及限制为当前用户的 ACL。不要提交或共享该文件。CLI 不读取 Codex、Claude Code 的任何订阅认证文件。

连接器每 20 秒检查本地模型并续期 90 秒租约；传输使用 HTTPS 长轮询和独立流式上传。网络恢复后会重连。页面每 5 秒刷新详情：

- **已登记**：尚无租约。
- **连接器在线**：有效租约，最近 35 秒有经过身份认证的 Gateway 传输活动。
- **模型就绪**：在线且本机模型列表检查通过，仍需项目授权和实际调用验证。
- **离线 / 租约过期 / 已撤销**：不能发起新的本地模型调用。突发网络断线的页面状态有至多 35 秒观测窗口；Gateway 没有可领取任务的连接器时会更早拒绝请求。

在详情中选择就绪模型，输入该项目的 Nexus API Key，执行测试。测试经过真实 Gateway 路由并写入归因；如果同名模型实际选中了其他渠道，页面会提示，不能把其他渠道的成功算作本连接器成功。

## 4. Coding Agent 接入

在“API 密钥”创建绑定此项目的 Key，授权 `models:read` 和 `chat:write`。将 Agent 的 OpenAI 兼容 Base URL 设置为 `https://gateway.example.com/v1`，API Key 设置为该项目的 Nexus Key，模型设置为列表中的准确 ID：

```sh
curl https://gateway.example.com/v1/models \
  -H "Authorization: Bearer $NEXUS_API_KEY"

curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $NEXUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Hello"}],"stream":false}'

curl -N https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $NEXUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

首版只提供 Chat Completions 文本和流式传输，不代表支持任意 Agent 所需的全部工具调用、多模态、Embeddings 或 Responses 功能。内部沿用已有 OpenAI 适配器的流式上游调用，再聚合非流式客户端响应。上游未提供可靠字段时保留 `null/unknown`；没有价格时进入现有未定价/核对流程，不生成免费结算。通过项目分析查看 Gateway 用量与连接归因。

## 5. 撤销、轮换和故障排查

重新生成配对令牌会立即撤销原身份与租约；用新的私有身份文件重新配对。撤销连接会同时撤销租约、身份、未使用配对令牌并停用关联 Channel，历史记录保留。取消项目绑定、归档项目、禁用项目 Key 或 Channel 后，下一次连接器调用会被实时授权检查拒绝，不等快照刷新。

| 现象 | 检查 |
|---|---|
| 配对被拒绝 | 令牌是否过期、已兑换、被新令牌替代，连接是否撤销；重新生成后配对 |
| TLS 验证失败 | 域名、证书有效期、证书链；私有 CA 用 `caFile`，不要关闭验证 |
| 页面显示离线 | CLI 是否运行、出站 HTTPS 是否可达、Gateway 是否为指定的单实例、代理是否允许长轮询 |
| 在线但没有就绪模型 | 检查本机 `/v1/models` 和两处模型白名单，模型标签须完全相同 |
| `/v1/models` 没有模型 | Key 是否绑定同一个项目，项目是否有效，连接和渠道是否启用，快照是否已刷新 |
| 503 | 无可用连接器、租约失效、实时授权失败或控制面不可用；本地连接器采取拒绝策略 |
| 504 / 中途流错误 | Ollama 加载模型过慢、上游超时、网络中断；已经分发或开始输出的请求不会自动重放 |
| 第二个 Gateway 启动失败 | 首版单实例锁正常生效；停止旧实例后再启动 |
| 用量有记录但没有费用 | 上游用量字段不完整或没有核准价格，保持 unknown/未定价，不补零 |

## 验证与回退

`tests/integration/local-connector.test.ts` 会清空指定测试库，必须使用数据库名含 `connector_test` 的专用临时数据库：

```sh
node --env-file=/path/to/disposable-test.env node_modules/vitest/vitest.mjs run tests/integration/local-connector.test.ts
npm run typecheck
npm run gateway:test
npm run gateway:vet
node --env-file=/path/to/disposable-test.env node_modules/vitest/vitest.mjs run tests/integration/canonical-migrations.test.ts
```

该测试调用真实控制面路由与数据库，以不同进程运行编译出的 Gateway 和 CLI，经不同监听端口访问 mock Ollama，检查请求归因及 Worker 未定价处理。Go 单元测试检查 TLS 信任、私有地址、重定向和协议边界。

回退时先撤销连接并停止连接器，再关闭两端 `NEXUS_CONNECTORS_ENABLED`，回退应用。迁移 `0025` 为增量表/字段，不修改历史迁移；保留新增表和归因记录，不需要删除历史数据。
