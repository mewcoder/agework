# Run 模块梳理重构 Implementation Plan

> ⚠ **模块形态已被 supersede**：本 plan 把 `RunService` 收敛在**单个 `runtime` module 内**。最新方向见 `docs/agent-run-runtime-layering-review.md`——改为拆出独立 `runs/` + `RunModule` 与 `runtime/` 两 module，并用 hooks 注册表断循环依赖。**执行以那份为准**；本 plan 仅可复用 Phase 2/3 的"劈 buildRunConfig、搬编排"逻辑步骤，目录/module 形态作废。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"发起/控制一次 agent run"的能力收敛到 runtime 模块内的单一门面 `RunService`,让 agent 模块退回纯入口层——只选 agent 配置、产出 `AgentSpec`,其余(placement、RunConfig 组装、生命周期、事件、持久化、SSE)全部藏到缝下面。

**Architecture:** 概念上只有两层、一道缝。缝上面是调用方(`AgentController` / `AgentRunHandler`),只认 `RunService` 的意图级 API 和一个 DTO;缝下面是 Run 聚合的全部内部(agent adapter 端口、runtime provider 端口、aggregator、policy、recorder)。本次重构不改变任何运行时行为,只搬动职责、补严这道缝。

**Tech Stack:** NestJS 11、TypeScript、Vitest(`*.spec.ts`)。

## Global Constraints

- **行为不变**:这是 behavior-preserving 重构。出站(发起 run)与入站(worker 回流事件)两条链路的可观察行为必须完全一致。每个 Phase 结束时 `pnpm --filter api typecheck` 与 `pnpm test:api` 必须全绿。
- **不新增依赖**,不引入新库。
- **依赖方向单一**:重构后 `agent` 模块只能 import runtime 模块导出的 `RunService` 及其输入类型,**不得**再 import `runtime/core/**` 下任何具体类(`RunRunner`、`RunMessageAggregator`、`RuntimePlacementPolicy`、`RunRepository` 等)。
- **不扩大范围**:见文末「Out of Scope」。事件审计订阅化、provider 重构、aggregator 内部改写都不在本次。
- 注释与文档沿用仓库现有中文风格。

---

## 背景:现状与四个病灶

### 出站链路(发起 run)
```
AgentController.run (agent.controller.ts:25)
└─ AgentRunHandler.run (agent-run-handler.ts:43)   ← 180 行,8 件事
   ├─ ConversationService.findOne / getWorkspaceInfo / setActiveRunStatus / saveUserMessage
   ├─ ConfigService.isRuntimeTypeAllowed / isIsolationScopeAllowed
   ├─ RuntimePlacementPolicy.resolveForRun           ← 缝下面的东西
   ├─ AgentRunConfigBuilder.buildRunConfig(placement) ← 脑裂:agent + runtime 混合
   ├─ TitleService.maybeGenerate
   ├─ new RunMessageAggregator() + 自拼 saveRun 闭包  ← 缝下面的东西
   └─ RunRunner.start({ 11 参数,含 res/aggregator/saveRun })
```

### 入站链路(worker 回流,本次不动,仅供参照)
```
RuntimeInternalController.postEvent → RunEnvelopeProcessor.publish
  → handleRunStatus → decideRunStatusUpdate(纯策略) → RunExecutionStatusHandler.apply
  → handleAgUiEvent → aggregator.handle / saveRun / res.write
```

### 四个病灶
1. **编排职责在 `AgentRunHandler` 与 `RunRunner` 之间糊成一团**,两个都是 orchestrator,边界模糊。
2. **⭐ 缝漏(本次核心)**:`AgentRunHandler` 直接 import 并使用 `RunMessageAggregator`、`RunRunner`、`RuntimePlacementPolicy`,亲手 `new RunMessageAggregator()`、亲手拼 `saveRun` 持久化闭包、亲手算 placement(`agent-run-handler.ts:19-20,150-158,270-326`)。`AgentController` 还直接依赖 `RunRunner` 做 reply/stop(`agent.controller.ts:8,48,58`)。缝上面的两个类都伸手进了缝下面。
3. **`AgentRunConfigBuilder.buildRunConfig` 脑裂**:`buildAdapter`(选 modelProvider/kind/model,属 agent)与 `placement`+`buildRuntimeLogPaths`(属 runtime)被焊在一个方法里,因此 agent 层被迫先算 placement 才能拼 RunConfig(`agent-run-config-builder.ts:42-74,150-174`)。
4. **`RuntimeModule` 把内部全 export 出去**(`RunRunner`、`RuntimePlacementPolicy`、`RunRepository` 等,`runtime.module.ts:102-109`),缝形同虚设。

> 注:`RunLifecyclePolicy`(纯决策)、`RuntimeProvider`(多态)、`RunMessageAggregator`、`RunRepository` 都是赚到的拆分,**保留**。本次不是"合并成一个类",而是"补严唯一的缝"。

---

## 目标架构

### 两层 + 一道缝
```
┌─ 调用方(agent 模块)──────────────────────────────┐
│  AgentController:HTTP 路由                          │
│  AgentRunHandler:把请求翻成 StartRunInput          │
│  AgentSpecBuilder:产出 AgentSpec(纯选择,无 placement)│
└──────────────────── 缝 ────────────────────────────┘
┌─ Run 聚合(runtime 模块,缝下私有)─────────────────┐
│  RunService(唯一门面)                              │
│   ├─ agent 端口:AgentSpec(what/how)               │
│   └─ runtime 端口:RuntimePlacementPolicy + Provider │
│  RunConfigAssembler / aggregator / policy / recorder │
└─────────────────────────────────────────────────────┘
```

### 缝的契约(runtime 模块拥有并导出类型)
```ts
// apps/api/src/runtime/core/run-execution/run-service.types.ts(新建)
import type { Response } from "express";
import type { AdapterRuntimeConfig } from "@agework/shared/protocol";

/** agent 端口:agent 模块产出,描述"用什么、怎么配",绝不含 placement / 路径 / runId。 */
export type AgentSpec = {
  agentType: string;
  modelProviderId: string;
  model?: string;
  adapter: AdapterRuntimeConfig;   // AgentSpecBuilder 解析 modelProvider 后产出
  permissionMode?: string;         // 已归一化
  resume?: string;                 // claude 的 agentSessionId resume
  forwardedProps: Record<string, unknown>;
};

export type StartRunWorkspace = {
  workspaceId: string;
  rootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  sandboxEngine?: string | null;
};

/** RunService.start 的唯一入参:意图级,无 aggregator / 无 saveRun / 无 placement。 */
export type StartRunInput = {
  conversationId: string;
  runId: string;
  userId: string;
  agentSpec: AgentSpec;
  workspace: StartRunWorkspace;
  input: unknown;                  // 透传给 worker 的 messages 负载
  userMessage?: { id?: unknown; [k: string]: unknown };
  userMessageId?: string;
  res: Response;
  interruptReason?: "user_steered";
  agentSessionId?: string;         // 已有会话,用于 setAgentSessionId 回写起点
};
```

### `RunService` 公开 API(缝上面唯一可见的东西)
```ts
class RunService {
  start(input: StartRunInput): Promise<void>;
  resumeStream(conversationId: string, res: Response): Promise<void>;
  stop(conversationId: string, opts?: { reason?: IncompleteMessageReason; endResponse?: boolean }): Promise<boolean>;
  resolveApproval(conversationId: string, answers: Record<string, string | string[]>): Promise<void>;
}
```
> `RunService` = 现 `RunRunner` 升格而来:`resumeStream`/`stop` 即现有 `attachStream`/`stop`;`resolveApproval` 即现 `sendApprovalResolved`;`start` 吸收 `AgentRunHandler.run` 里属于缝下面的那部分编排。

---

## 目标文件结构(谁建、谁改、谁删)

**新建**
- `apps/api/src/runtime/core/run-execution/run-service.types.ts` — `AgentSpec` / `StartRunInput` / `StartRunWorkspace`。
- `apps/api/src/runtime/core/run-execution/run-config.assembler.ts` — `RunConfigAssembler`,吃 `AgentSpec + placement + workspace + runId/conversationId/input` 产出 `RunConfig`(buildRunConfig 的 runtime 下半身)。
- `apps/api/src/runtime/core/run-execution/run-config.assembler.spec.ts`

**改名 / 升格**
- `run.runner.ts` → `run-service.ts`,`RunRunner` → `RunService`,方法名按上表对齐;`start` 改为吃 `StartRunInput`,内部新增 placement 解析、RunConfig 组装、aggregator+saveRun 构造、并发守卫、用户消息持久化、标题触发。
- `run.runner.spec.ts` → `run-service.spec.ts`,随之更新。

**改造**
- `agent-run-config-builder.ts` → 瘦身为 `AgentSpecBuilder`(`agent-spec.builder.ts`):只保留 `buildAdapter` + 权限归一化,产出 `AgentSpec`,删除 placement / log-paths / RunConfig 组装。对应 spec 改名跟随。
- `agent-run-handler.ts` → 瘦成"请求→StartRunInput 翻译":解析 body、查 conversation 拿 agentType/session/workspace、调 `AgentSpecBuilder.build`、组 `StartRunInput`、`RunService.start`。删除 placement/aggregator/saveRun/标题/并发守卫/用户消息持久化等下层逻辑。
- `agent.controller.ts` → 把 `RunRunner` 依赖换成 `RunService`,`reply`→`resolveApproval`、`stop`→`stop`、`resume`→委托 handler 不变。
- `agent.module.ts` → providers 用 `AgentSpecBuilder` 替 `AgentRunConfigBuilder`。
- `runtime.module.ts` → providers 注册名 `RunService`;**exports 收窄**为 `RunService`(+ admin/其他模块确有依赖的最小集),移除 `RunRunner`、`RuntimePlacementPolicy` 等对 agent 的暴露。

**保持不变**:`run-envelope.processor.ts`、`run-execution-status.handler.ts`、`run-lifecycle.policy.ts`、`run-message.aggregator.ts`、`run-active.store.ts`、`run-event-*`、`providers/**`、`internal/**`、`admin/**`。

---

## 实施顺序与原则

四个 Phase 依赖递进,每个 Phase 自身可编译、可测、可独立提交。**因为是行为不变重构,验证靠"现有 spec 不变且全绿 + typecheck",而不是先写 failing test。** 当某段逻辑搬家时,对应的 `*.spec.ts` 跟着搬到新宿主,断言不变。

---

## Phase 1:堵住 controller 的缝(引入 RunService 门面)

**动机:** 病灶 2 里最浅的一处——`AgentController` 直接依赖 `RunRunner`。先把 `RunRunner` 升格为 `RunService` 并对齐对外方法名,让 controller 只认门面。此阶段不搬任何编排逻辑,纯改名 + 收口,风险最低,先验证手感。

**Files:**
- Modify→Rename: `apps/api/src/runtime/core/run-execution/run.runner.ts` → `run-service.ts`
- Modify→Rename: `apps/api/src/runtime/core/run-execution/run.runner.spec.ts` → `run-service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`
- Modify: `apps/api/src/agent/agent.controller.ts`
- Modify: `apps/api/src/agent/agent-run-handler.ts`(仅把注入类型从 `RunRunner` 改名为 `RunService`,逻辑不动)

**Interfaces:**
- Produces: `RunService`,公开方法 `start(...)`(本阶段签名仍同旧 `RunRunner.start`)、`resumeStream`、`stop`、`resolveApproval`。
- Consumes: 无。

- [ ] **Step 1: 改名类与文件**

`git mv apps/api/src/runtime/core/run-execution/run.runner.ts apps/api/src/runtime/core/run-execution/run-service.ts` 并把类名 `RunRunner`→`RunService`。同时把对外方法重命名:`attachStream`→`resumeStream`、`sendApprovalResolved`→`resolveApproval`(`start`、`stop` 名称不变)。类内私有方法不动。

- [ ] **Step 2: 同步 spec 文件改名与引用**

`git mv .../run.runner.spec.ts .../run-service.spec.ts`,把 import、`new RunRunner`/注入、被测方法名同步成 `RunService` / `resumeStream` / `resolveApproval`。断言逻辑一字不改。

- [ ] **Step 3: 更新 runtime.module.ts 注册与导出**

`run.runner` import 路径改为 `run-service`,provider 与 export 中 `RunRunner` 改 `RunService`。本阶段 exports 暂保持其余项不变(收窄留到 Phase 4)。

- [ ] **Step 4: 更新 agent.controller.ts**

把构造注入 `private readonly runtimeRunner: RunRunner` 改为 `private readonly runService: RunService`,import 路径改为 `runtime/core/run-execution/run-service`;`reply` 调 `this.runService.resolveApproval(...)`,`stop` 调 `this.runService.stop(...)`。

- [ ] **Step 5: 更新 agent-run-handler.ts 注入名**

仅把 `RunRunner`/`runtimeRunner` 的类型与 import 改为 `RunService`/`runService`,`.start(...)`/`.stop(...)`/`.attachStream(...)→.resumeStream(...)` 调用名同步。逻辑保持原样。

- [ ] **Step 6: typecheck + 测试**

Run: `pnpm --filter api typecheck && pnpm test:api`
Expected: PASS(无行为变化,现有 spec 全绿)。

- [ ] **Step 7: 提交**

```bash
git add -A apps/api/src/runtime apps/api/src/agent
git commit -m "refactor(api): promote RunRunner to RunService facade"
```

---

## Phase 2:劈开脑裂的 buildRunConfig

**动机:** 病灶 3。把 `AgentRunConfigBuilder.buildRunConfig` 沿缝劈成两半:agent 半身(`buildAdapter`→产 `AgentSpec`)留在 agent 模块并改名 `AgentSpecBuilder`;runtime 半身(placement→log paths→`RunConfig` 组装)迁入新建的 `RunConfigAssembler`。劈开后 agent 层不再需要 placement 也能产出自己的产物。

**Files:**
- Create: `apps/api/src/runtime/core/run-execution/run-service.types.ts`
- Create: `apps/api/src/runtime/core/run-execution/run-config.assembler.ts`
- Create: `apps/api/src/runtime/core/run-execution/run-config.assembler.spec.ts`
- Modify→Rename: `apps/api/src/agent/agent-run-config-builder.ts` → `agent-spec.builder.ts`(`AgentRunConfigBuilder`→`AgentSpecBuilder`)
- Modify→Rename: `apps/api/src/agent/agent-run-config-builder.spec.ts` → `agent-spec.builder.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`(注册 `RunConfigAssembler`)

**Interfaces:**
- Produces:
  - `AgentSpec`/`StartRunInput`/`StartRunWorkspace`(见目标架构代码块,本阶段落地 types 文件)。
  - `AgentSpecBuilder.build(params: { agentType: string; modelProviderId: string; model?: string; permissionMode?: string; resume?: string; forwardedProps: Record<string, unknown> }): Promise<AgentSpec>`。
  - `RunConfigAssembler.assemble(params: { agentSpec: AgentSpec; placement: RuntimePlacement; workspaceId: string; runId: string; conversationId: string; input: unknown }): RunConfig`。
- Consumes: `RuntimePlacement`、`RunConfig`、`AdapterRuntimeConfig`(`@agework/shared/protocol`);`ModelProviderService`、`ConfigService`。

- [ ] **Step 1: 落地 run-service.types.ts**

按「缝的契约」代码块新建该文件(`AgentSpec` / `StartRunWorkspace` / `StartRunInput`)。

- [ ] **Step 2: 抽出 AgentSpecBuilder(agent 半身)**

`git mv agent-run-config-builder.ts agent-spec.builder.ts`。改类名 `AgentSpecBuilder`。保留并复用现有 `buildAdapter` / `resolveAdapterKind`(`agent-run-config-builder.ts:79-115`)。新方法:
```ts
async build(params: {
  agentType: string; modelProviderId: string; model?: string;
  permissionMode?: string; resume?: string;
  forwardedProps: Record<string, unknown>;
}): Promise<AgentSpec> {
  const resolved = await this.modelProviderService.resolveEnabledConfig(
    params.agentType, params.modelProviderId);
  if (!resolved) throw new BadRequestException(`模型服务不可用: ${params.modelProviderId}`);
  const adapter = buildAdapter(params.agentType, resolved, params.model);
  return {
    agentType: params.agentType,
    modelProviderId: params.modelProviderId,
    model: params.model,
    adapter,
    permissionMode: params.permissionMode,
    resume: params.resume,
    forwardedProps: params.forwardedProps,
  };
}
```
删除本文件中的 `buildRuntimeLogPaths` / `buildAgentEventTraceConfig` / `CONTAINER_RUNTIME_LOG_DIR` / `safePathPart` 等 placement 相关依赖与函数——它们迁往 Step 3。

- [ ] **Step 3: 新建 RunConfigAssembler(runtime 半身)**

把 `buildRunConfig` 里依赖 placement 的部分(`agent-run-config-builder.ts:52-76,120-174`)整体迁入,签名见 Interfaces。`agentEventTrace`、`workerLogFilePath`、`runtimePath` 等保持原计算逻辑;`adapter` 直接取自 `agentSpec.adapter`,`agentType` 取自 `agentSpec.agentType`。

- [ ] **Step 4: 拆分并迁移测试**

`agent-spec.builder.spec.ts` 只保留断言 adapter/modelProvider 解析与错误分支(原 `buildAdapter` 相关用例),去掉 placement/路径断言。把 placement/路径相关断言迁到新建 `run-config.assembler.spec.ts`。

- [ ] **Step 5: 在 module 注册 RunConfigAssembler,agent.module 换名**

`runtime.module.ts` providers 增加 `RunConfigAssembler`(暂不 export,仅供 `RunService` 内部用);`agent.module.ts` 把 `AgentRunConfigBuilder` 替换为 `AgentSpecBuilder`。
> 注意:此时 `AgentRunHandler` 仍在调用旧的 `buildRunConfig` —— Step 6 临时改为先 `AgentSpecBuilder.build` 再(暂时仍由 handler 持有 placement)直接调用 `RunConfigAssembler` 以保持可编译。完整迁出在 Phase 3。

- [ ] **Step 6: 临时接线让 handler 可编译**

`agent-run-handler.ts` 中:`runConfigBuilder.buildRunConfig(...)` 改为 `const agentSpec = await this.agentSpecBuilder.build({...}); const runConfig = this.runConfigAssembler.assemble({ agentSpec, placement, ... })`。handler 暂时同时注入二者(过渡态,Phase 3 清掉 assembler/placement)。

- [ ] **Step 7: typecheck + 测试**

Run: `pnpm --filter api typecheck && pnpm test:api`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add -A apps/api/src
git commit -m "refactor(api): split buildRunConfig into AgentSpecBuilder + RunConfigAssembler"
```

---

## Phase 3:把缝下编排搬进 RunService.start

**动机:** 病灶 1 + 病灶 2 主体。把 placement 解析、runtime/isolation 校验、`RunConfigAssembler.assemble`、`new RunMessageAggregator()`、`saveRun` 闭包、并发守卫、用户消息持久化、标题触发,从 `AgentRunHandler` 全部迁入 `RunService.start`,使 `start` 吃 `StartRunInput`。handler 收缩为请求→DTO 翻译。

**Files:**
- Modify: `apps/api/src/runtime/core/run-execution/run-service.ts`(`start` 改签名 + 吸收编排;注入 `RuntimePlacementPolicy`、`RunConfigAssembler`、`ConfigService`、`TitleService`)
- Modify: `apps/api/src/runtime/core/run-execution/run-service.spec.ts`
- Modify: `apps/api/src/agent/agent-run-handler.ts`(瘦身)
- Modify: `apps/api/src/agent/agent.module.ts`(`TitleService` provider 归属随调用方;若 `TitleService` 迁入 runtime 则在此移除)
- Modify: `apps/api/src/runtime/runtime.module.ts`(注册新依赖;import `ConfigModule`/`ModelProviderModule` 视需要)

**Interfaces:**
- Consumes:`StartRunInput`(Phase 2)、`AgentSpecBuilder.build`(Phase 2)、`RunConfigAssembler.assemble`(Phase 2)、`RuntimePlacementPolicy.resolveForRun`、`ConfigService`。
- Produces:`RunService.start(input: StartRunInput): Promise<void>`(最终签名)。

- [ ] **Step 1: RunService.start 改签名并吸收编排**

`start` 入参改为 `StartRunInput`。内部按下列顺序(等价迁移现 `AgentRunHandler.run` 的 130-326 行 + 现 `RunRunner.start`):
  1. 校验 `workspace`/`modelProviderId`、`ConfigService.isRuntimeTypeAllowed`/`isIsolationScopeAllowed`、解析 `isolationScope`(迁自 `agent-run-handler.ts:122-148`)。
  2. `RuntimePlacementPolicy.resolveForRun(...)`(迁自 `:150-158`)。
  3. `RunConfigAssembler.assemble({ agentSpec, placement, workspaceId, runId, conversationId, input })`。
  4. SSE 头设置 + 并发守卫 `setActiveRunStatus("running")` + `user_steered` 中断分支(迁自 `:202-250`)。
  5. `saveUserMessage` + `TitleService.maybeGenerate`(迁自 `:252-267`)。
  6. `new RunMessageAggregator()` + `saveRun` 闭包(迁自 `:270-305`)。
  7. 原 `RunRunner.start` 主体(create run、event record、provider.start、register)。
  `onAgentSessionId` 回写改为内部直接调用 `ConversationService.setAgentSessionId`(handle 已有 conversationId)。

- [ ] **Step 2: handler 瘦身为翻译层**

`AgentRunHandler.run` 只保留:解析 body 字段、`ConversationService.findOne`/`getWorkspaceInfo` 取 agentType/agentSessionId/workspace、`normalizePermissionForwardedProps`、`AgentSpecBuilder.build(...)`、组 `StartRunInput`、`await this.runService.start(input)`。`resumeStream` 保持委托 `runService.resumeStream`。删除 placement/aggregator/saveRun/标题/并发守卫等代码及其 import(`RunMessageAggregator`、`RuntimePlacementPolicy`、`RunConfigAssembler`、`ConfigService` 中仅本逻辑使用的部分、`swallow` 若不再用)。

- [ ] **Step 3: 迁移测试断言**

把 `agent-run-handler.spec.ts` 中针对 placement/并发守卫/saveRun/标题的断言迁到 `run-service.spec.ts`;`agent-run-handler.spec.ts` 只保留"正确把请求翻成 StartRunInput 并调用 RunService.start"的断言(可对 `RunService.start` 做 mock 断言入参形状)。

- [ ] **Step 4: module 接线**

`runtime.module.ts` 给 `RunService` 注入 `RuntimePlacementPolicy`、`RunConfigAssembler`、`ConfigService`、`TitleService`(`TitleService` 建议随之迁入 runtime providers;若保留在 agent,则需让 runtime import 其所在 module——优先迁入 runtime 以避免反向依赖)。`agent.module.ts` 移除不再使用的 provider。

- [ ] **Step 5: typecheck + 测试**

Run: `pnpm --filter api typecheck && pnpm test:api`
Expected: PASS。手动核对:发起 run、user_steered 打断、首条消息标题、刷新 resume、approval reply、stop 六条路径行为不变(对照本文「出站链路」与 `run-service.spec.ts` 用例)。

- [ ] **Step 6: 提交**

```bash
git add -A apps/api/src
git commit -m "refactor(api): move run orchestration from AgentRunHandler into RunService.start"
```

---

## Phase 4:收窄 RuntimeModule 导出,焊死缝

**动机:** 病灶 4。让缝在编译期生效——agent 模块除 `RunService` 与 `StartRunInput`/`AgentSpec` 类型外,够不到 runtime 任何内部类。

**Files:**
- Modify: `apps/api/src/runtime/runtime.module.ts`(`exports` 收窄)
- 受影响的其他模块(若有 import `RunRepository`/`RuntimePlacementPolicy` 等被移除的导出)按需调整——`admin/**` 控制器在本模块内,不受 export 影响。

- [ ] **Step 1: 收窄 exports**

`runtime.module.ts` 的 `exports` 改为最小集:`RunService`,以及确有跨模块消费者的项(用 `git grep` 核实后保留)。移除对 agent 已无意义的 `RuntimePlacementPolicy` 等。

- [ ] **Step 2: 全仓核实没有越界 import**

Run: `git grep -nE "core/run-execution/run-service|RunRunner|RunMessageAggregator|runtime-placement\.policy" apps/api/src/agent`
Expected: 仅剩对 `RunService` 与 `run-service.types` 的 import,无任何 `core/**` 具体类。

- [ ] **Step 3: typecheck + 测试**

Run: `pnpm --filter api typecheck && pnpm test:api`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A apps/api/src/runtime
git commit -m "refactor(api): narrow RuntimeModule exports to RunService facade"
```

---

## Out of Scope(本次明确不做,YAGNI)

- **事件审计订阅化**:`RunEventRecorder.append(...).catch(swallow)` 散落 12 处(病灶之外的"分散感"来源)。改成领域事件订阅者是更大的一次重构,单独立项。
- **provider / sandbox-engine 重构**:`providers/**` 保持原样。
- **RunMessageAggregator 内部**:不动其聚合逻辑。
- **入站链路**:`RunEnvelopeProcessor` / `RunExecutionStatusHandler` / `RunLifecyclePolicy` 不动。
- **跨进程协议(`packages/shared/protocol`)**:不动。

## 风险与回滚

- **最大风险在 Phase 3 的逻辑迁移**:`saveRun` 闭包的 promise 链串行化(`agent-run-handler.ts:275-305` 的注释所述终态覆盖问题)必须原样保留——迁移时整段搬,不重写。`user_steered` 中断、终态并发守卫(`finalizingRuns`/`completedRuns` 在入站侧,不受本次影响)行为不变。
- 每个 Phase 独立提交,回滚以 Phase 为单位 `git revert`。
- 验证以现有 `*.spec.ts` 为行为基线;迁移测试时只搬不改断言,任何断言需要改动都说明行为可能被破坏,应停下核对。

## Self-Review

- **覆盖**:四病灶 → Phase 2/3(病灶 3)、Phase 1/3(病灶 2)、Phase 3(病灶 1)、Phase 4(病灶 4)。全覆盖。
- **类型一致**:`AgentSpec`/`StartRunInput`/`StartRunWorkspace` 在 Phase 2 定义,Phase 3 消费,字段名一致;`AgentSpecBuilder.build` 与 `RunConfigAssembler.assemble` 签名在两处一致;`RunService` 方法名(`start`/`resumeStream`/`stop`/`resolveApproval`)全文统一。
- **无占位符**:关键迁移点均给出行号锚点与代码骨架。
