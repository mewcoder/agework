# 类型共享包（@agework/shared）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立单一共享类型包 `@agework/shared`，合并现有 `@agework/protocol`（api↔worker 协议），并新增 web↔api HTTP wire 契约层，消除前端手写类型与后端 DTO 的双份维护。

**Architecture:** 一个零构建、纯类型的 workspace 包，三个子路径导出表达边界：`.`（三端共享字面量类型）、`./protocol`（api↔worker，原 protocol 原样迁入）、`./api`（web↔api wire 契约）。api 端 DTO 通过 `implements` 对齐请求契约，service 序列化函数标注响应契约；web 端删除手写 wire 类型改为导入契约。

**Tech Stack:** pnpm workspace + Turborepo（`typecheck` 已有 `^typecheck` 拓扑）、TypeScript 源码直出（无构建步骤）、Vitest。

---

## 关键约束（实施前必读）

1. **共享包必须 100% 纯类型（只有 `type`/`interface`，无任何运行时值）。**
   原因：api 的 `nest build` 是纯 tsc 构建（`nest-cli.json` 无 webpack/swc builder），生产用 `node dist/src/main` 启动，Node 无法加载 workspace 包里的 `.ts` 运行时代码。现有 `@agework/protocol` 能工作正是因为全部导出都是 `export type`（编译后被擦除）。**禁止在共享包里放 `as const` 数组、enum、函数。**
   需要值字面量的地方（web 下拉选项、api `@IsIn(...)`），在各端本地声明并用 `satisfies` 对齐契约类型，例如：
   ```ts
   import type { ThreadStatus } from "@agework/shared/api";
   const THREAD_STATUSES = ["regular", "archived"] as const satisfies readonly ThreadStatus[];
   ```
2. **契约描述 wire format（HTTP 实际传输的形状），不描述视图模型。** 例如日期是 ISO 字符串不是 `Date`；api service 已有 `toThreadDto` 这类序列化函数做 `Date → toISOString()`，契约对齐点在序列化函数返回值上。web 端 normalize 后的视图模型（如 `Thread`）留在 web 本地。
3. **请求契约以 api 端 DTO 的真实形状为准**（如 `UpdateUserDto.status?: string` 而不是 web 侧想象的联合类型）；收紧字段类型属于行为变更，本计划不做，记入"后续工作"。
4. **提交约定：本项目不自动 commit。** 每个任务末尾的"建议提交点"仅供用户参考，由用户主动发起提交。执行 agent 不要运行 `git commit`。
5. 依赖方向：`shared` 不依赖任何 workspace 包；`adapters → shared`；`apps → packages`，禁止反向。

## 文件结构总览

```
packages/shared/                      # 新建 @agework/shared
  package.json                        # exports: "." / "./protocol" / "./api"
  tsconfig.json                       # 复制自原 protocol
  vitest.config.ts                    # 复制自原 protocol
  README.md                           # 纯类型约定 + 子路径边界说明
  src/
    common/index.ts                   # AgentType、RunStatus（三端共享）
    protocol/                         # 原 packages/protocol/src 原样迁入
      index.ts  envelope.ts  envelope.spec.ts
      transport.ts  transport.spec.ts  trace.ts
    api/
      index.ts                        # re-export 全部域
      threads.ts  projects.ts  auth.ts  users.ts
      model-configs.ts  runs.ts  system.ts

packages/protocol/                    # 删除（迁入 shared）
packages/shared-types/                # 删除（空残留，src 为空、无 package.json）
```

修改的现有文件：

- `apps/api/package.json`、`apps/worker/package.json`、`packages/adapters/package.json` — 依赖 `@agework/protocol` → `@agework/shared`
- `apps/web/package.json` — 新增依赖 `@agework/shared`
- 全仓 26 处 `from "@agework/protocol"` → `from "@agework/shared/protocol"`
- `apps/api/src/threads/`：`thread.service.ts`（本地类型换契约导入 + `toThreadDto` 返回标注）、`dto/create-thread.dto.ts`、`dto/update-thread.dto.ts`、`dto/thread-id.dto.ts`（`implements`）
- `apps/api/src/{projects,users,auth,model-configs}/dto/*.dto.ts` — `implements` 契约请求类型
- `apps/web/src/api/*.ts` — 手写 wire 类型换契约导入

---

### Task 1: 创建 packages/shared 骨架并迁移 protocol 源码

**Files:**
- Create: `packages/shared/package.json`、`packages/shared/tsconfig.json`、`packages/shared/vitest.config.ts`、`packages/shared/README.md`
- Move: `packages/protocol/src/*.ts` → `packages/shared/src/protocol/`

- [ ] **Step 1: 创建 `packages/shared/package.json`**

```json
{
  "name": "@agework/shared",
  "version": "0.0.1",
  "private": true,
  "exports": {
    ".": "./src/common/index.ts",
    "./protocol": "./src/protocol/index.ts",
    "./api": "./src/api/index.ts"
  },
  "scripts": {
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

- [ ] **Step 2: 创建 `packages/shared/tsconfig.json`**（与原 protocol 一致）

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

- [ ] **Step 3: 创建 `packages/shared/vitest.config.ts`**（与原 protocol 一致）

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

- [ ] **Step 4: 创建 `packages/shared/README.md`**

```markdown
# @agework/shared

跨 web / api / worker 的共享类型包。**纯类型、零构建、零运行时代码。**

## 子路径边界

| 入口 | 内容 | 允许的消费者 |
| --- | --- | --- |
| `@agework/shared` | 三端共享字面量类型（AgentType、RunStatus） | web / api / worker / adapters |
| `@agework/shared/protocol` | api↔worker 运行时协议（Envelope、RuntimeTransport 等） | api / worker / adapters |
| `@agework/shared/api` | web↔api HTTP wire 契约（请求/响应形状） | web / api |

## 为什么必须纯类型

api 的 `nest build` 是纯 tsc 构建，生产用 `node dist/src/main` 启动，
Node 无法加载本包的 `.ts` 运行时代码。所有导出必须是 `export type`，
编译后被完全擦除。需要值字面量时在消费侧本地声明并用
`satisfies readonly X[]` 对齐契约类型。

## 契约约定

- 描述 wire format：日期是 ISO 字符串，可省略字段用 `?:`，可为 null 用 `| null`，按 api 实际返回为准。
- 请求类型以 api 端 DTO 真实形状为准；api DTO 通过 `implements` 对齐。
- 命名：响应 `XxxResponse`，请求 `XxxRequest`。
```

- [ ] **Step 5: 迁移 protocol 源码（保留 git 历史）**

```bash
mkdir -p packages/shared/src/protocol
git mv packages/protocol/src/envelope.ts packages/protocol/src/envelope.spec.ts \
  packages/protocol/src/transport.ts packages/protocol/src/transport.spec.ts \
  packages/protocol/src/trace.ts packages/protocol/src/index.ts \
  packages/shared/src/protocol/
```

文件内容不做任何修改（`src/protocol/index.ts` 仍导出 `Envelope`、`AgentTraceEvent`、`AgentTraceSink` 以及 transport 全部类型）。

- [ ] **Step 6: 安装依赖并验证新包测试通过**

```bash
pnpm install
pnpm --filter @agework/shared test
pnpm --filter @agework/shared typecheck
```

预期：vitest 跑过 `envelope.spec.ts` 与 `transport.spec.ts`（2 个文件全部通过）；typecheck 无错误。
注意此时 `packages/protocol` 还在（package.json 未删），全仓其他包不受影响。
`exports` 中 `"."` 和 `"./api"` 指向的文件尚不存在，但没有任何消费者导入它们，不影响本步验证。

- [ ] **Step 7: 建议提交点（用户主动提交）**

建议信息：`refactor(shared): create @agework/shared and move protocol sources`

---

### Task 2: 全仓 import 切换并删除旧包

**Files:**
- Modify: `apps/api/package.json`、`apps/worker/package.json`、`packages/adapters/package.json`（依赖替换）
- Modify: 全仓 26 处 `.ts` 引用（api 20 处、worker 3 处、adapters 3 处）
- Delete: `packages/protocol/`（剩余的 package.json、tsconfig.json、vitest.config.ts）、`packages/shared-types/`

- [ ] **Step 1: 替换三个 package.json 的依赖**

`apps/api/package.json`、`apps/worker/package.json`、`packages/adapters/package.json` 中：

```diff
-    "@agework/protocol": "workspace:*",
+    "@agework/shared": "workspace:*",
```

（保持各文件内依赖字母排序。）

- [ ] **Step 2: 批量替换 import 路径**

```bash
rg -l '@agework/protocol' apps packages -g '*.ts' \
  | xargs sed -i '' 's|@agework/protocol|@agework/shared/protocol|g'
```

替换后确认无残留：

```bash
rg '@agework/protocol' apps packages docs --glob '!**/node_modules/**'
```

预期：`.ts` 文件零命中（docs 下如有命中，留给 Task 8 处理）。

- [ ] **Step 3: 删除旧包目录**

```bash
git rm -r packages/protocol
rm -rf packages/shared-types
```

注意：`packages/shared-types` 是未完成的残留（src 为空、无 package.json），可能部分未被 git 跟踪，用 `rm -rf` 兜底后再 `git status` 确认无残留。

- [ ] **Step 4: 重装依赖并全仓验证**

```bash
pnpm install
pnpm typecheck
pnpm test:api
pnpm --filter @agework/adapters test
```

预期：lockfile 更新（protocol 消失、shared 出现）；typecheck 全仓通过；api 与 adapters 测试全部通过。

- [ ] **Step 5: 烟囱验证 dev 可启动（可选但推荐）**

```bash
pnpm dev:api
```

预期：NestJS 正常启动无模块解析错误，确认后 Ctrl+C 退出（或 `pnpm kill-port 3000`）。

- [ ] **Step 6: 建议提交点（用户主动提交）**

建议信息：`refactor(shared): switch all imports to @agework/shared/protocol and remove old packages`

---

### Task 3: 下沉三端共享字面量到 src/common

**Files:**
- Create: `packages/shared/src/common/index.ts`
- Modify: `packages/shared/src/protocol/transport.ts`（AgentType/RunStatus 改为从 common 导入并 re-export，保持 protocol 公共面不变）

- [ ] **Step 1: 创建 `packages/shared/src/common/index.ts`**

```ts
/** 支持的 agent 类型。 */
export type AgentType = "claude" | "codex";

/** worker run 的生命周期状态。 */
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "requires_action"
  | "cancelling"
  | "finished"
  | "error"
  | "cancelled";
```

- [ ] **Step 2: 修改 `packages/shared/src/protocol/transport.ts`**

删除文件内的 `AgentType` 与 `RunStatus` 定义（原第 7–18 行），改为：

```ts
import type { AgentType, RunStatus } from "../common";

export type { AgentType, RunStatus };
```

（`import type { BaseEvent } from "@ag-ui/core";` 等其余内容不动；`src/protocol/index.ts` 无需改动，它已经 re-export 这两个类型，所有 `@agework/shared/protocol` 的现有导入保持兼容。）

- [ ] **Step 3: 验证**

```bash
pnpm --filter @agework/shared test
pnpm typecheck
```

预期：全部通过（`transport.spec.ts` 中 `agentType: "claude"` 等用例不受影响）。

- [ ] **Step 4: 建议提交点（用户主动提交）**

建议信息：`refactor(shared): extract AgentType/RunStatus to common entry`

---

### Task 4: 新建 web↔api 契约（src/api 全部域）

**Files:**
- Create: `packages/shared/src/api/threads.ts`、`projects.ts`、`auth.ts`、`users.ts`、`model-configs.ts`、`runs.ts`、`system.ts`、`index.ts`

本任务纯新增，不改任何消费方。契约形状的依据：响应 = api service 序列化函数实际输出（如 `thread.service.ts` 的 `toThreadDto`）；请求 = api DTO 真实形状。

- [ ] **Step 1: 创建 `packages/shared/src/api/threads.ts`**

```ts
import type { AgentType } from "../common";

export type ThreadStatus = "regular" | "archived";
export type ThreadRunStatus = "idle" | "running" | "error";
export type ThreadPendingAction = "question" | null;

/** 对应 api 端 ThreadService.toThreadDto 的输出。 */
export type ThreadResponse = {
  threadId: string;
  status: ThreadStatus;
  runStatus: ThreadRunStatus;
  pendingAction: ThreadPendingAction;
  title?: string;
  projectId: string;
  agentType: AgentType | string;
  agentResumeId?: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

export type ThreadListResponse = { threads: ThreadResponse[] };

export type StoredMessage = {
  id: string;
  parent_id: string | null;
  format: string;
  content: Record<string, unknown>;
};

export type CreateThreadRequest = {
  projectId: string;
  firstMessage?: string;
  agentType?: string;
};

export type UpdateThreadRequest = {
  threadId: string;
  title?: string;
  status?: string;
};

export type ThreadIdRequest = { threadId: string };

export type SubmitQuestionAnswerRequest = {
  answers: Record<string, string | string[]>;
};
```

（`agentType: AgentType | string`：DB 存的是 string，api 未收窄；写成这样保留语义提示又不撒谎。）

- [ ] **Step 2: 创建 `packages/shared/src/api/projects.ts`**

```ts
export type ProjectResponse = {
  id: string;
  name: string;
  workdir: string;
  workspaceStatus: string;
  gitUrl?: string | null;
  description?: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

/** /api/v1/admin/projects/all 的条目。 */
export type AdminProjectResponse = ProjectResponse & {
  userId?: string | null;
  user?: { username: string } | null;
  threadCount?: number;
};

export type CreateProjectRequest = {
  name: string;
  description?: string;
  gitUrl?: string;
};

export type UpdateProjectRequest = {
  id: string;
  name: string;
  description?: string | null;
};

export type ProjectIdRequest = { id: string };
```

- [ ] **Step 3: 创建 `packages/shared/src/api/users.ts`**

```ts
export type UserRole = "super_admin" | "admin" | "user";
export type UserStatus = "pending" | "active" | "disabled";
export type PasswordKind = "user_set" | "initial" | "temporary";

/** /api/v1/users/list 的条目（管理视角的完整形状）。 */
export type UserResponse = {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  passwordKind: PasswordKind;
  passwordExpiresAt: string | null;
  approvedAt: string | null;
  approvedById: string | null;
  lastLoginAt: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type PasswordIssueResponse = {
  user: UserResponse;
  temporaryPassword: string;
  passwordExpiresAt: string;
};

export type CreateUserRequest = {
  username: string;
  /** DTO 现状为宽松 string，收紧为 UserRole 属行为变更，见"后续工作"。 */
  role?: string;
};

export type UpdateUserRequest = {
  id: string;
  role?: string;
  status?: string;
};

export type UserIdRequest = { id: string };
```

- [ ] **Step 4: 创建 `packages/shared/src/api/auth.ts`**

```ts
import type { PasswordKind, UserRole, UserStatus } from "./users";

/** 登录态用户（auth/me、login 返回），比 UserResponse 精简。 */
export type AuthUser = {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  passwordKind?: PasswordKind;
  passwordExpiresAt?: string | null;
  sessionVersion?: number;
};

export type AuthSessionResponse = {
  token: string;
  user: AuthUser;
};

export type AuthConfigResponse = {
  authRequired: boolean;
  appName: string;
  registrationMode: "approval";
};

export type LoginRequest = { username: string; password: string };
export type RegisterRequest = { username: string; password: string };
export type ChangePasswordRequest = {
  currentPassword: string;
  newPassword: string;
};
export type CompletePasswordChangeRequest = { newPassword: string };
```

- [ ] **Step 5: 创建 `packages/shared/src/api/model-configs.ts`**

```ts
export type ModelConfigScope = "environment" | "global" | "user";

export type ModelConfigResponse = {
  modelConfigId: string;
  agentType: string;
  scope: ModelConfigScope;
  userId: string | null;
  name: string;
  isEnabled: boolean;
  /** 序列化后的配置 JSON 字符串。 */
  config: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

export type CreateModelConfigRequest = {
  agentType: string;
  name: string;
  config: Record<string, string>;
};

export type UpdateModelConfigRequest = {
  modelConfigId: string;
  name: string;
  config: Record<string, string>;
};

export type SetModelConfigEnabledRequest = {
  modelConfigId: string;
  isEnabled: boolean;
};

export type ModelConfigIdRequest = { modelConfigId: string };

export type ModelConfigTestResponse = {
  success: boolean;
  latency: number;
  error?: string;
};

export type SystemEnvVar = { name: string; isSet: boolean; preview: string };
export type SystemConfigFile = {
  path: string;
  exists: boolean;
  description: string;
};
export type ModelConfigSystemInfoResponse = {
  envVars: SystemEnvVar[];
  configFiles: SystemConfigFile[];
};
```

- [ ] **Step 6: 创建 `packages/shared/src/api/runs.ts`**

```ts
import type { RunStatus } from "../common";

/** /api/v1/admin/runs/list 的条目。 */
export type AdminRunResponse = {
  id: string;
  threadId: string;
  projectId: string;
  userId: string;
  agentType: string;
  providerType: string;
  runtimeId: string | null;
  status: RunStatus;
  phase: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
  username: string | null;
  threadTitle: string | null;
  projectName: string | null;
};

export type AdminRunListResponse = {
  total: number;
  items: AdminRunResponse[];
};

export type AdminRunListQuery = {
  status?: string;
  page?: number;
  pageSize?: number;
};
```

- [ ] **Step 7: 创建 `packages/shared/src/api/system.ts`**

```ts
import type { AgentType } from "../common";

export type AboutResponse = {
  platform: {
    name: string;
    description: string;
    version: string;
  };
  agents: {
    id: AgentType;
    name: string;
    version: string;
  }[];
};
```

- [ ] **Step 8: 创建 `packages/shared/src/api/index.ts`**

```ts
export type * from "./threads";
export type * from "./projects";
export type * from "./users";
export type * from "./auth";
export type * from "./model-configs";
export type * from "./runs";
export type * from "./system";
```

- [ ] **Step 9: 验证**

```bash
pnpm --filter @agework/shared typecheck
```

预期：通过（纯新增，不影响其他包）。

- [ ] **Step 10: 建议提交点（用户主动提交）**

建议信息：`feat(shared): add web<->api wire contracts under @agework/shared/api`

---

### Task 5: api 端 threads 域对齐契约

**Files:**
- Modify: `apps/api/src/threads/thread.service.ts:1-53`（导入与本地类型）
- Modify: `apps/api/src/threads/dto/create-thread.dto.ts`、`dto/update-thread.dto.ts`、`dto/thread-id.dto.ts`
- Test: 既有 `apps/api/src/threads/thread.service.spec.ts`、`dto/thread.dto.spec.ts`（类型级变更，跑既有测试防回归）

- [ ] **Step 1: `thread.service.ts` 本地类型替换为契约导入**

文件头部（当前第 1–9 行附近）：

```diff
 import { BadRequestException, Injectable, Logger } from "@nestjs/common";
-import type { AgentType } from "@agework/shared/protocol";
+import type { AgentType } from "@agework/shared";
+import type {
+  ThreadPendingAction,
+  ThreadResponse,
+  ThreadRunStatus,
+  ThreadStatus,
+} from "@agework/shared/api";
 import { PrismaService } from "../prisma/prisma.service";
 import { extractText } from "./message-text";
 import { swallow } from "../common/swallow";

-type ThreadStatus = "regular" | "archived";
-type ThreadRunStatus = "idle" | "running" | "error";
-type ThreadPendingAction = "question" | null;
```

并给序列化函数加返回标注（当前第 23 行）：

```diff
-  private toThreadDto(t: {
+  private toThreadDto(t: {
     id: string;
     ...
-  }) {
+  }): ThreadResponse {
```

（注意：`AgentType` 改从根入口 `@agework/shared` 导入是因为它属于三端共享字面量；从 `/protocol` 导入仍兼容，但新代码统一走根入口。）

- [ ] **Step 2: 三个 DTO `implements` 契约请求类型**

`apps/api/src/threads/dto/create-thread.dto.ts`：

```ts
import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { CreateThreadRequest } from "@agework/shared/api";

export class CreateThreadDto implements CreateThreadRequest {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsOptional()
  @IsString()
  firstMessage?: string;

  @IsOptional()
  @IsString()
  agentType?: string;
}
```

`apps/api/src/threads/dto/update-thread.dto.ts`：

```ts
import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { UpdateThreadRequest } from "@agework/shared/api";

export class UpdateThreadDto implements UpdateThreadRequest {
  @IsString()
  @IsNotEmpty()
  threadId!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
```

`apps/api/src/threads/dto/thread-id.dto.ts`：在类声明上加 `implements ThreadIdRequest` 并加对应 `import type`（字段不动，如实际字段与 `{ threadId: string }` 不符，以 DTO 为准回改契约）。

- [ ] **Step 3: 验证**

```bash
pnpm --filter api typecheck
pnpm test:api -- threads
```

预期：typecheck 通过（若 `toThreadDto` 输出与 `ThreadResponse` 不一致会在此报错——这正是契约的价值，按实际输出修正契约而非压制错误）；threads 相关测试全部通过。

- [ ] **Step 4: 建议提交点（用户主动提交）**

建议信息：`refactor(api): align threads module with @agework/shared/api contracts`

---

### Task 6: web 端 threads 域切换到契约

**Files:**
- Modify: `apps/web/package.json`（新增依赖）
- Modify: `apps/web/src/api/threads.ts`

- [ ] **Step 1: web 加依赖**

`apps/web/package.json` 的 `dependencies` 中加入（保持字母排序）：

```json
"@agework/shared": "workspace:*",
```

然后 `pnpm install`。

- [ ] **Step 2: `apps/web/src/api/threads.ts` 删除手写 wire 类型**

```ts
import { apiGet, apiPost } from '@/lib/http';
import type {
  CreateThreadRequest,
  StoredMessage,
  SubmitQuestionAnswerRequest,
  ThreadListResponse,
  ThreadPendingAction,
  ThreadResponse,
  ThreadRunStatus,
  ThreadStatus,
} from '@agework/shared/api';

export type Thread = {
  threadId: string;
  status: ThreadStatus;
  runStatus: ThreadRunStatus;
  pendingAction: ThreadPendingAction;
  title?: string;
  projectId: string;
  agentType?: string;
  agentResumeId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreatedThread = Thread;
export type { StoredMessage };

function normalizeThread(raw: ThreadResponse): Thread {
  return {
    threadId: raw.threadId,
    status: raw.status,
    runStatus: raw.runStatus,
    pendingAction: raw.pendingAction === 'question' ? 'question' : null,
    title: raw.title ?? undefined,
    projectId: raw.projectId,
    agentType: raw.agentType ?? undefined,
    agentResumeId: raw.agentResumeId ?? undefined,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
```

要点：删除本地 `ThreadResponse` 与 `StoredMessage` 定义；`normalizeThread` 里原来的 `raw.status as Thread['status']` 强转不再需要（契约已是联合类型）；`threadsApi` 各方法签名改用契约类型：

```ts
export const threadsApi = {
  list: async (after?: string, status?: ThreadStatus, sort?: 'updatedAt' | 'createdAt') => {
    const params = new URLSearchParams();
    if (after) params.set('after', after);
    if (status) params.set('status', status);
    if (sort) params.set('sort', sort);
    const qs = params.toString();
    const { threads } = await apiGet<ThreadListResponse>(qs ? `/api/v1/threads/list?${qs}` : '/api/v1/threads/list');
    return { threads: threads.map(normalizeThread) };
  },

  create: async (body: CreateThreadRequest) => {
    const thread = await apiPost<ThreadResponse>('/api/v1/threads/create', body);
    return normalizeThread(thread);
  },

  get: (threadId: string) =>
    apiGet<ThreadResponse>(`/api/v1/threads/get?threadId=${threadId}`).then(normalizeThread),

  // rename / archive / unarchive / delete / stopRun 保持不变

  submitQuestionAnswer: (threadId: string, answers: SubmitQuestionAnswerRequest['answers']) =>
    apiPost(`/api/v1/agent/threads/${threadId}/question-answer`, { answers }),

  listMessages: (threadId: string) =>
    apiGet<StoredMessage[]>(`/api/v1/threads/messages?threadId=${threadId}`),
};
```

- [ ] **Step 3: 验证**

```bash
pnpm --filter web typecheck
pnpm test:web
```

预期：typecheck 通过（`thread-list-adapter.ts` 等导入 `type Thread` 的地方不受影响）；web 测试全部通过。

- [ ] **Step 4: 建议提交点（用户主动提交）**

建议信息：`refactor(web): use @agework/shared/api contracts in threads api client`

---

### Task 7: api 端其余域 DTO 对齐

**Files:**
- Modify: `apps/api/src/projects/dto/create-project.dto.ts`、`update-project.dto.ts`、`project-id.dto.ts`
- Modify: `apps/api/src/users/dto/create-user.dto.ts`、`update-user.dto.ts`、`user-id.dto.ts`
- Modify: `apps/api/src/auth/dto/login.dto.ts`、`register.dto.ts`、`change-password.dto.ts`、`complete-password-change.dto.ts`
- Modify: `apps/api/src/model-configs/dto/create-model-config.dto.ts`、`update-model-config.dto.ts`、`set-model-config-enabled.dto.ts`、`model-config-id.dto.ts`

- [ ] **Step 1: 每个 DTO 加 `implements` + `import type`**

模式统一（以 projects 为例，其余同构）：

```diff
 import { IsNotEmpty, IsOptional, IsString } from "class-validator";
+import type { CreateProjectRequest } from "@agework/shared/api";

-export class CreateProjectDto {
+export class CreateProjectDto implements CreateProjectRequest {
```

对应关系：

| DTO | 契约类型 |
| --- | --- |
| `CreateProjectDto` | `CreateProjectRequest` |
| `UpdateProjectDto` | `UpdateProjectRequest` |
| `ProjectIdDto` | `ProjectIdRequest` |
| `CreateUserDto` | `CreateUserRequest` |
| `UpdateUserDto` | `UpdateUserRequest` |
| `UserIdDto` | `UserIdRequest` |
| `LoginDto` | `LoginRequest` |
| `RegisterDto` | `RegisterRequest` |
| `ChangePasswordDto` | `ChangePasswordRequest` |
| `CompletePasswordChangeDto` | `CompletePasswordChangeRequest` |
| `CreateModelConfigDto` | `CreateModelConfigRequest` |
| `UpdateModelConfigDto` | `UpdateModelConfigRequest` |
| `SetModelConfigEnabledDto` | `SetModelConfigEnabledRequest` |
| `ModelConfigIdDto` | `ModelConfigIdRequest` |

若某 DTO 实际字段与 Task 4 写的契约不符（计划基于已读源码，但 `project-id.dto.ts`、`user-id.dto.ts`、`set-model-config-enabled.dto.ts`、`change-password.dto.ts`、`complete-password-change.dto.ts` 未逐一核对），**以 DTO 为准修改契约**——契约描述现实，不在本计划里改行为。

- [ ] **Step 2: 验证**

```bash
pnpm --filter api typecheck
pnpm test:api
```

预期：全部通过。

- [ ] **Step 3: 建议提交点（用户主动提交）**

建议信息：`refactor(api): align remaining DTOs with shared contracts`

---

### Task 8: web 端其余域切换到契约

**Files:**
- Modify: `apps/web/src/api/projects.ts`、`users.ts`、`auth.ts`、`model-configs.ts`、`runs.ts`、`system.ts`
- Modify: `apps/web/src/stores/auth-store.ts`（`AuthUser` 改为 re-export 契约类型）

原则：web 文件里已被组件广泛引用的类型名（`Project`、`User`、`ModelConfig` 等）保留为契约类型的别名，组件零改动。

- [ ] **Step 1: `apps/web/src/api/projects.ts`**

删除本地 `Project`、`ProjectWithUser`、`CreateProjectInput`、`UpdateProjectInput` 定义，改为：

```ts
import type {
  AdminProjectResponse,
  CreateProjectRequest,
  ProjectResponse,
  UpdateProjectRequest,
} from '@agework/shared/api';

export type Project = ProjectResponse;
export type ProjectWithUser = AdminProjectResponse;
export type CreateProjectInput = CreateProjectRequest;
export type UpdateProjectInput = Omit<UpdateProjectRequest, 'id'>;
```

注意：原 `UpdateProjectInput` 不含 `id`（`rename` 调用时另传），所以用 `Omit`；`projectsApi` 各方法体不动。

- [ ] **Step 2: `apps/web/src/api/users.ts`**

删除本地 `User`、`PasswordIssueResult` 定义，改为：

```ts
import type { PasswordIssueResponse, UserResponse } from '@agework/shared/api';

export type User = UserResponse;
export type PasswordIssueResult = PasswordIssueResponse;
```

`usersApi.update` 的参数 `data: { role?: string; status?: 'active' | 'disabled' }` 保持不变（比 wire 契约更窄是允许的：调用方约束可以严于协议）。

- [ ] **Step 3: `apps/web/src/stores/auth-store.ts` 与 `apps/web/src/api/auth.ts`**

`auth-store.ts`：删除本地 `AuthUser` interface（当前第 4–13 行），改为：

```ts
import type { AuthUser } from '@agework/shared/api';

export type { AuthUser };
```

（store 其余代码引用 `AuthUser` 的地方不变；`auth.ts` 里 `import type { AuthUser } from '@/stores/auth-store'` 也继续有效。）

`auth.ts`：响应泛型换契约类型：

```ts
import type { AuthConfigResponse, AuthSessionResponse, AuthUser } from '@agework/shared/api';

export const authApi = {
  login: (username: string, password: string) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/login', { username, password }),

  register: (username: string, password: string) =>
    apiPost<AuthUser>('/api/v1/auth/register', { username, password }),

  me: () => apiGet<AuthUser>('/api/v1/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/change-password', { currentPassword, newPassword }),

  completePasswordChange: (newPassword: string) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/complete-password-change', { newPassword }),

  config: () => apiGet<AuthConfigResponse>('/api/v1/auth/config'),
};
```

- [ ] **Step 4: `apps/web/src/api/model-configs.ts`**

删除本地 `ModelConfig`、`TestResult`、`SystemEnvVar`、`SystemConfigFile`、`SystemInfo`、`ModelConfigResponse` 定义与 `normalizeModelConfig`（恒等函数，纯噪音），改为：

```ts
import type {
  ModelConfigResponse,
  ModelConfigSystemInfoResponse,
  ModelConfigTestResponse,
  SystemConfigFile,
  SystemEnvVar,
} from '@agework/shared/api';

export type ModelConfig = ModelConfigResponse;
export type ModelConfigValues = Record<string, string>;
export type TestResult = ModelConfigTestResponse;
export type SystemInfo = ModelConfigSystemInfoResponse;
export type { SystemConfigFile, SystemEnvVar };
```

`modelConfigsApi` 各方法去掉 `.then(normalizeModelConfig)` / `.then(map(normalize…))`，直接 `apiGet<ModelConfigResponse[]>` / `apiPost<ModelConfigResponse>`。

- [ ] **Step 5: `apps/web/src/api/runs.ts`**

删除本地 `RunStatus`、`AdminRun`、`AdminRunListResult` 定义，改为：

```ts
import type { RunStatus } from '@agework/shared';
import type { AdminRunListQuery, AdminRunListResponse, AdminRunResponse } from '@agework/shared/api';

export type { RunStatus };
export type AdminRun = AdminRunResponse;
export type AdminRunListResult = AdminRunListResponse;
```

`runsApi.adminList` 参数类型改为 `AdminRunListQuery`，方法体不动。

- [ ] **Step 6: `apps/web/src/api/system.ts`**

删除本地 `AboutInfo`，改为：

```ts
import type { AboutResponse } from '@agework/shared/api';

export type AboutInfo = AboutResponse;
```

- [ ] **Step 7: 验证**

```bash
pnpm --filter web typecheck
pnpm test:web
pnpm typecheck
```

预期：全部通过。若组件处出现类型错误，说明契约与组件假设不一致——先核对 api 实际返回，按现实修契约或组件，不要用 `as` 压制。

- [ ] **Step 8: 建议提交点（用户主动提交）**

建议信息：`refactor(web): switch remaining api clients to shared contracts`

---

### Task 9: 文档同步与全量验证

**Files:**
- Modify: 命中 `@agework/protocol` / `packages/protocol` 的文档（执行时用 grep 确定）

- [ ] **Step 1: 找出过期引用并更新**

```bash
rg -l '@agework/protocol|packages/protocol|packages/shared-types' \
  ARCHITECTURE.md CLAUDE.md AGENTS.md README.md docs --glob '!docs/superpowers/plans/*'
```

对命中文件把包名/路径更新为 `@agework/shared`（`docs/superpowers/plans|specs` 下的历史计划/设计文档是历史记录，不改）。若 `ARCHITECTURE.md` 有 packages 结构图，补充 `shared` 的三个子路径职责（可直接引用 `packages/shared/README.md` 的表格）。

- [ ] **Step 2: 全量验证**

```bash
pnpm typecheck
pnpm build
pnpm test:api
pnpm test:web
```

预期：全部通过。`pnpm build` 必须验证——它能暴露 nest tsc 构建对 shared 包的解析问题（关键约束 1）。

- [ ] **Step 3: 烟囱测试（推荐）**

```bash
pnpm dev
```

预期：前后端启动正常；浏览器里登录、查看 thread 列表、创建 thread 无异常后停止服务。

- [ ] **Step 4: 建议提交点（用户主动提交）**

建议信息：`docs: update references after @agework/shared consolidation`

---

## 后续工作（本计划不做，记录备查）

1. **收紧宽松字段**：`UpdateUserDto.role/status`、`UpdateThreadDto.status`、`CreateThreadDto.agentType` 等目前是 `string`，可用 `@IsIn([...] as const satisfies readonly X[])` 收紧为契约联合类型（行为变更，需单独评估并补测试）。
2. **响应侧全面标注**：除 threads 外，其余 service 序列化函数也标注契约返回类型（需逐个核对 service 实际输出，threads 的做法可复制）。
3. **运行时校验升级（可选）**：若将来希望契约带运行时校验，可把某个域的契约升级为 zod schema（`z.infer` 出类型，api 用 nestjs-zod）——前提是给 shared 加构建步骤（关键约束 1），按域渐进迁移。
