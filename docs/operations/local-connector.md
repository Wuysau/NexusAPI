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
GATEWAY_HEALTHCHECK_TLS_SERVER_NAME=gateway.example.com
# 私有 CA 部署时，容器健康检查还需挂载并指定 CA 文件：
# GATEWAY_HEALTHCHECK_CA_FILE=/run/tls/ca.pem
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

Gateway 查询模型列表时，先执行现有路由过滤，再按 Channel 批量实时校验本地模型；每批最多 64 个 ID，最多同时检查 4 批，整个列表的认证、快照读取和实时检查共用 5 秒期限。无法及时确认的连接器模型不会出现在结果中，其他已确认可用的模型可以正常返回。列表授权结果不跨请求缓存，也不延长在线状态；真正的 Chat 调用仍单独实时检查授权。

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

配对会先以排他方式创建身份文件，再发送一次性兑换请求。已有文件、无效目录或无法创建文件时，不会消耗远端令牌；换一个新的私有文件路径即可重试。配对失败时只清理本次创建且仍为空的文件；其他进程写入或替换的文件、以及保存失败留下的非空文件会保留。身份响应不完整时也不会显示“配对成功”。

如果兑换请求已经发出，网络中断或主动取消后令牌可能已被服务端消费。CLI 不会自动重发，应重新生成配对令牌再尝试。保存失败后使用新的私有身份文件路径，不要覆盖原文件；成功提示表示身份已写入、同步并关闭。

连接器正常每 20 秒检查本地模型并续期 90 秒租约；传输使用 HTTPS 长轮询和独立流式上传。短暂网络失败期间，轮询与续租分别按有上限的指数退避重试，等待中加入随机间隔以分散重连；最大等待 15 秒。网络恢复后，只在有效租约内继续领取任务。租约到期会独立取消轮询、续租和正在执行的本地请求，不依赖下一次心跳才能停止。页面每 5 秒刷新详情：

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

页面上的“连接器在线”表示租约有效且近期有经过认证的传输活动。“模型就绪”还要求本机探测到该模型、渠道批准该模型，并且渠道、Provider、关联凭据、项目和组织仍有效。一个连接关联多个渠道时，连接页合并各有效渠道的就绪模型，资源页按各自渠道单独判断。停用 Provider 或收紧模型范围后，连接器可能仍在线，但模型会显示未就绪。该状态不代替项目 API Key 的逐次授权，也不等于模型已成功完成一次推理。

首版只提供 Chat Completions 文本和流式传输，不代表支持任意 Agent 所需的全部工具调用、多模态、Embeddings 或 Responses 功能。内部沿用已有 OpenAI 适配器的流式上游调用，再聚合非流式客户端响应。上游未提供可靠字段时保留 `null/unknown`；没有价格时进入现有未定价/核对流程，不生成免费结算。通过项目分析查看 Gateway 用量与连接归因。

Chat 的 `max_tokens` 和 `max_completion_tokens` 都会作为有效输出上限发给 Ollama 的 `max_tokens`；两者同时非空时采用 `max_completion_tokens`。远端启用 `GATEWAY_ENABLE_RESPONSES=true` 后，[现有 Responses 子集](./gateway-limits.md#responses-compatibility)也可经同一路径调用，其 `max_output_tokens` 使用同样的上限映射。Ollama 的本地接口仍为 `/v1/chat/completions`，无需更新连接器配置或 CLI。其他提供方的字段选择遵循各自已配置的协议。

对于支持工具调用和推理输出的 Ollama 模型，Chat 会返回统一的 `reasoning_content`。下一轮请完整保留 assistant 消息中的该字段和 `tool_calls`，并按 `tool_call_id` 提供工具结果；网关会将推理历史映射回 Ollama 的 `reasoning`。普通及流式两轮调用、多个工具及分片参数均有本地 mock 验证。实际模型仍需支持对应能力；网关不会补造推理内容、代为执行工具或启用 thinking 模式。推理文本和工具参数、结果只进入模型请求，不写入用量记录或进程日志。

## 5. 撤销、轮换和故障排查

重新生成配对令牌会立即撤销原身份与租约；用新的私有身份文件重新配对。撤销连接会同时撤销租约、身份、未使用配对令牌并停用关联 Channel，历史记录保留。取消项目绑定、归档项目、禁用项目 Key 或 Channel 后，下一次连接器调用会被实时授权检查拒绝，不等快照刷新。

CLI 在主动中断时正常退出；租约到期或 Control Plane 明确拒绝连接器身份时返回非零退出码，并输出不含凭据的原因。使用操作系统进程管理器运行时，可配置失败后延迟重启。重新启动会重新授权并领取新任务，不会恢复或重放上一进程的模型调用。身份已撤销时，应修复授权或重新配对后再启动，不能靠反复重启恢复权限。

Gateway 传输端点的 401 也可能来自暂时无法完成实时授权；连接器在当前租约内退避重试。直接来自 Control Plane 续租接口的 401/403 才会作为身份或授权失效终止。连接器不会根据错误正文打印远端返回的内部信息。

| 现象 | 检查 |
|---|---|
| 配对被拒绝 | 令牌是否过期、已兑换、被新令牌替代，连接是否撤销；重新生成后配对 |
| TLS 验证失败 | 域名、证书有效期、证书链；私有 CA 用 `caFile`，不要关闭验证 |
| 页面显示离线 | CLI 是否运行、出站 HTTPS 是否可达、Gateway 是否为指定的单实例、代理是否允许长轮询 |
| CLI 因租约到期退出 | 检查 Control Plane 的出站连通性和本机时钟；网络恢复后重新运行 `run`。检查原调用状态，再决定是否发起新调用 |
| CLI 提示身份授权被拒绝 | 检查连接、组织和项目是否仍有效；管理员轮换身份后须使用新文件重新配对 |
| 在线但没有就绪模型 | 检查本机 `/v1/models` 和两处模型白名单，模型标签须完全相同；确认渠道、Provider、关联凭据、项目和组织仍有效 |
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

升级批量模型发现时先更新 Control Plane，再更新 Gateway。新 Control Plane 兼容原单模型与传输授权请求；旧 Control Plane 会拒绝新的批量列表校验，模型会暂时隐藏。该升级不新增迁移，也不改变首版单 Gateway 的部署约束。
