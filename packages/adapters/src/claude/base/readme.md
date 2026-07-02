# ag-ui-claude-agent-sdk 本地修改说明

> 本目录是从 `@ag-ui/claude-agent-sdk` 源码复制到本地的，用于在需要时直接修改 adapter 行为。
>
> 参考源码位置：`reference-source-code/@ag-ui-claude-agent-sdk/`

## 为什么复制到本地

原包通过 npm 安装，修改后需要重新发布才能使用。将源码复制到 `apps/server/src/libs/` 后：

- 可以直接修改 adapter 源码
- 无需等待上游发布新版本
- 修改后立即生效（NestJS 热重载）

## 使用方式

在 [claude-agent.adapter.ts](../../agent/adapters/claude/claude-agent.adapter.ts) 中，import 从原包名改为本地路径：

```typescript
// 修改前（使用 npm 包）
import { ClaudeAgentAdapter as AgUiClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";

// 修改后（使用本地源码）
import { ClaudeAgentAdapter as AgUiClaudeAgentAdapter } from "../../../libs/ag-ui-claude-agent-sdk";
```

## 已做的修改

### 1. 修复并行 tool use 时 TOOL_CALL_END 缺失（核心修复）

**问题**：Claude Agent SDK 的 agentic loop 在一次 turn 中可能发出多个 `content_block_start`（并行 tool use），但只给最后一个发送 `content_block_stop`，导致前面的 tool call 只有 `TOOL_CALL_START` 没有对应的 `TOOL_CALL_END`，前端事件流处于挂起状态。

**修改文件**：[adapter.ts](adapter.ts)

**修改内容**：

- 新增 `activeToolCallIds` Map，跟踪所有已发出 `TOOL_CALL_START` 但尚未收到 `content_block_stop` 的 tool call
- 在 `content_block_start` 时将 tool call 加入 `activeToolCallIds`
- 在 `content_block_stop` 时从 `activeToolCallIds` 移除已关闭的 tool call
- 在 `finally` 清理块中，遍历 `activeToolCallIds` 为所有未关闭的 tool call 补发 `TOOL_CALL_END`

**关键代码**（[adapter.ts:420](adapter.ts#L420)）：

```typescript
// 新增：跟踪所有活跃的 tool call
const activeToolCallIds = new Map<string, { name: string; displayName: string; json: string }>();

// content_block_start 时加入跟踪
activeToolCallIds.set(currentToolCallId, {
  name: currentToolCallName,
  displayName: currentToolDisplayName,
  json: "",
});

// content_block_stop 时移除跟踪
activeToolCallIds.delete(currentToolCallId);

// finally 块中补发所有未关闭的 TOOL_CALL_END
for (const [toolCallId] of activeToolCallIds) {
  subscriber.next({
    type: EventType.TOOL_CALL_END,
    threadId,
    runId,
    toolCallId,
  });
}
```

### 2. 新增单元测试

**新增文件**：[adapter.spec.ts](adapter.spec.ts)

测试覆盖以下场景：

- **4 个并行 tool use 只有 1 个 content_block_stop**：验证所有 4 个 tool call 都有 START/END 配对（3 个通过 finally 清理补发）
- **每个 tool call 都有正常生命周期**：验证正常情况下的 START/END 配对
- **单个挂起的 tool call**：验证 finally 清理补发 END
- **多个挂起的 tool call**：验证 finally 清理为所有未关闭的 tool call 补发 END

**新增文件**：[adapter.headers.test.ts](adapter.headers.test.ts)

测试 `headers` 属性的行为（原包中已存在 `headers` 声明，这里是补充测试）。

## 未修改的文件

以下文件与参考源码完全一致，无需关注：

- [config.ts](config.ts) — 配置常量
- [handlers.ts](handlers.ts) — ToolUseBlock 处理
- [types.ts](types.ts) — 类型定义
- [utils.ts](utils.ts) — 工具函数
- [index.ts](index.ts) — 入口导出

## 后续维护

如果上游 `@ag-ui/claude-agent-sdk` 发布了新版本：

1. 对比 `reference-source-code/@ag-ui-claude-agent-sdk/src/adapter.ts` 与新版本差异
2. 将本目录的修改（`activeToolCallIds` 相关逻辑）合并到新版本
3. 更新 `reference-source-code/` 中的源码快照
