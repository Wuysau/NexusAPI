# NexusAPI 增量整合报告（2026-10-04）

本轮完成两项面向项目诊断的功能：已记录 Request/Attempt 详情、项目授权 Playground。功能代码、测试、ADR 和操作说明已完成独立审查、完整适用门禁及真实进程联调。Windows 原生 race 因缺少 cgo 工具链失败；支持的 Linux 容器完整 race 已通过。本文保留实现阶段的本地验收快照；后续用户要求更新使用手册并提交 main，发布记录以 main 的 Git 历史及对应 Actions 为准。

## Baseline

- 开始时 HEAD：`7c12a30679f42b66dd0cb03f316f41b2748ddea1`。与 main/origin main `19a9933c052ce1933a64405353eca1f7360351a9` 的文件树一致，初始受版本控制文件无改动。
- 开始时最新托管 CI：[37146254842](https://github.com/Wuysau/NexusAPI/actions/runs/37146254842)，失败于 Integration；迁移及此前门禁通过，后续门禁未运行。本地实现验收阶段未推送，因此该阶段没有新的托管 CI 验收；后续提交的 CI 单独记录，不替换本地证据。
- 已知失败：Observer fixture 写死 Windows 路径；Connector 测试收到共享库 URL，被专用库保护拒绝。先修复 fixture 路径及独立 Vitest 项目/数据库注入，生产校验及保护保留。开始功能实现前，unit 713、contract 269、migration 32、integration 523 全部通过，零跳过。
- 后续完整验证发现并处理的基线问题：31 个 Go 文件的历史 lint 问题（保留测试，清理语义不变）；健康恢复场景缺少独立数据库/真实 Linux 可执行文件；两个旧 E2E 文案断言过时；本地 standalone 追踪复制私有 fixture/Observer 配置。
- 依赖修复：Next.js 和配套 lint 配置由 16.3.4 升级至官方修复版本 16.3.6，处理 [GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)。Windows npm 更新误删两个仍被可选 WASM 父节点引用的 `@emnapi` 锁记录；恢复原有 npm 生成记录，洁净 Linux `npm ci`、锁文件不变、严格 SBOM 和生产审计均已验证。

## GitHub Research

动态搜索共扫描 51 个不同仓库；深入阅读 10 个仓库的固定版本源码、测试和许可证，超过提示词的数量要求。包括 AxonHub、Plano、GPT-Load、Langfuse、OpenLLMetry、Helicone、Hermes、OpenCode、LoongSuite Pilot、Agent Sessions。每项记录源码路径、关键机制、Nexus 差距、责任归属、安全/凭据/租户/计费/并发/迁移/许可风险及决定。

完整证据见[增量研究](open-source-delta-2026-10-04.md)、[长期借鉴记录](open-source-research.md)和[当前能力图谱及评分](../tasks/2026-10-04-delta-control-plane.md)。stars 和活跃时间为本轮观察快照；TensorZero 的 archived 状态也已记录。没有执行上游测试、复制源码或安装这些项目的依赖。

## Selected Features

| Feature | Reference | Problem / Why Nexus | Implementation |
| --- | --- | --- | --- |
| 已记录请求详情 | Langfuse、Helicone、AxonHub | 现有日志只展示最新尝试，无法核查多次尝试、冻结版本和用量证据；项目治理需要能解释实际执行及归属 | 有界只读事务读取 Request、按序最多 128 个已记录 Attempt 和 Worker 优先计量；沿用历史租户/组织/项目权限；白名单元数据；详情、链接、总数/截断及未知值 UI。评分 95。 |
| 项目 Playground | AxonHub | 静态页面不能在当前项目中确认模型调用、Key 授权和真实请求关联；控制面需要可验证的项目诊断入口 | 会话/CSRF/角色权限加精确项目 Key 校验；仅固定 Go Gateway 路径；有界缓冲文本对话、取消、显式多轮和请求链接；不新增推理或账务服务。评分 90。 |

先写 [Request trace ADR](../adr/2026-10-04-recorded-request-traces.md) 和 [Playground ADR](../adr/2026-10-04-project-playground.md)，再实施。独立审查发现合法长供应商请求 ID 及带换行项目名被新校验器误拒绝，已用字段专属兼容规则和契约/数据库回归测试修复。

## Rejected Features

拒绝结果不确定的推理自动重放、订阅凭据与 API Key 互换、默认提示词/输出采集、无限制 HQL、未经证实的价格计费及 Hook/Checkpoint 直接取得任务执行权。暂缓模型名猜测驱动的路由、进程内公平计数冒充持久容量、多工具监督及仅列出工具的 MCP“治理”。这些候选尚缺可靠能力证据、单一写入责任或版本化迁移，不能因上游流行而直接接入。

## Architecture Changes

| Area | Changes |
| --- | --- |
| Schema | 无新增迁移、表或历史回写；读取现有冻结事实。当前组织唯一约束保留。 |
| Services | Control Plane 增加两个有界业务模块，不增加独立执行进程；Worker/Budget/Observer/Local Agent 生产逻辑不变。 |
| API | `GET /api/logs/:id/trace`、`POST /api/playground/models`、`POST /api/playground/chat`；版本化白名单、授权、no-store。 |
| Gateway | 复用现有执行与持久化路径；没有新增热路径数据库访问。Go 修改用于历史 lint 修复。 |
| Agent | 没有新增原生适配器或监督模式；身份目录、观察和执行边界保留。 |
| UI | 日志完整已记录尝试详情、项目文本调试、临时内存凭据/上下文、取消及晚到结果隔离；未知 TTFT/Task/Session 不猜测。 |
| Build / CI | 五类独立 bootstrap 数据库；完整 Linux race 包含真实健康恢复；Next 补丁与完整锁文件；私有文件追踪排除、standalone 路径守卫及 Windows 生成 pg 别名的有界本地产物修复。 |

## Files Changed

| Important files | Role |
| --- | --- |
| `packages/contracts/{request-trace,playground}.ts` | 精确输入/输出、nullable 用量、有界数据及兼容校验。 |
| `src/lib/billing/request-trace.ts`、`src/app/api/logs/[id]/trace/route.ts` | 历史权限、两次读取、只读一致性、按 Attempt 计量锚点及隐藏内容。 |
| `src/lib/playground.ts`、`src/app/api/playground/{models,chat}/route.ts` | 项目 Key 授权、固定目标、字节/时间限制、取消、无重放及元数据意图审计。 |
| `src/components/{RequestTrace,Playground,LogTable}.tsx`、dashboard 页面、`src/app/globals.css` | 两项完整交互、项目/会话拥有者隔离及响应式样式。 |
| 两项服务 unit、`tests/contract/{request-trace,playground}.test.ts`、三个新 integration 文件 | canonical 计量、授权/隔离、隐私、界限、真实 Go/Worker 联调及取消证据。 |
| `tests/e2e/{request-trace,playground,control-plane}.mjs`、原有两个分析 fixture | 真实 React/Chromium 生命周期、真实 Next 路由和旧文案修复，保留并加强语义断言。 |
| `vitest.config.mjs`、CI workflow、fixture helper/三个 CI 脚本、Observer/Connector fixtures | 修复跨平台和专用库注入，检查真实数据库名及危险目标。 |
| `scripts/check-gateway.mjs`、健康恢复准备/验收脚本、31 个 Go 文件 | 完整 race/真实进程覆盖及零 lint 问题，不取消测试。 |
| `next.config.ts`、`scripts/{build-control,check-control-artifact,materialize-control-runtime}.mjs`、artifact 契约 | 排除已知私有目录/文件；拒绝未解析或产物外链接；仅用已追踪的产物内 pg 修复 Windows 别名，保留 Linux 内部链接。 |
| `package.json`、`package-lock.json` | 官方安全补丁和可再现的完整依赖树。 |
| 两个 ADR、能力/评分任务文档、研究/操作/CI 说明、README | 设计依据、使用限制及可复查验证记录。 |
| `docs/index.html` | 正式使用手册中的项目在线调试、已记录请求详情、权限、配置、取消与未知值说明。 |

## Verification

以下是本轮最终源码的实际命令结果，日期为 2026-10-04（Asia/Shanghai）。私有证据保存在忽略目录 `.test-artifacts/delta-verification/` 与 `.test-artifacts/infra-verification/`，不上传 Vault custody 文件。早期失败已修复后重新运行；下表保留未能通过的原生 Windows 环境项，不以 Linux 成功覆盖其状态。

| Command / acceptance | Result | Evidence / limits |
| --- | --- | --- |
| `npm run format:check` | PASS | 最终源码格式检查。 |
| `npm run lint` | PASS | 最终 ESLint 无错误。 |
| `npm run typecheck` | PASS | Next typegen + TypeScript。 |
| `npm run test:unit` | PASS | 754 tests / 64 files，0 skip。 |
| `npm run test:contract` | PASS | 391 tests / 29 files，0 skip，含产物隔离/别名修复。 |
| `npm run test:integration` | PASS | 582 tests / 53 files，0 skip；含新 trace 15、Playground 40 和真实 Gateway 4。 |
| `npm run test:security` | PASS | 49 tests / 5 files，0 skip。 |
| `npm run build` | PASS | Windows Next 16.3.6 standalone；产物私有路径/链接 guard 通过。 |
| `npm run services:build` | PASS | Worker、Budget、Observer 独立服务构建。 |
| `npm run gateway:build` | PASS | 原生 Go 可执行文件。 |
| `npm run gateway:test` | PASS | 原生完整 `go test ./...`。 |
| `npm run gateway:vet` | PASS | 原生完整 vet。 |
| `npm run gateway:race` | FAIL / NOT VERIFIED | Windows 缺少 cgo 所需工具链，exit 2；未验证原生 Windows race。 |
| `npm run ci:go` | PASS | 支持的 Linux 容器完整 race + Redis integration：2359 pass / 0 fail / 0 skip；golangci-lint 0 issues，实际健康故障/恢复和 Budget/Worker 验收。 |
| `npm run secrets:scan` | PASS | 保留现有扫描规则；测试 canary 使用明确不可用 fixture 标记。 |
| `npm run db:migration:verify` | PASS | 32 tests / 2 files，0 skip；历史 migration 未改。 |
| `node scripts/ci-fixtures.mjs` | PASS | 五类专用 loopback 数据库，确认真实 `current_database()`。 |
| `npm run ci:e2e` | PASS | 15 groups / 0 skip，实际 Next + Chromium，覆盖新功能及原有管理流程；无浏览器运行错误。 |
| `npm run compose:verify` | PASS | 四服务 Compose 配置验证。 |
| `npm run ci:images` | PASS | Control Plane、Gateway、Worker、Budget 四镜像构建；镜像摘要已记录。 |
| `npm run secrets:verify:fixture` | PASS | 73 checks / 0 skip，真实 TLS Vault、独立 AppRole/Agent 及 Go TLS/泄漏拒绝；仅 disposable fixture。 |
| `npm run security:check` | PASS | 生产依赖审计 0 vulnerability；不宣称开发依赖全部无漏洞。 |
| `npm run ci:sbom` | PASS | 严格完整依赖树，602 components；洁净 Linux `npm ci` 后锁文件不变、SBOM/生产审计通过。 |
| `npm run test:hooks` | PASS | 6 checks / 0 skip，在隔离临时 Git 仓库运行。 |
| `npm run ci:validate` | PASS | 当前 workflow/命令接线校验。 |
| `node .test-artifacts/verify-control-runtime.mjs` | PASS | 实际启动生产 standalone，健康接口执行真实 PostgreSQL 查询返回 200，子进程关闭；无生产部署。 |
| New schema migration | NOT APPLICABLE | 两项功能复用已有表；没有新增或修改 migration。 |
| New hosted GitHub CI run during local implementation acceptance | NOT RUN | 本地验收阶段没有 commit/push；后续 main 提交对应的 Actions 结果另行核对。 |
| Live paid provider / accounts / multi-machine Ollama / HA | NOT RUN | 不使用以前验收冒充本轮结果。 |

没有新增 Gateway 热路径 allocation、DB lookup、Redis call、network call 或 lock，因此本轮不新增热路径 benchmark。Trace 每次最多两次有界 SQL 读取，使用 READ ONLY / REPEATABLE READ；Playground 的额外控制面授权查询、一次 Gateway 网络调用属于用户显式调试请求。独立审查确认两项功能和最终构建修复没有未处理的实质问题。

## Real Behavior

- 实际运行：真实 PostgreSQL 会话/CSRF/RBAC 与项目 Key；独立 Go Gateway、签名快照、加密本地 BYOK、持久 Request/Attempt/outbox；真实 Worker 幂等处理；Go Linux race、Budget/Worker、存储故障恢复；真实 TLS Vault/AppRole/Vault Agent；实际生产 standalone 启动与数据库健康检查。
- Fixture 边界：新 Playground 上游为本地模拟供应商；两轮各执行一次、第三轮取消后落库 unknown 且 Token 为 null，没有自动重放。浏览器 Playground 用受控 HTTP 响应验证 UI；trace 浏览器还读取真实 Next 路由和 PostgreSQL facts。秘密/提示词/输出 canary 验证没有出现在日志、详情或执行事实中。
- 未做新验收：真实付费供应商、真实多账号/独立 Profile 交接、两台机器 Ollama、生产 HA/长期 Vault renewal。以前的真实账号记录不冒充本轮证据。
- 组织限制：当前 schema 唯一约束使同租户多组织无法构造原生数据库用例；保留该约束，原生验证跨租户 404，独立 SQL 单元验证组织联合权限规则。无新迁移，不声称完整多组织原生验收。
- 清理范围：验收服务进程已关闭；本轮启动的两个命名 Vault fixture 容器恢复停止状态。已有 PostgreSQL/Redis fixture 保持运行，普通开发容器及数据库未重置。

## Remaining Gaps

后续优先：可审核并版本化发布的模型能力证据；具有权威容量事实和单一写入者的持久调度；真实独立 Profile 的任务续接验收；可靠 Task/Session/TTFT 关联事实。Playground 首版保留有界缓冲文本限制，响应包含无法安全延续的语义时要求清空上下文。完整 Agent 工具调用图、MCP 授权与生命周期需要独立设计和验收。

现有 Key 创建 API 支持 `projectId`，但创建表单尚无项目选择；管理员目前需通过已有会话/CSRF 接口准备项目 Key。使用手册及操作说明提供了该前置步骤，不把普通未绑定 Key 当作可调试的项目 Key。后续可补充项目 Key 创建 UI。

构建守卫仅检查路径和链接元数据，覆盖已知开发/操作文件，不读取允许文件的内容，也不代替秘密扫描。Next 对动态文件路径仍有保守 tracing warning；未通过隐藏警告制造成功，实际本地/Linux 产物检查和生产包启动已通过。原生 Windows race 和真实供应商验收仍未完成；后续 main 提交的托管 CI 按对应 Actions 单独验收。
