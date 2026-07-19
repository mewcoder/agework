# Working Document: Server 与 Runtime 的隔离及复用边界

## 当前已验证链路

1. 用户创建 Workspace 时选择 `runtimeType + scope + runtimeHostId`；`scope` 是 `user | workspace`，产品文案分别表达“同用户复用环境”和“工作空间独享环境”。Workspace 持久化这些业务配置，不持久化 owner。
2. Server 的 `RunLauncher.buildPlacement()` 当前把 scope 翻译为 `user:<userId>` 或 `workspace:<workspaceId>`，并与原始 `userId/workspaceId` 一起放进 `RunPlacement`。
3. Runtime 使用 Server 给出的 `owner` 与 `runtimeType` 拼出 `WorkerKey`，据此查池、并发去重和复用。因此 Runtime 掌握复用机制，但复用分组已由 Server 决定。
4. Runtime SDK 已经接收 `scope + userId + workspaceId`，并再次按 user scope 取 userId、其余取 workspaceId，派生 `RuntimeSpec.ownerId`。同一请求中存在两套独立派生链路。
5. wire 校验不检查 `owner` 与 `userId/workspaceId` 的一致性。矛盾输入可导致池键、挂载规划和 provider 资源身份来自不同事实源。
6. Server 为记录 run 状态又从自己生成的 owner 反解析 scope，属于不必要的编码/解码耦合。
7. Runtime/provider 已独占 start、并发取得、release、destroy、fence、缓存/容器处理；Server 不直接参与资源实现。
8. 当前 `releaseOwner` 让 Server 用 Runtime 内部复用身份表达 workspace/user 生命周期；重连对账由 Server 从 `WorkerSnapshot` 合成 owner 列表后执行。
9. `OwnerKey/WorkerKey` 对 Runtime 内部池仍有价值，但没有必要作为 Server↔Runtime 公共协议。
10. admin `stopWorker` 目前使用 `WorkerKey`，也把内部池索引暴露到 Server；更合适的控制标识是不透明 `workerId`。

## 初步目标边界

- Server 权威：用户身份、Workspace 身份、Workspace 配置的 scope/runtimeType/runtimeHostId、业务生命周期事件、提交前业务授权。
- Runtime 权威：根据 scope 与业务 ID 派生复用主体、WorkerKey、worker 池与 provider 生命周期、当前能力二次校验。
- Provider 权威：具体环境如何创建、复用底层载体、保留或销毁。

目标 `RunPlacement` 直接携带 `scope`、`userId`、`workspaceId`，删除 `owner`。Runtime 内部只派生一次 reuse subject，再由所有池键、RuntimeSpec、provider context、worker env 和 diagnostics 复用。

## 仍需验证的问题

1. `scope=user` 是“必须复用”还是“允许 Runtime 在该隔离边界内自行复用”；契约应区分隔离边界与缓存策略。
2. workspace 删除与 user 禁用/删除应如何设计业务生命周期 API，尤其 user 删除是否必须释放该用户所有 scope 的 worker。
3. 重连对账如何在不重新公开 OwnerKey 的情况下完成。
4. WorkerEntry 是否应保存结构化 reuse subject，而非只保存可解析字符串。
5. provider 的 `ownerId`、容器命名及 native channel 索引是否存在 scope/runtimeType 碰撞。
6. 目标架构文档中的 Host 派生表述与 Server 下发 owner 契约互相冲突，需要明确哪些旧决策被推翻。
7. 修改范围、兼容迁移顺序和精确验收测试尚未完成。

## 第 2 轮补充结论

### 语义定案

- `scope` 表示允许共享的最大边界，不表示 Runtime 必须复用，也不单独代表安全隔离强度。
  - `workspace`：执行资源不得服务其他 workspace。
  - `user`：执行资源可以服务同一 user 的多个 workspace，但不得跨 user。
- 当前“一 `(scope subject, runtimeType)` 一个活跃 worker”可以作为 Runtime 的初始策略保留，但不再是公共协议不变量。
- Server 下发 `scope + userId + workspaceId + runtimeType + runtimeHostId`；Runtime 唯一派生结构化 `ReuseIdentity`，并由该身份生成内部索引、provider resource name、worker env 与诊断字段。

### 生命周期核验

1. 当前 `releaseOwner` 只枚举已经进入 `WorkerPool.workers` 的条目，不覆盖已 reserve、仍在异步准备 RunConfig 的 submit，也不访问 `acquisitions`。release ACK 后旧 submit 仍可能创建 worker。
2. starting worker 已入池时，release 会移除 entry、取消 handshake，后续 acquire 通常回滚；但 ACK 早于启动任务真正 settle，因此不是线性化释放屏障。
3. ready worker release 先清池和 run，再 best-effort provider release；provider 失败被吞掉，没有 durable retry 状态。
4. user 停用/删除 listener 明确只过滤 `user-scope` owner；该用户的 workspace-scope worker 与 active run 不处理。现有测试锁定了这个行为，但事件注释与目标文档都声称清理用户名下资源，存在语义冲突。
5. workspace 删除 user-scope 场景不应停止共享 worker，但必须取消并清掉该 workspace 的 runs/config。
6. registered Host 重连时的 workspace/user 对账由 Server 消费 admin `WorkerSnapshot` 并合成 `listOwners`；这违反协议“诊断形状不供业务消费”的现有声明。
7. Host connected 事件的异步 listener 不形成接收新 submit 前的 reconciliation gate；旧资源清理与新工作可能并发。

### 目标生命周期约束

- 公共命令表达业务生命周期主体，不表达 Runtime cache key：`releaseSubject({ runtimeHostId, subject, revision? })`，subject 是 workspace 或 user 的 discriminated union。
- Runtime 在 run reserve 时即保存结构化 placement/subject，使 release 能命中 pre-config、acquiring 和 ready 三个阶段。
- release 成功语义：命令开始前已受理且属于目标 subject 的 reservation/acquisition/worker 都已被 fence、取消并完成必要回滚；重复调用幂等。
- user disable/delete 若定义为 execution revoke，Server 必须先取消该用户全部 active runs，再释放 user-scope 与该用户所有 workspace-scope 资源。可逆 disable 需要 lifecycle revision，防迟到命令误杀 re-enable 后的新 worker。
- 重连使用独立的结构化业务对账投影，不由 admin `WorkerSnapshot` 合成；查询失败不能当作空集合。

### 协议与 Runtime 内部模型

- `RunPlacement` 删除 `owner`，增加始终存在的 `scope`；native 也是 `workspace` scope。
- shared 删除公开 `OwnerKey/WorkerKey` 与构造/解析函数。
- Runtime 内部 `WorkerEntry` 保存结构化 `{ scope, subjectId, userId, workspaceId, runtimeType }`。控制主索引用 `workerId`，复用索引独立维护，使复用策略可替换。
- admin stop 使用 `{ runtimeHostId, workerId }`；snapshot 不再暴露可构造的 cache key。
- runtime-sdk/provider 的 `ownerId` 改为 Runtime 提供的不透明 `resourceName`，同时仅在需要 label/诊断时提供结构化 isolation。
- Docker 当前把裸 ownerId 直接放进容器名，存在 scope 命名空间冲突及非法字符风险；SDK 的 worker resource env / 日志名则另行经过 lossy sanitize 与 120 字符截断，两条路径不能混为一谈。native provider 以 ownerId 索引 child channel。目标统一改为碰撞安全 resourceName 与 workerId。
- worker env 的 owner 术语改为 isolation/reuse 或只保留 workerId/runtimeType/resourceName。

### Tunnel 与迁移

- submit、release、stop、snapshot 的 wire 形状都改变，属于 breaking change。默认建议 tunnel protocol v2 → v3，Server 与 registered Runtime 同步升级；若明确要求滚动升级，再单独实现 transport-only v2/v3 双栈，不让 legacy owner 回流业务层。
- 实施顺序：先 ADR/目标契约；Runtime 内部结构化模型；SDK/provider；shared v3；Server launcher/lifecycle/admin；registered shutdown；最后删除 legacy owner helpers 并更新权威架构文档。

### 场景验收矩阵

1. workspace scope 同 workspace 可按 Runtime 当前策略复用，不同 workspace 绝不共享。
2. user scope 同 user 跨 workspace 可复用，不同 user 绝不共享；删一个 workspace 不误停共享 worker。
3. 同字面 userId/workspaceId、不同 runtimeType、特殊字符/截断后等价 ID 均不碰撞。
4. release 覆盖 RunConfig 准备、provider start、ready 三阶段；ACK 后旧 submit 不得再建资源。
5. user disable/delete 按最终产品语义覆盖两类 scope，且顺序为先 cancel runs 后 release resources。
6. Host 离线后 workspace 删除/user 禁用，重连对账能补清；对账完成前不得接受与失效主体有关的新 submit。
7. business reconciliation 不调用 admin `listWorkers`；失败有显式结果与重试。
8. admin 以 host+workerId 精确停止，未知 workerId 幂等空操作。
9. v3 版本匹配全链路通过，v2 按选定同步升级策略明确拒绝。

## 第 2 轮证据补充

- `apps/runtime/src/host/run-session-registry.ts`
- `apps/server/src/user/owner-release/user-owner-release.listener.spec.ts`
- `apps/server/src/runtime-host/contract/tunnel-runtime-host.ts`
- `apps/server/src/runtime-host/gateway/host-tunnel.handler.ts`
- `apps/runtime/src/registered/main.ts`
- `packages/runtime-docker/src/docker-runtime.provider.ts`
- `packages/runtime-opensandbox/src/opensandbox-runtime.provider.ts`
- `packages/runtime-sdk/src/sandbox-launch.ts`
- `apps/runtime/src/providers/native/native-runtime.provider.ts`

## 证据索引

- `apps/web/src/components/workspace-dialog.tsx`
- `apps/server/prisma/schema.prisma`
- `apps/server/src/workspace/placement/workspace-runtime.policy.ts`
- `apps/server/src/run/launch/run.launcher.ts`
- `packages/shared/src/protocol/runtime-host.ts`
- `packages/shared/src/protocol/wire.ts`
- `apps/runtime/src/host/runtime-host.ts`
- `apps/runtime/src/host/worker-pool.ts`
- `apps/runtime/src/host/run-config.ts`
- `packages/runtime-sdk/src/runtime-spec.ts`
- `apps/server/src/run/workspace/run-workspace.listener.ts`
- `apps/server/src/workspace/owner-release/workspace-owner-release.listener.ts`
- `apps/server/src/user/owner-release/user-owner-release.listener.ts`
- `docs/design/server-runtime-worker-target-architecture.md`
