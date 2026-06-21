# Runtime 架构整理：Provider 可插拔化 + 目录重组 + 命名统一

## Context

后端已做好"上层不关心下层 Agent 怎么跑"的分层（`RuntimeProvider` 控制面抽象 + `RuntimeTransport` worker 侧抽象，worker 二进制 provider-agnostic）。评估发现 4 个扩展缺口，本次解决其中影响最大的两组：

1. **Provider 可插拔化**（缺口 1+2）：provider 类型硬编码 `"local" | "docker"` 散落 8+ 处、registry 用 `switch`、选择靠全局 `RUNTIME_PROVIDER` env 一刀切，不能 per-workspace 选运行环境。
2. **目录/命名清晰度**：编排核心 6 个文件平铺在 `runtime/` 根目录无分组；`.service` 后缀随机（`run-record.service` 有、`runtime-runner` 无）；`run-`/`runtime-` 前缀语义分不清。

目标产出：加 provider 零改 `switch`（只加类 + 注册）、provider 选择可 per-workspace、文件命名一眼可辨层次。prisma 开发期清空重建，不做迁移。

---

## Part A — 目录重组 + 命名约定

### 约定（确定下来，后续按此扩展）

- **前缀**：`run-` = Run 领域实体/持久化；`runtime-` = 运行时执行机制。
- **后缀 = 角色**（role-based，比"全部 `.service`"更可读）：`.service`（纯服务/仓储）、`-runner`/`-processor`/`-store`/`-queue`/`-aggregator`/`-registry`/`-provider`（角色名）、`.controller`/`.guard`/`.module`（框架角色）。看后缀即知职责。

### 目标结构

```
runtime/
  runtime.module.ts
  core/                          ← 新增：编排核心（控制面↔worker 双向流转 + 状态）
    runtime-runner.ts            出站：启停/控制
    runtime-event-processor.ts   入站：worker 上行事件 → DB/SSE
    runtime-message-aggregator.ts
    runtime-active-store.ts      （原 active-runtime-store.ts，补 runtime- 前缀）
    run-record.service.ts        Run 的 DB 记录
    run-recovery.service.ts      重启孤儿恢复
  providers/                     ← 执行环境抽象层
    runtime-provider.token.ts    新增：RUNTIME_PROVIDERS DI token
    runtime-provider-registry.ts
    runtime-provider-utils.ts
    local-runtime-provider.ts
    docker-runtime-provider.ts
  internal/                      ← worker 回连的 HTTP 内部 API（不动）
  admin/                         ← admin controller（不动）
```

### 重命名/移动

| 现 | 目标 | 说明 |
|---|---|---|
| `runtime/active-runtime-store.ts` + class `ActiveRuntimeStore` | `runtime/core/runtime-active-store.ts` + `RuntimeActiveStore` | 唯一无前缀文件，补 `runtime-`；类同步改名 |
| `runtime/runtime-runner.ts` | `runtime/core/runtime-runner.ts` | 移入 core，名字已合规 |
| `runtime/runtime-event-processor.ts` | `runtime/core/runtime-event-processor.ts` | 同上 |
| `runtime/runtime-message-aggregator.ts` | `runtime/core/runtime-message-aggregator.ts` | 同上 |
| `runtime/run-record.service.ts` | `runtime/core/run-record.service.ts` | 同上 |
| `runtime/run-recovery.service.ts` | `runtime/core/run-recovery.service.ts` | 同上 |

> `runtime-runner`/`runtime-event-processor` 是 runner/processor **角色**，按 role-based 约定保持不带 `.service`，不与 `*.service` 冲突——这正是约定要消除的"看不出规律"问题。`.spec.ts` 随同移动。

### 受影响的 import 路径

移入 `core/` 后，需更新引用方的相对路径（仅路径，不改逻辑）：
- `runtime.module.ts`（全部 provider 注册路径）
- `core/` 内文件互相引用（runner→active-store/record、event-processor→active-store/record、recovery→record）
- `internal/runtime-internal.controller.ts`（引 event-processor、active-store）
- `providers/*`（引 event-processor）
- `agent/agent-run-handler.ts`（`../runtime/runtime-runner` → `../runtime/core/runtime-runner`；`runtime-message-aggregator` 同理）
- 改名 `ActiveRuntimeStore`→`RuntimeActiveStore` 的所有引用处一并替换

---

## Part B — Provider 可插拔化

### B1. 去硬编码 union（`packages/shared/src/protocol/transport.ts`）

- `RuntimeHandle.providerType: "local" | "docker"` → `string`
- `RuntimeProvider.type: "local" | "docker"` → `string`

各 provider 的 `readonly type = "local"/"docker" as const` 保留（自声明），但消费方不再依赖字面量 union。

### B2. registry 改 DI 多实例注册（去 switch）

新增 `providers/runtime-provider.token.ts`：
```ts
export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
```
`runtime.module.ts` 增加聚合 provider：
```ts
{ provide: RUNTIME_PROVIDERS,
  useFactory: (...ps: RuntimeProvider[]) => ps,
  inject: [LocalRuntimeProvider, DockerRuntimeProvider] }
```
`runtime-provider-registry.ts` 改为：
```ts
constructor(@Inject(RUNTIME_PROVIDERS) providers: RuntimeProvider[]) {
  this.map = new Map(providers.map(p => [p.type, p]));
}
resolve(type: string): RuntimeProvider {
  const p = this.map.get(type);
  if (!p) throw new Error(`Unknown runtime provider: ${type}`);
  return p;
}
```
**加 provider 从此 = 新建 class + 加进 module 的 providers 与 inject 数组，零 switch 改动。**

### B3. 选择粒度：全局 → per-workspace（带全局兜底）

- **Prisma**（`apps/api/prisma/schema.prisma`）：`Workspace` 加 `runtimeProvider String?`（null = 用全局默认）。`Run.providerType` 列已存在，复用。
- `config.service.ts`：`getRuntimeProviderType()` → 重命名 `getDefaultRuntimeProviderType(): string`，仍读 `RUNTIME_PROVIDER` env、默认 `"local"`；合法性校验下放给 `registry.resolve`（未知类型即抛）。
- `thread.service.ts` `getWorkspaceInfo`：返回值加 `runtimeProvider?: string`（workspace 已在查询内，直接带出）。
- `agent/agent-run-handler.ts`：解析 `providerType = workspaceInfo.runtimeProvider ?? configService.getDefaultRuntimeProviderType()`，传入 `runtimeRunner.start({ ..., providerType })`。
- `core/runtime-runner.ts` `start()`：新增入参 `providerType: string`，用它 `registry.resolve(providerType)`（替换原 `configService.getRuntimeProviderType()`）；建 Run 记录时落库该值。
- `core/run-record.service.ts` `create()`：入参加 `providerType: string`，写入 `Run.providerType`（当前仅在 `updateRuntimeHandle` 时回填；提前到 create 让 recovery 始终拿到正确值）。
- `core/run-recovery.service.ts`：`registry.resolve(run.providerType)` 去掉 `as "local" | "docker"` cast（已是 string）。
- **可设置入口**：`workspaces/dto/create-workspace.dto.ts` + `update-workspace.dto.ts` 加可选 `runtimeProvider?: string`；`workspace.service.ts` 透传；`packages/shared/src/api/workspaces.ts` 同步类型。前端 UI 选择器作为后续项，不在本次范围。

`RunConfig` **不加** `providerType`——它发给 worker，worker 与运行环境无关，选择是纯控制面概念。

---

## 关键文件清单

- 协议：`packages/shared/src/protocol/transport.ts`、`packages/shared/src/api/workspaces.ts`
- runtime：`runtime.module.ts`、`core/*`（移动+改）、`providers/runtime-provider-registry.ts`、新增 `providers/runtime-provider.token.ts`、`internal/runtime-internal.controller.ts`（import）
- 业务：`agent/agent-run-handler.ts`、`config/config.service.ts`、`threads/thread.service.ts`
- workspace：`prisma/schema.prisma`、`workspaces/dto/*.ts`、`workspaces/workspace.service.ts`
- 测试：`runtime-provider-registry.spec.ts`（switch→map）、`run-record.service.spec.ts`（create 签名）、`runtime-runner.spec.ts`（providerType 入参）、随移动文件的 `.spec.ts` 路径

## 验证

1. `pnpm typecheck` 全绿（union→string、移动后 import、改名引用都需通过）。
2. `pnpm test:api` 全绿；更新上述受影响 spec。
3. prisma：改 schema 后 `pnpm prisma generate` + 开发库重置。
4. 端到端：
   - workspace A `runtimeProvider="docker"`、workspace B `null`（全局 `RUNTIME_PROVIDER=local`）。两个 workspace 各跑一次 agent，确认 `Run.providerType` 分别为 `docker`/`local`、provider 日志对应、SSE 正常完成。
   - 兜底路径：未设列的 workspace 仍走全局默认。
5. 可插拔性自检：registry 已无 `switch`；新增 provider 仅需建类 + 注册到 module 两处数组。
