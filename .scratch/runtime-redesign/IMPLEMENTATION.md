# 落地总纲:runtime/worker 角色与通信重设计

> 本文件是给**实现方(人或 AI)**的入口文档。设计依据是 [`design.md`](./design.md)(只读,不在此改)。按 ticket 顺序实现,每个 ticket 独立可验证。

## 0. 先读这些(必读,顺序固定)

1. **设计文档**:[`design.md`](./design.md) —— 完整读一遍,理解混合方案、术语定义(§2.0)、字段定稿(§2.2)、通信协议(§5)。
2. **项目规则**(强制遵守):
   - `CLAUDE.md`(repo 根)—— monorepo 结构、命令、前后端约定
   - `.claude/rules/backend-architecture.md` —— 模块边界、Port 纪律、反向依赖决策链、禁止范式
   - `.claude/rules/backend-naming.md` —— 命名规约(强制)
3. **现有 ADR**(改前必读对应 context 的 docs/adr/):
   - worker-manager:`0001`(worker 为主)/`0002`(start/stop/destroy)/`0003`(防重 key,本次推翻)/`0004`(文件通道,部分推翻)/`0005`(builtin 直读,保留+精确化)
   - runtime:`0001`(软删除+runtimeId 必填)/`0003`(CliResolver 放 apps/runtime)
   - providers:`0001`(扩展点包)
4. **术语**(design.md §2.0,全程统一):runtime / worker(不叫「worker 实例」)/ runner / instanceId(物理载体标识,不当 worker 身份)。**不引入 host/manager/machine/载体 等词。**

## 1. 核心立场(一句话)

**混合方案**:managed native(本机非容器)留 server 进程内,直读 fs/git;managed docker/opensandbox + registered 起独立 runtime 进程,经隧道 RPC。不为对称性给 native 强加进程崩溃负担。

## 2. 落地顺序(ticket 依赖链)

严格按顺序,前面的做完(验收过)才能做后面的:

| # | ticket | 依赖 | 核心改动 |
|---|---|---|---|
| 01 | 字段重命名 | — | source: builtin→managed;runtimeType: local→native |
| 02 | DB 防重 key | 01 | Worker.ownerId @unique → (ownerId,runtimeId,isolationScope) @@unique |
| 03 | 协议身份 workerId | 02 | 端点/Store/Dispatcher 从 ownerId 改 workerId |
| 04 | managed 容器起独立 runtime 进程 + supervisor | 01,03 | docker/opensandbox 经隧道 RPC launch;进程崩了 supervisor 重启 |
| 05 | 能力 RPC 补全 | 04 | tunnel 新增 list-files/read-file/list-changed-files/read-file-diff |
| 06 | LocalRuntime 收窄 | 05 | 只服务 native;docker/opensandbox 能力迁出 |
| 07 | wm-0004 文件通道退役 | 05 | registered/docker 文件改隧道 RPC 后移除 worker 代理通道 |

每个 ticket 文件在 `issues/` 下,格式见各文件。

## 3. 验收纪律(每个 ticket 必过)

1. **类型检查**:`pnpm typecheck`(或 `pnpm --filter <pkg> typecheck`)
2. **测试**:`pnpm test:server` / `pnpm test:web` / `pnpm --filter <pkg> test -- <file>`
3. **手工验证**(ticket 里列具体点)
4. **过不了不算完成**,留着 in_progress,不要跳到下一个

## 4. 硬约束(不要做)

- **不引入** host / manager / machine / 载体 / engine / core 等抽象空词(违反 backend-naming)
- **不引入** ports/ adapters/ domain/application 分层目录(违反 backend-architecture 禁止范式)
- **Service 不直接注入 PrismaService**(走 Repository)
- **不碰 §10 未决项的最终设计**(supervisor 细节、写操作幂等、RPC 类型——在对应 ticket 里细化,不在总纲定死)
- **不实现 ②**(远程但 server 管进程生死)——本期 source=managed 隐含本机,② 留未来
- **不处理历史数据迁移**(新环境部署,builtin-local→managed-native 等改名无悬空外键)
- **不碰保留的 ADR**(wm-0001/0002、runtime-0001/0002/0003/0004、providers-0001、apps/runtime-0001、packages/worker-0001)——除非某 ticket 明确要求

## 5. ADR 同步纪律

推翻/部分推翻的 ADR(wm-0003/0004/0005),在对应 ticket 完成时**写新 ADR**放对应 context 的 `docs/adr/`(编号接现有),显式写「推翻 wm-000X,因为…」。不默默改。

- wm-0003 推翻 → 新 ADR 放 `apps/server/src/worker-manager/docs/adr/`
- wm-0004 部分推翻 → 同上
- wm-0005 保留+精确化 → 放 `apps/server/src/runtime/docs/adr/`(精确化 builtin→managed native)

## 6. 命令速查

```bash
pnpm typecheck                          # 全量类型检查
pnpm --filter server typecheck          # 后端
pnpm --filter web typecheck             # 前端
pnpm test:server                        # 后端测试
pnpm --filter server test -- <spec>     # 后端单测
pnpm db:push                            # schema 改动后推库
pnpm db:studio                          # 看数据
pnpm dev                                # 起服务(验证用)
```

## 7. 卡住了怎么办

- 设计有歧义 → 回查 design.md 对应节 + §2.0 术语
- 规则有疑问 → 读 .claude/rules/
- ticket 范围不清 → 看 ticket 的「不做」清单,不要扩大范围
- 验收过不了 → 留 in_progress,记录卡点,不要跳下一个
