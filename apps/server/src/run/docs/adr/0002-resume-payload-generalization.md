# ADR-0002: HITL resume 契约泛化为 provider 无关 payload,并接受 cancelled

日期:2026-07-12
状态:已采纳(待实施)

## 背景

问答走 terminal interrupt model(见 [ADR-0001](0001-question-interrupt-terminal-model.md)):答复作为新 run 的 `resume[]` 传入。线上 `AgUiResumeEntry = { interruptId, status:"resolved"|"cancelled", payload? }` 本就 provider 无关、payload 不透明。

但 server 侧把它**窄化成了 Claude 问答形状**:
- `extractResumeAnswers`(`run.service.ts`)只读 `resume[0]`、**只认 `status:"resolved"`**、把 payload 硬解成 `{ answers: Record<string,string|string[]> }`。
- `approval_resolved` 命令写死 `{ answers, resumeRunId }`。

Codex app-server 迁移(见 adapters codex ADR-0001)引入命令/文件/权限审批,答复要的是 `decision` 枚举(`accept/acceptForSession/decline/cancel/...`)或权限的 `{permissions,scope}`,并需要 **decline/cancel 语义**——现状 `extractResumeAnswers` 会直接拒 `cancelled`。同时 Claude 的权限拒绝这条路今天也没建。

## 决策

**泛化现有 provider 无关路径,不新开 Codex 专用命令:**
1. `extractResumeAnswers` 从"只输出 `answers`、只认 `resolved`"改为**透传不透明 `payload`,并接受 `status:"cancelled"`**(映射为 decline/cancel)。
2. `approval_resolved` 命令 payload 从 `{answers,resumeRunId}` 泛化为 `{payload,resumeRunId}`(payload 不透明;Claude 问答仍放 `{answers}`,Codex 放 `{decision}` 或 `{permissions,scope}`)。
3. 由各 provider 的 adapter 自解 payload;Claude 权限拒绝顺带解锁。
4. 保持**单槽**:`resume[0]` / 按 threadId resolve 不变(Codex 并发审批在 adapter 侧 per-thread 队列串行,见 codex 迁移文档 §11.5)。

`pendingUserAction` 保持 `"question" | null` 不动——它是"有待处理 HITL"的粗粒度存在标志,不是种类判别;具体种类/选项由消息上的 `AgUiInterrupt`(reason/responseSchema/metadata)承担。

## 取舍

- 选泛化而非"另开 Codex 专用命令 + 独立 pending 表",因为线上契约本就 provider 无关,窄化只在 server 两处;泛化一次同时解锁 Claude 权限拒绝,避免第二套 HITL 契约与 AG-UI resume 语义分叉("别重造第二套 outcome")。
- 代价:动到现有 Claude 走的 `extractResumeAnswers`/`approval_resolved`,需回归 Claude 问答不破。

## 关联

- Codex 迁移:`docs/agework-codex-app-server-migration.md`(§11、Ticket 05)、`packages/adapters/src/codex/docs/adr/0001-codex-app-server-first-class-backend.md`。
