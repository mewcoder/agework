# Agent 运行基础设施 · 阶段 1：抽取 packages/protocol 与 packages/adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/api/src/libs/ag-ui-{claude,codex}-agent-sdk`（基础 adapter）和 `apps/api/src/agent/adapters/{claude,codex}`（业务 adapter）整体抽到新的 pnpm workspace 包 `packages/adapters`，并新建 `packages/protocol` 承载本轮设计中定义的 `Envelope` / `RuntimeTransport` / `RunConfig` / `Control` / `AGUIEvent` / `AgentTraceSink` 等共享类型。`apps/api` 改为通过 `@agework/protocol`、`@agework/adapters` 引用这些代码，**行为完全不变**（`pnpm typecheck`、`pnpm test:api`、`pnpm build` 全绿）。

本计划对应 `docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design.md` 第 11 节「分阶段落地」的**阶段 1**。阶段 2（Run/Workspace 模型）、阶段 3（apps/worker + LocalProcessProvider）将在本阶段完成并验证后另行制定计划。

**Architecture:**
- 新增两个 pnpm workspace 包：`packages/protocol`（纯类型，依赖 `@ag-ui/core`）、`packages/adapters`（Claude/Codex adapter 实现，依赖 `@agework/protocol`）。
- 两个包都用 `tsc -b`（project references）预构建到 `dist/` + `.d.ts`，`package.json` 通过 `exports` 字段指向 `dist`；`apps/api` 以 `workspace:*` 依赖它们。`turbo.json` 的 `build`/`typecheck` 任务依赖 `^build`，保证 packages 先于 `apps/api` 构建。
- `packages/adapters/src` 内部按 `claude/base`、`claude/business`、`codex/base`、`codex/business` 组织，分别对应原 `libs/ag-ui-claude-agent-sdk`、`agent/adapters/claude`、`libs/ag-ui-codex-agent-sdk`、`agent/adapters/codex`，目录内部相对 import 不变，只调整跨目录/跨包的 import。
- `AgentTraceEvent`/`AgentTraceSink` 类型原来在 `apps/api/src/agent/agent-trace-logger.ts` 和 `libs/ag-ui-codex-agent-sdk/types.ts` 重复定义，本轮统一收敛到 `packages/protocol`，两处改为 re-export，消除重复。
- 这是一次**纯抽取/移动重构**：大部分任务的「测试」是「移动后运行既有测试确认仍然通过」，而不是经典的 TDD 红绿循环；只有 `packages/protocol` 的全新类型采用先写类型使用断言（spec）再写类型定义的红绿流程。
- **提交约定**：根据项目记忆，本仓库的 git commit 由用户主动发起，AI 不自动提交。每个任务最后一步只做 `git add` 暂存并给出建议的 commit message，不执行 `git commit`。

**Tech Stack:** pnpm workspace, Turborepo (`^build` 拓扑), TypeScript 5.7 (`tsc -b`，project references), Vitest 4 (+ `unplugin-swc`), NestJS 11, `@ag-ui/client` `@ag-ui/core`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `zod`, `rxjs`。

---

## 文件结构总览

```
packages/
  protocol/
    package.json
    tsconfig.json
    vitest.config.ts
    src/
      envelope.ts
      envelope.spec.ts
      trace.ts
      transport.ts
      transport.spec.ts
      index.ts
  adapters/
    package.json
    tsconfig.json
    vitest.config.ts
    src/
      index.ts
      claude/
        base/            ← 原 apps/api/src/libs/ag-ui-claude-agent-sdk/*
          index.ts
          adapter.ts
          types.ts
          config.ts
          utils.ts
          handlers.ts
          adapter.spec.ts
          adapter.headers.test.ts
          readme.md
        business/         ← 原 apps/api/src/agent/adapters/claude/*
          claude-agent.adapter.ts
          safe-env.ts
      codex/
        base/             ← 原 apps/api/src/libs/ag-ui-codex-agent-sdk/*
          index.ts
          adapter.ts
          types.ts
          config.ts
          utils.ts
        business/          ← 原 apps/api/src/agent/adapters/codex/*
          codex-agent.adapter.ts
          codex-run-logger.ts
          codex-agent.adapter.spec.ts
          codex-run-logger.spec.ts

apps/api/
  src/agent/
    agent-trace-logger.ts   (修改：AgentTraceEvent/AgentTraceSink 改为 re-export @agework/protocol)
    agent.service.ts        (修改：import 改为 @agework/adapters)
    agent.controller.ts      (修改：import 改为 @agework/adapters)
  package.json               (新增 @agework/protocol、@agework/adapters 依赖)

# 删除：
apps/api/src/libs/ag-ui-claude-agent-sdk/
apps/api/src/libs/ag-ui-codex-agent-sdk/
apps/api/src/agent/adapters/

# 修改：
pnpm-workspace.yaml   (加入 packages/*)
turbo.json            (typecheck 任务 dependsOn 加入 ^build)
```

---

## Task 1: Workspace 脚手架（pnpm-workspace.yaml、turbo.json、两个空包骨架）

**Files:**
- Modify: `/Users/mew/code/agework-dev/pnpm-workspace.yaml`
- Modify: `/Users/mew/code/agework-dev/turbo.json`
- Create: `/Users/mew/code/agework-dev/packages/protocol/package.json`
- Create: `/Users/mew/code/agework-dev/packages/protocol/tsconfig.json`
- Create: `/Users/mew/code/agework-dev/packages/protocol/vitest.config.ts`
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/index.ts`
- Create: `/Users/mew/code/agework-dev/packages/adapters/package.json`
- Create: `/Users/mew/code/agework-dev/packages/adapters/tsconfig.json`
- Create: `/Users/mew/code/agework-dev/packages/adapters/vitest.config.ts`
- Create: `/Users/mew/code/agework-dev/packages/adapters/src/index.ts`

- [ ] **Step 1: 把 `packages/*` 加入 pnpm workspace**

修改 `/Users/mew/code/agework-dev/pnpm-workspace.yaml`，把：

```yaml
packages:
  - "apps/*"
```

改为：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

其余 `allowBuilds` 等内容不变。

- [ ] **Step 2: 让 `typecheck` 任务依赖 packages 的 build 产物**

修改 `/Users/mew/code/agework-dev/turbo.json`，把 `typecheck` 任务的 `dependsOn` 从：

```json
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "outputs": []
    },
```

改为：

```json
    "typecheck": {
      "dependsOn": ["^build", "^typecheck"],
      "outputs": []
    },
```

原因：`apps/api` 的 `tsc --noEmit` 通过 `@agework/protocol`/`@agework/adapters` 的 `package.json#types` 解析到 `dist/index.d.ts`，必须先把这两个包 build 出来。

- [ ] **Step 3: 创建 `packages/protocol` 包骨架**

创建 `/Users/mew/code/agework-dev/packages/protocol/package.json`：

```json
{
  "name": "@agework/protocol",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ag-ui/core": "^0.0.54"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.7.3",
    "vitest": "^4.1.8"
  }
}
```

创建 `/Users/mew/code/agework-dev/packages/protocol/tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "composite": true,
    "target": "ES2023",
    "types": ["node", "vitest/globals"],
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts", "dist", "node_modules"]
}
```

创建 `/Users/mew/code/agework-dev/packages/protocol/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
```

创建占位 `/Users/mew/code/agework-dev/packages/protocol/src/index.ts`（后续任务会填充内容，这里先放一个空导出，保证 `tsc -b` 有输入文件）：

```ts
export {};
```

- [ ] **Step 4: 创建 `packages/adapters` 包骨架**

创建 `/Users/mew/code/agework-dev/packages/adapters/package.json`：

```json
{
  "name": "@agework/adapters",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@agework/protocol": "workspace:*",
    "@ag-ui/client": "0.0.53",
    "@ag-ui/core": "^0.0.54",
    "@anthropic-ai/claude-agent-sdk": "^0.3.158",
    "@anthropic-ai/sdk": "^0.102.0",
    "@nestjs/common": "^11.0.1",
    "@openai/codex-sdk": "^0.135.0",
    "rxjs": "7.8.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@swc/core": "^1.15.40",
    "@types/node": "^24.0.0",
    "typescript": "^5.7.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.8"
  }
}
```

创建 `/Users/mew/code/agework-dev/packages/adapters/tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "composite": true,
    "target": "ES2023",
    "types": ["node", "vitest/globals"],
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": true
  },
  "references": [{ "path": "../protocol" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts", "src/**/*.test.ts", "dist", "node_modules"]
}
```

创建 `/Users/mew/code/agework-dev/packages/adapters/vitest.config.ts`（与 `apps/api/vitest.config.ts` 保持一致的 swc 配置，因为后续移入的代码来自 `apps/api`）：

```ts
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { decoratorMetadata: true },
        target: "es2023",
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
```

创建占位 `/Users/mew/code/agework-dev/packages/adapters/src/index.ts`：

```ts
export {};
```

- [ ] **Step 5: 安装依赖，验证 workspace 识别新包**

```bash
pnpm install
```

Expected: 安装成功，输出中能看到 `packages/protocol`、`packages/adapters` 被识别为 workspace 包（无报错）。

```bash
pnpm --filter @agework/protocol typecheck
pnpm --filter @agework/adapters typecheck
```

Expected: 两条命令均成功退出（`tsc --noEmit` 对占位 `export {}` 文件直接通过）。

- [ ] **Step 6: 暂存**

```bash
git add pnpm-workspace.yaml turbo.json packages/protocol packages/adapters
```

建议 commit message（由用户执行）：`chore: scaffold @agework/protocol and @agework/adapters packages`

---

## Task 2: packages/protocol — Envelope 类型

**Files:**
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/envelope.spec.ts`
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/envelope.ts`
- Modify: `/Users/mew/code/agework-dev/packages/protocol/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `/Users/mew/code/agework-dev/packages/protocol/src/envelope.spec.ts`：

```ts
import type { Envelope } from "./envelope";

describe("Envelope", () => {
  it("carries runId, monotonic seq, type, payload and ts", () => {
    const envelope: Envelope<{ foo: string }> = {
      runId: "run-1",
      seq: 1,
      type: "agui.event",
      payload: { foo: "bar" },
      ts: new Date().toISOString(),
    };

    expect(envelope.runId).toBe("run-1");
    expect(envelope.seq).toBe(1);
    expect(envelope.payload.foo).toBe("bar");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter @agework/protocol exec vitest run src/envelope.spec.ts
```

Expected: FAIL，提示找不到模块 `./envelope`（`envelope.ts` 还不存在）。

- [ ] **Step 3: 实现 Envelope 类型**

创建 `/Users/mew/code/agework-dev/packages/protocol/src/envelope.ts`：

```ts
/**
 * Unified message envelope used by RuntimeTransport (Ipc/Http).
 * `seq` is monotonically increasing per `runId` and is the basis for
 * at-least-once delivery + idempotent dedup (key = `runId:seq`).
 */
export interface Envelope<T = unknown> {
  runId: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
pnpm --filter @agework/protocol exec vitest run src/envelope.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 在 index.ts 导出 Envelope**

把 `/Users/mew/code/agework-dev/packages/protocol/src/index.ts` 的内容从：

```ts
export {};
```

改为：

```ts
export type { Envelope } from "./envelope";
```

- [ ] **Step 6: 暂存**

```bash
git add packages/protocol/src/envelope.ts packages/protocol/src/envelope.spec.ts packages/protocol/src/index.ts
```

建议 commit message：`feat(protocol): add Envelope type`

---

## Task 3: packages/protocol — AgentTrace、RuntimeTransport / RunConfig / Control / AGUIEvent

**Files:**
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/trace.ts`
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/transport.spec.ts`
- Create: `/Users/mew/code/agework-dev/packages/protocol/src/transport.ts`
- Modify: `/Users/mew/code/agework-dev/packages/protocol/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `/Users/mew/code/agework-dev/packages/protocol/src/transport.spec.ts`：

```ts
import type { Envelope } from "./envelope";
import type {
  RunConfig,
  RuntimeTransport,
  ControlPayload,
  UpstreamMessage,
} from "./transport";

describe("RuntimeTransport contract", () => {
  it("RunConfig carries runtimePath and env for the worker", () => {
    const config: RunConfig = {
      runId: "run-1",
      threadId: "thread-1",
      agentType: "claude",
      runtimePath: "/tmp/workspace",
      env: { FOO: "bar" },
      input: { foo: "bar" },
    };

    expect(config.runtimePath).toBe("/tmp/workspace");
    expect(config.env.FOO).toBe("bar");
  });

  it("a RuntimeTransport implementation can fetch config, emit upstream messages and subscribe controls", async () => {
    const sent: UpstreamMessage[] = [];
    let controlHandler: ((c: Envelope<ControlPayload>) => void) | undefined;

    const transport: RuntimeTransport = {
      fetchRunConfig: () =>
        Promise.resolve({
          runId: "run-1",
          threadId: "thread-1",
          agentType: "claude",
          runtimePath: "/tmp/workspace",
          env: {},
          input: {},
        }),
      emit: (msg) => {
        sent.push(msg);
        return Promise.resolve();
      },
      subscribeControls: (cb) => {
        controlHandler = cb;
        return () => {
          controlHandler = undefined;
        };
      },
      close: () => Promise.resolve(),
    };

    const config = await transport.fetchRunConfig();
    expect(config.runId).toBe("run-1");

    await transport.emit({
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "running" },
      ts: new Date().toISOString(),
    });
    expect(sent).toHaveLength(1);

    const unsubscribe = transport.subscribeControls(() => {});
    expect(controlHandler).toBeTypeOf("function");
    unsubscribe();
    expect(controlHandler).toBeUndefined();

    await transport.close();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm --filter @agework/protocol exec vitest run src/transport.spec.ts
```

Expected: FAIL，提示找不到模块 `./transport`。

- [ ] **Step 3: 新增 AgentTrace 类型**

创建 `/Users/mew/code/agework-dev/packages/protocol/src/trace.ts`（从 `apps/api/src/agent/agent-trace-logger.ts` 与 `apps/api/src/libs/ag-ui-codex-agent-sdk/types.ts` 中重复定义的同名类型收敛而来）：

```ts
export type AgentTraceEvent = {
  name: string;
  payload?: unknown;
};

export type AgentTraceSink = (event: AgentTraceEvent) => void;
```

- [ ] **Step 4: 实现 RuntimeTransport / RunConfig / Control / AGUIEvent**

创建 `/Users/mew/code/agework-dev/packages/protocol/src/transport.ts`：

```ts
import type { BaseEvent } from "@ag-ui/core";
import type { Envelope } from "./envelope";

/** AG-UI 事件，作为 `agui.event` 消息的 payload。 */
export type AGUIEvent = BaseEvent;

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "finished"
  | "error";

export type RunStatusPayload = {
  status: RunStatus;
  phase?: string;
  error?: string;
};

export type HeartbeatPayload = {
  at: string;
};

export type ArtifactRefPayload = {
  artifactId: string;
  kind: string;
  uri: string;
};

/**
 * worker 启动时通过 `fetchRunConfig()` 拉取的运行配置。
 * `runtimePath` 由 RuntimeProvider.prepareRun 解析得到（直接用 / mount），
 * worker 不关心它是本机真实路径还是容器内 `/workspace`。
 */
export type RunConfig = {
  runId: string;
  threadId: string;
  agentType: string;
  runtimePath: string;
  env: Record<string, string>;
  /** 传给 Agent Adapter 的原始 run input（如 AG-UI RunAgentInput）。 */
  input: unknown;
};

/** 控制面 → worker 的下行控制消息。 */
export type ControlPayload =
  | { type: "cancel" }
  | { type: "interrupt" }
  | {
      type: "approval";
      threadId: string;
      answers: Record<string, string | string[]>;
    }
  | { type: "user_message"; message: string };

/** worker → 控制面的上行消息集合（`run.status` / `agui.event` / `heartbeat` / `artifact.ref`）。 */
export type UpstreamMessage =
  | Envelope<RunStatusPayload>
  | Envelope<AGUIEvent>
  | Envelope<HeartbeatPayload>
  | Envelope<ArtifactRefPayload>;

export type Unsubscribe = () => void;

/**
 * worker 主体唯一依赖的通信接口。`IpcTransport`（本轮，process.send/on('message')）
 * 与 `HttpTransport`（下一轮，POST /events + 轮询 /controls）都实现此接口，
 * 对 worker 和 Agent Adapter 透明。
 */
export interface RuntimeTransport {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamMessage): Promise<void>;
  subscribeControls(cb: (control: Envelope<ControlPayload>) => void): Unsubscribe;
  close(): Promise<void>;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm --filter @agework/protocol exec vitest run src/transport.spec.ts
```

Expected: PASS。

- [ ] **Step 6: 在 index.ts 导出新增类型**

把 `/Users/mew/code/agework-dev/packages/protocol/src/index.ts` 改为：

```ts
export type { Envelope } from "./envelope";
export type { AgentTraceEvent, AgentTraceSink } from "./trace";
export type {
  AGUIEvent,
  RunStatus,
  RunStatusPayload,
  HeartbeatPayload,
  ArtifactRefPayload,
  RunConfig,
  ControlPayload,
  UpstreamMessage,
  Unsubscribe,
  RuntimeTransport,
} from "./transport";
```

- [ ] **Step 7: 跑全部 protocol 测试 + build**

```bash
pnpm --filter @agework/protocol exec vitest run
pnpm --filter @agework/protocol build
```

Expected: 测试全部 PASS；`build` 成功生成 `packages/protocol/dist/index.js`、`packages/protocol/dist/index.d.ts` 等文件。

- [ ] **Step 8: 暂存**

```bash
git add packages/protocol/src
```

建议 commit message：`feat(protocol): add RuntimeTransport contract types and shared AgentTrace types`

---

## Task 4: 迁移 Claude 基础 Adapter（`libs/ag-ui-claude-agent-sdk` → `packages/adapters/src/claude/base`）

**Files:**
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/index.ts` → `packages/adapters/src/claude/base/index.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.ts` → `packages/adapters/src/claude/base/adapter.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/types.ts` → `packages/adapters/src/claude/base/types.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/config.ts` → `packages/adapters/src/claude/base/config.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/utils.ts` → `packages/adapters/src/claude/base/utils.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/handlers.ts` → `packages/adapters/src/claude/base/handlers.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.spec.ts` → `packages/adapters/src/claude/base/adapter.spec.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.headers.test.ts` → `packages/adapters/src/claude/base/adapter.headers.test.ts`
- Move: `apps/api/src/libs/ag-ui-claude-agent-sdk/readme.md` → `packages/adapters/src/claude/base/readme.md`

这一组文件内部互相之间只用同目录相对 import（`./adapter`、`./types`、`./config`、`./utils`、`./handlers`），整体平移目录后这些 import 不需要改动。

- [ ] **Step 1: 创建目标目录并整体移动文件**

```bash
mkdir -p packages/adapters/src/claude/base
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/index.ts packages/adapters/src/claude/base/index.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.ts packages/adapters/src/claude/base/adapter.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/types.ts packages/adapters/src/claude/base/types.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/config.ts packages/adapters/src/claude/base/config.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/utils.ts packages/adapters/src/claude/base/utils.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/handlers.ts packages/adapters/src/claude/base/handlers.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.spec.ts packages/adapters/src/claude/base/adapter.spec.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/adapter.headers.test.ts packages/adapters/src/claude/base/adapter.headers.test.ts
git mv apps/api/src/libs/ag-ui-claude-agent-sdk/readme.md packages/adapters/src/claude/base/readme.md
```

- [ ] **Step 2: 运行迁移后的测试**

```bash
pnpm --filter @agework/adapters exec vitest run src/claude/base/adapter.spec.ts
```

Expected: PASS（与迁移前在 `apps/api` 中跑的结果一致；`adapter.headers.test.ts` 文件名不匹配 `*.spec.ts`，不会被执行，这与迁移前行为一致）。

- [ ] **Step 3: 暂存**

```bash
git add -A packages/adapters/src/claude/base apps/api/src/libs/ag-ui-claude-agent-sdk
```

建议 commit message：`refactor(adapters): move ag-ui-claude-agent-sdk into packages/adapters/src/claude/base`

---

## Task 5: 迁移 Codex 基础 Adapter（`libs/ag-ui-codex-agent-sdk` → `packages/adapters/src/codex/base`），收敛 AgentTrace 类型

**Files:**
- Move: `apps/api/src/libs/ag-ui-codex-agent-sdk/index.ts` → `packages/adapters/src/codex/base/index.ts`
- Move: `apps/api/src/libs/ag-ui-codex-agent-sdk/adapter.ts` → `packages/adapters/src/codex/base/adapter.ts`
- Move: `apps/api/src/libs/ag-ui-codex-agent-sdk/types.ts` → `packages/adapters/src/codex/base/types.ts`
- Move: `apps/api/src/libs/ag-ui-codex-agent-sdk/config.ts` → `packages/adapters/src/codex/base/config.ts`
- Move: `apps/api/src/libs/ag-ui-codex-agent-sdk/utils.ts` → `packages/adapters/src/codex/base/utils.ts`
- Modify: `packages/adapters/src/codex/base/types.ts` (移除重复的 `AgentTraceEvent`/`AgentTraceSink` 定义，改为从 `@agework/protocol` 引入)

- [ ] **Step 1: 创建目标目录并整体移动文件**

```bash
mkdir -p packages/adapters/src/codex/base
git mv apps/api/src/libs/ag-ui-codex-agent-sdk/index.ts packages/adapters/src/codex/base/index.ts
git mv apps/api/src/libs/ag-ui-codex-agent-sdk/adapter.ts packages/adapters/src/codex/base/adapter.ts
git mv apps/api/src/libs/ag-ui-codex-agent-sdk/types.ts packages/adapters/src/codex/base/types.ts
git mv apps/api/src/libs/ag-ui-codex-agent-sdk/config.ts packages/adapters/src/codex/base/config.ts
git mv apps/api/src/libs/ag-ui-codex-agent-sdk/utils.ts packages/adapters/src/codex/base/utils.ts
```

- [ ] **Step 2: 收敛 AgentTraceEvent / AgentTraceSink 到 @agework/protocol**

在 `/Users/mew/code/agework-dev/packages/adapters/src/codex/base/types.ts` 中，找到：

```ts
export type AgentTraceEvent = {
  name: string;
  payload?: unknown;
};

export type AgentTraceSink = (event: AgentTraceEvent) => void;
```

删除这两个定义，改为在文件顶部的 import 区域新增：

```ts
import type { AgentTraceEvent, AgentTraceSink } from "@agework/protocol";

export type { AgentTraceEvent, AgentTraceSink };
```

文件中其余对 `AgentTraceSink`（如 `CodexAgentAdapterConfig.trace?: AgentTraceSink`）的引用不变。

- [ ] **Step 3: 运行 typecheck 确认类型解析正确**

```bash
pnpm --filter @agework/protocol build
pnpm --filter @agework/adapters typecheck
```

Expected: 两条命令均成功（`@agework/adapters` 的 `tsconfig.json` 已通过 `references` 指向 `../protocol`，`tsc --noEmit` 能解析到 `@agework/protocol` 的 `dist/index.d.ts`）。

- [ ] **Step 4: 暂存**

```bash
git add -A packages/adapters/src/codex/base apps/api/src/libs/ag-ui-codex-agent-sdk
```

建议 commit message：`refactor(adapters): move ag-ui-codex-agent-sdk into packages/adapters/src/codex/base and dedupe AgentTrace types via @agework/protocol`

---

## Task 6: 迁移 Claude 业务 Adapter（`agent/adapters/claude` → `packages/adapters/src/claude/business`）

**Files:**
- Move: `apps/api/src/agent/adapters/claude/claude-agent.adapter.ts` → `packages/adapters/src/claude/business/claude-agent.adapter.ts`
- Move: `apps/api/src/agent/adapters/claude/safe-env.ts` → `packages/adapters/src/claude/business/safe-env.ts`
- Modify: `packages/adapters/src/claude/business/claude-agent.adapter.ts` (更新 import 路径)

- [ ] **Step 1: 创建目标目录并移动文件**

```bash
mkdir -p packages/adapters/src/claude/business
git mv apps/api/src/agent/adapters/claude/claude-agent.adapter.ts packages/adapters/src/claude/business/claude-agent.adapter.ts
git mv apps/api/src/agent/adapters/claude/safe-env.ts packages/adapters/src/claude/business/safe-env.ts
```

- [ ] **Step 2: 更新 import 路径**

在 `/Users/mew/code/agework-dev/packages/adapters/src/claude/business/claude-agent.adapter.ts` 顶部，把：

```ts
import { ClaudeAgentAdapter as AgUiClaudeAgentAdapter } from "../../../libs/ag-ui-claude-agent-sdk";
import type { AgentTraceSink } from "../../agent-trace-logger";
import { pickSafeEnv } from "./safe-env";
```

改为：

```ts
import { ClaudeAgentAdapter as AgUiClaudeAgentAdapter } from "../base";
import type { AgentTraceSink } from "@agework/protocol";
import { pickSafeEnv } from "./safe-env";
```

`./safe-env` 相对路径不变（同目录）。文件中其余代码不变。

- [ ] **Step 3: 运行 typecheck**

```bash
pnpm --filter @agework/adapters typecheck
```

Expected: 成功（`../base` 解析到 `packages/adapters/src/claude/base/index.ts`，导出了 `ClaudeAgentAdapter`、`ClaudeAgentAdapterConfig`、`ProcessedEvent`、`ALLOWED_FORWARDED_PROPS`、`STATE_MANAGEMENT_TOOL_NAME`、`AG_UI_MCP_SERVER_NAME`、`extractToolNames`，足够覆盖 `claude-agent.adapter.ts` 的引用）。

- [ ] **Step 4: 暂存**

```bash
git add -A packages/adapters/src/claude/business apps/api/src/agent/adapters/claude
```

建议 commit message：`refactor(adapters): move agent/adapters/claude into packages/adapters/src/claude/business`

---

## Task 7: 迁移 Codex 业务 Adapter（`agent/adapters/codex` → `packages/adapters/src/codex/business`）

**Files:**
- Move: `apps/api/src/agent/adapters/codex/codex-agent.adapter.ts` → `packages/adapters/src/codex/business/codex-agent.adapter.ts`
- Move: `apps/api/src/agent/adapters/codex/codex-run-logger.ts` → `packages/adapters/src/codex/business/codex-run-logger.ts`
- Move: `apps/api/src/agent/adapters/codex/codex-agent.adapter.spec.ts` → `packages/adapters/src/codex/business/codex-agent.adapter.spec.ts`
- Move: `apps/api/src/agent/adapters/codex/codex-run-logger.spec.ts` → `packages/adapters/src/codex/business/codex-run-logger.spec.ts`
- Modify: `packages/adapters/src/codex/business/codex-agent.adapter.ts` (更新 import 路径)

- [ ] **Step 1: 创建目标目录并移动文件**

```bash
mkdir -p packages/adapters/src/codex/business
git mv apps/api/src/agent/adapters/codex/codex-agent.adapter.ts packages/adapters/src/codex/business/codex-agent.adapter.ts
git mv apps/api/src/agent/adapters/codex/codex-run-logger.ts packages/adapters/src/codex/business/codex-run-logger.ts
git mv apps/api/src/agent/adapters/codex/codex-agent.adapter.spec.ts packages/adapters/src/codex/business/codex-agent.adapter.spec.ts
git mv apps/api/src/agent/adapters/codex/codex-run-logger.spec.ts packages/adapters/src/codex/business/codex-run-logger.spec.ts
```

`codex-agent.adapter.spec.ts` 和 `codex-run-logger.spec.ts` 都只 import 同目录文件（`./codex-agent.adapter`、`./codex-run-logger`），无需修改。

- [ ] **Step 2: 更新 import 路径**

在 `/Users/mew/code/agework-dev/packages/adapters/src/codex/business/codex-agent.adapter.ts` 顶部，把：

```ts
import { CodexAgentAdapter as AgUiCodexAgentAdapter } from "../../../libs/ag-ui-codex-agent-sdk";
import type { AgentTraceSink } from "../../agent-trace-logger";
```

改为：

```ts
import { CodexAgentAdapter as AgUiCodexAgentAdapter } from "../base";
import type { AgentTraceSink } from "@agework/protocol";
```

文件中其余代码不变。

- [ ] **Step 3: 运行迁移后的测试 + typecheck**

```bash
pnpm --filter @agework/adapters exec vitest run src/codex/business
pnpm --filter @agework/adapters typecheck
```

Expected: 两个 spec 文件全部 PASS；typecheck 成功。

- [ ] **Step 4: 暂存**

```bash
git add -A packages/adapters/src/codex/business apps/api/src/agent/adapters/codex
```

建议 commit message：`refactor(adapters): move agent/adapters/codex into packages/adapters/src/codex/business`

---

## Task 8: packages/adapters 入口导出 + 整体构建

**Files:**
- Modify: `/Users/mew/code/agework-dev/packages/adapters/src/index.ts`

- [ ] **Step 1: 编写 barrel export**

把 `/Users/mew/code/agework-dev/packages/adapters/src/index.ts` 的内容从：

```ts
export {};
```

改为：

```ts
export {
  ClaudeAgentAdapter,
  resolveQuestion,
  cancelQuestion,
  type ClaudeAdapterConfig,
  type AgentPendingAction,
  type AgentPendingActionSink,
} from "./claude/business/claude-agent.adapter";

export {
  CodexAgentAdapter,
  type CodexAdapterConfig,
} from "./codex/business/codex-agent.adapter";
```

- [ ] **Step 2: 跑全部 adapters 测试**

```bash
pnpm --filter @agework/adapters exec vitest run
```

Expected: 全部 PASS（包含 Task 4/5/7 移动进来的 spec：`claude/base/adapter.spec.ts`、`codex/business/codex-agent.adapter.spec.ts`、`codex/business/codex-run-logger.spec.ts`）。

- [ ] **Step 3: 构建包**

```bash
pnpm --filter @agework/protocol build
pnpm --filter @agework/adapters build
```

Expected: 成功生成 `packages/adapters/dist/index.js`、`packages/adapters/dist/index.d.ts` 等文件，且 `index.d.ts` 中能看到 `ClaudeAgentAdapter`、`CodexAgentAdapter`、`resolveQuestion`、`cancelQuestion` 等导出的类型声明。

- [ ] **Step 4: 暂存**

```bash
git add packages/adapters/src/index.ts
```

建议 commit message：`feat(adapters): export ClaudeAgentAdapter/CodexAgentAdapter and HITL helpers from @agework/adapters`

---

## Task 9: apps/api — agent-trace-logger.ts 改用 @agework/protocol 的 AgentTrace 类型

**Files:**
- Modify: `/Users/mew/code/agework-dev/apps/api/src/agent/agent-trace-logger.ts:1-21`
- Modify: `/Users/mew/code/agework-dev/apps/api/package.json`

- [ ] **Step 1: 添加 workspace 依赖**

在 `/Users/mew/code/agework-dev/apps/api/package.json` 的 `dependencies` 中新增（按字母序插入到 `@ai-sdk/openai` 之前）：

```json
    "@agework/adapters": "workspace:*",
    "@agework/protocol": "workspace:*",
```

- [ ] **Step 2: 安装依赖，链接 workspace 包**

```bash
pnpm install
```

Expected: 成功，`apps/api/node_modules/@agework/protocol`、`apps/api/node_modules/@agework/adapters` 出现为指向 `packages/protocol`、`packages/adapters` 的 symlink。

- [ ] **Step 3: 修改 agent-trace-logger.ts 的类型定义**

在 `/Users/mew/code/agework-dev/apps/api/src/agent/agent-trace-logger.ts` 中，把第 1-21 行：

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { Injectable, Logger } from "@nestjs/common";

export type AgentTraceEvent = {
  name: string;
  payload?: unknown;
};

export type AgentTraceMeta = {
  agentType?: string;
  appThreadId?: string;
  threadId?: string;
  runId?: string;
  agentSessionId?: string;
  userId?: string;
  projectWorkdir?: string;
};

export type AgentTraceSink = (event: AgentTraceEvent) => void;
```

改为：

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { Injectable, Logger } from "@nestjs/common";
import type { AgentTraceEvent, AgentTraceSink } from "@agework/protocol";

export type { AgentTraceEvent, AgentTraceSink };

export type AgentTraceMeta = {
  agentType?: string;
  appThreadId?: string;
  threadId?: string;
  runId?: string;
  agentSessionId?: string;
  userId?: string;
  projectWorkdir?: string;
};
```

文件其余部分（`AgentTraceLogger`、`AgentTraceRun` 等）不变 —— 它们使用的 `AgentTraceEvent`/`AgentTraceSink` 现在来自 import，类型结构与之前完全相同。

- [ ] **Step 4: 跑 agent-trace-logger 的测试**

```bash
pnpm --filter @agework/protocol build
pnpm --filter @agework/adapters build
pnpm --filter api exec vitest run src/agent/agent-trace-logger.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 暂存**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/agent/agent-trace-logger.ts
```

建议 commit message：`refactor(api): depend on @agework/protocol and @agework/adapters; reuse shared AgentTrace types`

---

## Task 10: apps/api — agent.service.ts / agent.controller.ts 改用 @agework/adapters

**Files:**
- Modify: `/Users/mew/code/agework-dev/apps/api/src/agent/agent.service.ts:1-8`
- Modify: `/Users/mew/code/agework-dev/apps/api/src/agent/agent.controller.ts:11`

- [ ] **Step 1: 更新 agent.service.ts 的 import**

在 `/Users/mew/code/agework-dev/apps/api/src/agent/agent.service.ts` 中，把第 1-8 行：

```ts
import { Injectable, BadRequestException } from "@nestjs/common";
import type { AgentTraceSink } from "./agent-trace-logger";
import { PrismaService } from "../prisma/prisma.service";
import {
  ClaudeAgentAdapter,
  type AgentPendingActionSink,
} from "./adapters/claude/claude-agent.adapter";
import { CodexAgentAdapter } from "./adapters/codex/codex-agent.adapter";
```

改为：

```ts
import { Injectable, BadRequestException } from "@nestjs/common";
import type { AgentTraceSink } from "./agent-trace-logger";
import { PrismaService } from "../prisma/prisma.service";
import {
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  type AgentPendingActionSink,
} from "@agework/adapters";
```

文件其余部分（`AGENT_ADAPTER_STRATEGIES`、`AgentService` 等）不变。

- [ ] **Step 2: 更新 agent.controller.ts 的 import**

在 `/Users/mew/code/agework-dev/apps/api/src/agent/agent.controller.ts` 第 11 行，把：

```ts
import { resolveQuestion, cancelQuestion } from "./adapters/claude/claude-agent.adapter";
```

改为：

```ts
import { resolveQuestion, cancelQuestion } from "@agework/adapters";
```

- [ ] **Step 3: 跑 typecheck 与全部 api 测试**

```bash
pnpm --filter api typecheck
pnpm test:api
```

Expected: typecheck 成功；`pnpm test:api` 全部测试通过（与本计划开始前的基线一致）。

- [ ] **Step 4: 暂存**

```bash
git add apps/api/src/agent/agent.service.ts apps/api/src/agent/agent.controller.ts
```

建议 commit message：`refactor(api): import ClaudeAgentAdapter/CodexAgentAdapter and HITL helpers from @agework/adapters`

---

## Task 11: 清理旧目录 + 全量验证

**Files:**
- Delete: `/Users/mew/code/agework-dev/apps/api/src/libs/` (整个目录，迁移后应已为空)
- Delete: `/Users/mew/code/agework-dev/apps/api/src/agent/adapters/` (整个目录，迁移后应已为空)

- [ ] **Step 1: 确认旧目录已清空**

```bash
find apps/api/src/libs apps/api/src/agent/adapters -type f
```

Expected: 无输出（两个目录下已没有任何文件 —— Task 4/5/6/7 的 `git mv` 已经把所有文件移走）。

- [ ] **Step 2: 删除空目录**

```bash
rmdir apps/api/src/libs/ag-ui-claude-agent-sdk apps/api/src/libs/ag-ui-codex-agent-sdk apps/api/src/libs
rmdir apps/api/src/agent/adapters/claude apps/api/src/agent/adapters/codex apps/api/src/agent/adapters
```

- [ ] **Step 3: 全量构建**

```bash
pnpm build
```

Expected: `turbo build` 按 `^build` 拓扑依次构建 `@agework/protocol` → `@agework/adapters` → `api`/`web`，全部成功。

- [ ] **Step 4: 全量 typecheck**

```bash
pnpm typecheck
```

Expected: 全部包 typecheck 通过。

- [ ] **Step 5: 全量测试**

```bash
pnpm test:api
```

Expected: 全部通过，测试数量与列表与迁移前一致（只是部分用例现在位于 `packages/adapters` 和 `packages/protocol` 下，由各自的 `pnpm --filter <pkg> test` 单独覆盖；`pnpm test:api` 仅覆盖 `apps/api` 自身剩余的测试）。

- [ ] **Step 6: 跑一次 packages 的测试确认没有遗漏**

```bash
pnpm --filter @agework/protocol test
pnpm --filter @agework/adapters test
```

Expected: 全部通过。

- [ ] **Step 7: 本地验证开发模式可用**

```bash
pnpm dev
```

Expected: `apps/api` 正常启动（监听 `PORT`，默认 3000），日志中没有因找不到 `@agework/protocol`/`@agework/adapters` 导致的模块解析报错。手动验证后按 Ctrl+C 停止。

- [ ] **Step 8: 暂存**

```bash
git add -A apps/api/src/libs apps/api/src/agent/adapters
```

建议 commit message：`chore: remove apps/api/src/libs and apps/api/src/agent/adapters after extraction to packages`

---

## Self-Review 记录

- **Spec 覆盖**：本计划覆盖设计文档第 11 节阶段 1 的全部内容——`packages/protocol`（Envelope、RuntimeTransport 接口、RunConfig、Control、AGUIEvent 类型，Task 2-3）与 `packages/adapters`（迁移 Claude/Codex 的 base + business adapter，Task 4-8），`apps/api` 改为引用这两个包且行为不变（Task 9-11）。
- **占位符扫描**：未发现 "TBD"/"实现细节后补" 等占位符；所有迁移任务均给出精确的 `git mv` 命令与 import diff。
- **类型一致性**：`AgentTraceEvent`/`AgentTraceSink` 在 `packages/protocol/src/trace.ts` 中定义一次，`packages/adapters/src/codex/base/types.ts` 与 `apps/api/src/agent/agent-trace-logger.ts` 均改为从 `@agework/protocol` re-export，三处类型结构保持一致；`packages/adapters/src/index.ts` 导出的 `ClaudeAgentAdapter`/`CodexAgentAdapter`/`ClaudeAdapterConfig`/`CodexAdapterConfig`/`AgentPendingAction(Sink)`/`resolveQuestion`/`cancelQuestion` 与 `apps/api` 中 `agent.service.ts`/`agent.controller.ts` 实际引用的符号一一对应。
- **构建拓扑**：`turbo.json` 的 `build`/`typecheck` 均依赖 `^build`，配合 `tsc -b` + `package.json#exports` 保证 `apps/api` 能解析到 `@agework/protocol`、`@agework/adapters` 的 `dist`。

---

## 后续

阶段 1 完成并验证通过后，将基于本计划产出的 `packages/protocol`、`packages/adapters`，为设计文档第 11 节的**阶段 2**（Prisma 新增 `Run`/`Workspace`、`AgentController` 编排改走 Run 生命周期）和**阶段 3**（`apps/worker` + `LocalProcessProvider`/`IpcTransport`）分别制定新的实现计划。
