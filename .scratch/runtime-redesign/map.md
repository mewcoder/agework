# Map: runtime/worker 角色与通信顶层重设计

## Destination

走到头手里拿到的是:**runtime / worker 角色能力、能力归属判断标准、注册机制、通信协议的顶层重设计文档 + 配套 ADR**。设计部分已完成(`design.md` v2 定稿);落地实现交由另一个 AI 按 `IMPLEMENTATION.md` + 7 个落地 ticket 执行,不在本 map 的 grilling 范围。

## Notes

- **域**:runtime / worker / provider 顶层架构。涉及 context:`apps/runtime`、`apps/server` runtime module、`apps/server` worker-manager module、`packages/providers`、`packages/worker`。
- **最终立场(混合方案)**:managed native(本机非容器)留 server 进程内,直读 fs/git;managed docker/opensandbox + registered 起独立 runtime 进程,经隧道 RPC。不为对称性给 native 强加进程崩溃负担。演进过程见 design.md 顶部「立场演进」。
- **产出**:设计文档 `design.md` + 落地交接 `IMPLEMENTATION.md` + 7 个落地 ticket。落地实现由另一个 AI 执行。
- **必读 ADR(决策层现状)**:
  - worker-manager:`0001`(worker 为主)/`0002`(start/stop/destroy)/`0003`(防重 key,**推翻**)/`0004`(文件通道,**部分推翻**)/`0005`(builtin 直读,**保留+精确化**)
  - runtime:`0001`(软删除+runtimeId 必填)/`0002`(envConfig 两层)/`0003`(CliResolver 放 apps/runtime)/`0004`(container CLI 走 env)
  - providers:`0001`(扩展点包)
  - apps/runtime:`0001`(SDK external + npm install)
  - packages/worker:`0001`(runner 独立入口)
- **术语(design.md §2.0,全程统一)**:runtime / worker(不叫「worker 实例」)/ runner / instanceId(物理载体标识,不当 worker 身份)。**不引入 host/manager/machine/载体**。
- **issue tracker 约定**:本地 markdown。map = 本文件;设计 ticket = `issues/01-main-concept-and-responsibilities.md`(已 resolve);落地 ticket = `issues/01-rename-fields.md` ~ `07-retire-wm0004-file-channel.md`。详见 `docs/agents/issue-tracker.md`。
- **ADR 落点**:推翻/部分推翻的 ADR,落地时写新 ADR 放对应 context `docs/adr/`,显式写「推翻 wm-000X,因为…」。

## Decisions so far

<!-- 设计 ticket 01 已 resolve,以下是顶层设计结论的 gist;详情见 design.md 对应节 -->

- [01 主概念与职责](issues/01-main-concept-and-responsibilities.md) — 混合方案:managed native 留 server 进程内直读,managed docker/opensandbox + registered 起独立 runtime 进程走隧道 RPC;不引入 host/machine,runtime 自己表达机器+类型;字段 source(managed/registered)+ runtimeType(native/docker/opensandbox)两字段,砍 location;协议身份用 workerId 破 wm-0003;能力归属按文件物理位置分(native 直读 / 容器+registered 隧道 RPC);推翻 wm-0003/0004(部分)/0005(精确化非推翻)。详见 [design.md](design.md)。

## 落地 ticket(交另一个 AI 实现,按依赖顺序)

| # | ticket | 依赖 | gist |
|---|---|---|---|
| 01 | [字段重命名](issues/01-rename-fields.md) | — | source: builtin→managed;runtimeType: local→native |
| 02 | [DB 防重 key](issues/02-db-unique-key.md) | 01 | Worker.ownerId @unique → (ownerId,runtimeId,isolationScope) @@unique |
| 03 | [协议身份 workerId](issues/03-protocol-worker-id.md) | 02 | 端点/Store/Dispatcher 从 ownerId 改 workerId |
| 04 | [managed 容器起独立 runtime 进程 + supervisor](issues/04-managed-container-runtime-process.md) | 01,03 | docker/opensandbox 经隧道 RPC launch;进程崩了 supervisor 重启(B1) |
| 05 | [能力 RPC 补全](issues/05-capability-rpc.md) | 04 | tunnel 新增 list-files/read-file/list-changed-files/read-file-diff |
| 06 | [LocalRuntime 收窄](issues/06-local-runtime-narrow.md) | 05 | 只服务 native;docker/opensandbox 能力迁出 |
| 07 | [wm-0004 文件通道退役](issues/07-retire-wm0004-file-channel.md) | 05 | registered/docker 文件改隧道 RPC 后移除 worker 代理通道 |

入口:[IMPLEMENTATION.md](IMPLEMENTATION.md)(落地总纲,给实现方的必读/顺序/验收/约束)。

## Not yet specified

<!-- 设计层已清空(都 graduate 成落地 ticket 或 design.md §10 未决)。以下为落地时细化的点,不阻塞设计成立 -->

- **supervisor 实现细节**:fork 监听 exit 的具体实现、重启退避策略、孤儿 worker 清理边界(design.md §5.7 定机制,落地 ticket 04 细化)。
- **写操作幂等性**:discard_file_change 等写操作在隧道 RPC 中途崩溃的幂等设计(design.md §5.4/§6.3 提出,落地时定)。
- **能力 RPC 协议类型**:请求/响应类型、错误码(design.md §5.5 定方法集,落地 ticket 05 细化)。

## Out of scope

- **agent adapter 内部实现**:Claude/Codex adapter(`packages/adapters`)的 SDK 调用、AG-UI 事件产出不在本次范围;只关心 runtime/worker 侧为 agent 提供什么执行环境与通道。
- **CLI 二进制安装与镜像构建**:apps/runtime-0001、runtime-0004 已拍板的构建链路不在本次范围。
- **② 远程但 server 管进程生死**:本期 source=managed 隐含本机,② 留未来(真做时加 location 字段)。
- **历史数据迁移**:新环境部署,builtin-local→managed-native 等改名无悬空外键问题,不写迁移脚本。
