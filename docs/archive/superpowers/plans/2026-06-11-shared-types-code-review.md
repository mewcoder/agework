# @agework/shared 类型共享重构 — Code Review 发现

> 审查范围：`apps/api/`、`apps/worker/`、`packages/shared/`、`packages/adapters/` 的 uncommitted diff
> 审查日期：2026-06-11

---

## P1 — 本轮应修复

### 1. `AgentType | string` 退化为 `string`，类型收窄失效

**文件：** `packages/shared/src/api/threads.ts:15`

**问题：** `ThreadResponse.agentType` 声明为 `AgentType | string`，而 `AgentType = "claude" | "codex"` 是 `string` 的子类型，TypeScript 会将联合类型简化为 `string`。这意味着消费者无法通过类型收窄区分 agent 类型——`if (thread.agentType === "claude")` 中 `agentType` 被推断为 `string` 而非 `"claude"`。

**根因：** DB 中 `agentType` 存的是 `string`，api service 的 `toThreadDto` 不做收窄，契约如实描述了这个现状。但契约应该是「理想类型」的锚点，不应将运行时不收窄编码为类型妥协。

**修复建议：**
- 短期：在 `ThreadResponse` 中改为 `agentType: AgentType`，在 `toThreadDto` 中加 `as AgentType`（已知 `resolveAgentType` 在创建时已校验过合法值，运行时不会出现非法 agentType）
- 长期：让 Prisma schema / service 层直接产出 `AgentType` 类型，消除 `as`

### 2. `AgentType`/`RunStatus` 双路径导入不一致

**文件：** `packages/shared/src/protocol/transport.ts:2-3`

**问题：** `AgentType` 和 `RunStatus` 定义在 `common/index.ts`（即 `@agework/shared` 根入口），`transport.ts` 又 import + re-export 了它们，使 `@agework/shared/protocol` 也导出同样的类型。当前消费者分为两派：
- `thread.service.ts` → 从 `@agework/shared` 导入
- 其余 24 个文件 → 从 `@agework/shared/protocol` 导入

如果将来 `transport.ts` 的 re-export 被删除（"这些类型不属于 protocol"），24 个文件编译报错，而 `thread.service.ts` 静默通过——split-brain。

**修复建议：** 统一导入路径。两种选择：
- **A（推荐）：** 所有消费者统一从 `@agework/shared` 导入 `AgentType`/`RunStatus`，`protocol/transport.ts` 保留 re-export 但仅作兼容桥接
- **B：** 所有消费者统一从 `@agework/shared/protocol` 导入（保持旧习惯），根入口 `@agework/shared` 不再导出这两个类型

选择 A 更语义清晰（`AgentType`/`RunStatus` 是三端共享字面量，不是协议专属）。

### 3. `chat-store.ts` 本地重复定义 `AgentType`

**文件：** `apps/web/src/stores/chat-store.ts:3`

**问题：** 本地 `type AgentType = 'claude' | 'codex'` 与 `@agework/shared` 的定义是两份独立维护的拷贝。`AgentType` 新增变体时此文件及其 13 个消费者不感知。

**修复：** 删除本地定义，改为 `import type { AgentType } from '@agework/shared'`。

---

## P2 — 后续改进

### 4. `normalizeRole`/`normalizeStatus` 使用硬编码字面量

**文件：** `apps/api/src/auth/user-credentials.ts:84-97`

**问题：** `normalizeRole()` 检查 `"super_admin" || "admin" || "user"`，`normalizeStatus()` 检查 `"pending" || "active" || "disabled"`——这些字面量与 `@agework/shared/api` 的 `UserRole`/`UserStatus` 完全一致但独立维护。共享类型新增值时，验证函数不会报编译错误，继续在运行时拒绝合法值。

**修复建议：** 将字面量数组提取为 `as const` 常量，用 `satisfies readonly UserRole[]` 对齐共享类型：

```ts
import type { UserRole, UserStatus } from "@agework/shared/api";

const VALID_ROLES = ["super_admin", "admin", "user"] as const satisfies readonly UserRole[];
const VALID_STATUSES = ["pending", "active", "disabled"] as const satisfies readonly UserStatus[];

function normalizeRole(role: string): UserRole {
  if ((VALID_ROLES as readonly string[]).includes(role)) return role as UserRole;
  return "user";
}
```

### 5. `ThreadPendingAction` 与 `RunStatusPayload.pendingAction` 独立定义同一概念

**文件：** `packages/shared/src/api/threads.ts:5`、`packages/shared/src/protocol/transport.ts:14`

**问题：** 两处都定义为 `"question" | null`，语义上代表同一个领域概念（线程/Run 等待人工操作）。如果新增 pending action 类型（如 `"approval"`），只更新一处会导致前端 thread 视图或 worker 协议端静默丢失新值。

**修复建议：** 将 `PendingAction = "question" | null` 定义在 `common/index.ts`，两处引用：

```ts
// packages/shared/src/common/index.ts
export type PendingAction = "question" | null;

// packages/shared/src/api/threads.ts
import type { PendingAction } from "../common";
export type ThreadPendingAction = PendingAction;

// packages/shared/src/protocol/transport.ts
import type { PendingAction } from "../common";
// RunStatusPayload.pendingAction?: PendingAction;
```

---

## P2 — 后续改进

### 6. `@ag-ui/core` 错放 runtime dependency

**文件：** `packages/shared/package.json:15`

**问题：** `@ag-ui/core` 列在 `dependencies` 中，但整个包对它的唯一引用是 `import type { BaseEvent }`（编译期擦除）。应移到 `devDependencies` 以避免不必要的传递安装。当前不影响正确性和运行时，仅增加 ~6MB 安装量。

---

## 已驳回的发现

| # | 发现 | 驳回原因 |
|---|------|---------|
| register 返回 AuthUser 而非 AuthSessionResponse | 后端 `auth.service.ts` 的 register 方法返回的是 `toUserDto(user)`，不含 token，前端类型正确 |
| runs.ts `if (params.page)` falsy-zero bug | 分页是 1-indexed，后端 clamp 到 `Math.max(page, 1)`，`page: 0` 不是合法输入 |
