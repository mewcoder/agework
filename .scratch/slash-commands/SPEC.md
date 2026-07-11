# 聊天框 `/` 命令（工作空间 skill）

Status: draft
范围: **只做 Claude；skill 不经过 agent 发现；Codex 暂缓**

## 1. 目标

用户在聊天框输入 `/` 时，弹出当前可用的 skill 列表，可键盘导航、补全，选中后当普通消息发出，由 agent SDK 自己执行。

硬要求：**run 之前就要拿到命令清单**——用户新建工作空间、选好 agent、打开聊天框、还没发任何消息时打 `/` 就要能看到命令。

非目标：
- 前端本地执行的动作命令（`/clear`、`/new`、`/model` 切换等）——明确不做。
- 全局 skill（平台提供）——本期不做，后续再加。
- `.claude/commands/` 扫描——跟 Codex 一起放 P3。
- Codex 的命令——本期暂缓（见 §5）。

## 2. 为什么不由 agent 上报

Claude Agent SDK `@anthropic-ai/claude-agent-sdk@0.3.158` 获取 skill 的唯一途径是 `Query.supportedCommands()`，但该方法只挂在活跃 `Query` 对象上，而 `Query` 只在 `query()` 启动后存在（会 spawn CLI 子进程）。SDK 没有独立的 `listSkills()` 函数。

`system:init` 事件也只在 run 启动后才推过来。

`/` 命令的使用时序是「发消息之前」，事件 / SDK 上报方案在时序上根本对不上。

## 3. 数据来源

Skill 来源是工作空间本地文件扫描，**不经过 agent**。

### 3.1 工作空间本地 skill（扫描文件）

扫描工作空间 `runtimePath` 下的 `.{agentDirPrefix}/skills/*/SKILL.md`，解析 frontmatter。

- 目录前缀按 agentType 区分：`AGENT_DIR_PREFIX` 加到 `packages/shared`，跟 `AGENT_LABELS` 并列：
  ```ts
  export const AGENT_DIR_PREFIX: Record<AgentType, string> = {
    claude: ".claude",
    codex: ".codex",
  };
  ```
  路径拼接：`join(AGENT_DIR_PREFIX[agentType], "skills")`，`skills` 段固定，前缀按 agent 区分。
- 新建的工作空间没有 skill，用户后续可自己加。
- 通过已有的 `RuntimeService.listFiles / readFile` 跨 runtime 读取（managed native 直读、docker/registered 走 RPC 隧道），不需要新通道。

### 3.2 frontmatter 解析

SKILL.md 的 frontmatter 是标准 YAML `---` 分隔块，用 `gray-matter` 解析（后端新增依赖），配合 zod 校验。

提取字段：
- `name`（必填，缺失则跳过该 skill）
- `description`（可选，缺失则 `undefined`）

忽略字段：
- `disable-model-invocation`——给 agent 看的，跟 `/` 菜单无关
- `argument-hint`——本期不要

frontmatter key 用 kebab-case（如 `argument-hint`），不兼容 camelCase。

### 3.3 错误处理

- runtime 不可达（registered 离线等）：返回空数组（200），不阻断用户输入。
- 子目录没有 `SKILL.md`、frontmatter 缺 `name`、YAML 格式损坏：跳过该 skill，log warning，不影响其他 skill 返回。

### 3.4 缓存策略

后端不缓存。前端 TanStack Query 设 `staleTime: 60_000`，切走再切回来不重复请求，主动 refresh 可刷新。

## 4. 实现清单（自顶向下逐环）

| # | 环 | 文件 | 动作 |
|---|---|---|---|
| 1 | 共享类型 | `packages/shared` | 加 `SlashCommandItem { name: string; description?: string }` + `AGENT_DIR_PREFIX` |
| 2 | 后端接口 | `apps/server/src/agent/agent.controller.ts` + `agent.service.ts` | 新增 `GET /api/v1/agent/skills?workspaceId=xxx&agentType=claude`，扫描工作空间 skill 目录，返回 `SlashCommandItem[]` |
| 3 | 前端拉取 | 新 `apps/web/src/hooks/use-agent-skills.ts` + `apps/web/src/api/agents.ts` | TanStack Query，`staleTime: 60_000`，跟 `useAgentOptions` 同构 |
| 4 | composer 集成 | `apps/web/src/components/assistant-ui/thread-composer.tsx` | 用 assistant-ui `ComposerTriggerPopover` + `unstable_useSlashCommandAdapter`，见下 |

### 环 2 · 后端接口细节

```
GET /api/v1/agent/skills?workspaceId=xxx&agentType=claude
```

放在 `AgentController` + `AgentService`，跟 `GET /agent/options` 并列。`AgentService` 已注入 `WorkspaceService` 和 `RuntimeService`。

`AgentService.getSkills(userId, workspaceId, agentType)`：
1. `agentType !== "claude"` 时返回空数组（本期）。
2. `WorkspaceService.resolveFileContext(userId, workspaceId)` 拿到 `{ runtimeId, workspaceRootPath }`。
3. `RuntimeService.listFiles(runtimeId, workspaceRootPath, "{AGENT_DIR_PREFIX[agentType]}/skills")` 列子目录。
4. 对每个子目录 `RuntimeService.readFile(runtimeId, workspaceRootPath, "{prefix}/skills/<name>/SKILL.md")` 读内容。
5. `gray-matter` 解析 frontmatter，zod 校验 `name` 必填。
6. 解析失败的 skill 跳过并 log warning。
7. 返回 `SlashCommandItem[]`。
8. 任何步骤异常（runtime 不可达等）catch 后返回空数组。

### 环 3 · 前端拉取细节

跟 `useAgentOptions` 完全同构：

```ts
// use-agent-skills.ts
export function useAgentSkills(workspaceId?: string, agentType?: AgentType) {
  return useQuery({
    queryKey: ["agents", "skills", workspaceId, agentType],
    queryFn: () => agentsApi.skills(workspaceId!, agentType!),
    enabled: !!workspaceId && !!agentType,
    staleTime: 60_000,
  });
}
```

### 环 4 · composer 集成细节

用 assistant-ui 自带的 [ComposerTriggerPopover](https://www.assistant-ui.com/docs/ui/composer-trigger-popover) + `unstable_useSlashCommandAdapter`，不需要自己写菜单组件和键盘导航。

项目已安装 `@assistant-ui/react@0.14.23`，组件已包含：
- `/` 触发检测、浮层 UI、键盘导航（↑↓ Enter/Tab Esc）。
- 两种行为模式：`directive`（插入 chip）或 `action`（执行回调）。

我们用 **`action` behavior**：

1. 引入组件：`pnpm dlx shadcn@latest add https://r.assistant-ui.com/composer-trigger-popover.json -c apps/web`
2. 在 composer 外层包 `ComposerPrimitive.Unstable_TriggerPopoverRoot`。
3. 用 `unstable_useSlashCommandAdapter({ commands })` 把 `SlashCommandItem[]` 映射为 `Unstable_SlashCommand[]`：
   - `id` ← `name`
   - `description` ← `description`
   - `execute` ← `aui.composer().setText("/" + name + " ")`（带尾部空格）
4. `ComposerTriggerPopover` 用 `char="/"` + `action={{ onExecute, removeOnExecute: true }}`。
5. 发送：走原路，`/cmd` 由 SDK 自执行。

## 5. Codex 为何暂缓

- 现用 `@openai/codex-sdk@0.135.0`：`SlashCommand` 导出数 = 0，无 `listSkills`、无 `available_commands`。
- Codex 的 skill 发现走 ACP + codex app-server 协议，与本期方案（文件扫描）不冲突，但 Codex 的 SKILL.md 放置位置和 frontmatter 约定需单独验证。
- 本期 Codex 会话下 `/` 菜单暂为空。

## 6. 分期

- **P1**：环 4，前端用 mock 命令表跑通 `ComposerTriggerPopover` + `action` behavior。
- **P2**：环 1+2+3，后端接口 + 前端 TanStack Query，替 mock，闭环。
- **P3（暂缓）**：全局 skill + Codex skill 扫描 + `.claude/commands/` 扫描。
