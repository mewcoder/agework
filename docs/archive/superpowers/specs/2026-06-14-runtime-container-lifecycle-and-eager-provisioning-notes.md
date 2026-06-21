# Runtime 容器生命周期与 Eager Provisioning 讨论纪要

> 状态：话题二 Phase 1 设计已确认，待实现；话题一（Phase 2）仍为讨论中的结论草案，待 Phase 1 落地后回头修订。

## 背景：心跳 key 不匹配 bug（已修复）

- 现象：聊天中稍微停顿后报"找不到 Session ID"，并新建了容器而不是复用现有容器。
- 根因：`heartbeatWorkspace(workspaceId)` 中 `workspaceToScopeKey` 的 key 是会话的 `workspaceId`，但实际收到的参数是 `resourceKey`（"user" 隔离级别下 = userId，与会话 workspaceId 不同）。导致 `heartbeats.beat()` 从未真正命中，60s `HeartbeatWatchdog` 永远超时 → `releaseScopeRuntime` 撤销 access key 并清空 `runtimeResourceId`，下次 run 只能新建沙箱，丢失 Claude session。
- 修复：`heartbeatWorkspace` 直接 `beat(workspaceId)`（把参数当作 resourceKey），移除已死的 `workspaceToScopeKey` map。
- 验证：`sandbox-runtime-provider.spec.ts` 26/26 通过，`tsc --noEmit` 无报错。
- 涉及文件：`apps/api/src/runtime/providers/sandbox-runtime-provider.ts`

## 话题一：Eager Provisioning（创建 workspace 时预先建容器）—— 讨论中

### 动机

- 固化隔离级别绑定（`runtimeIsolationScope` 在创建 workspace 时确定并落库，全局环境变量 `RUNTIME_ISOLATION_SCOPE` 仅作为创建时默认值）
- 消除首次对话的冷启动延迟
- 提前发现环境问题

### 已达成的结论

1. **数据库为准**：`runtimeIsolationScope` 应该是 `Workspace` 模型上的字段（类似已有的 `defaultRuntimeType`、`sandboxEngine`），创建时按当前全局配置写入并固化；之后 `RuntimePlacementService.resolveForRun()` 应从 workspace 记录读取，而不是每次读全局 `ConfigService.getRuntimeIsolationScope()`。
2. **创建 workspace 时同步建容器**：`WorkspaceService.create()` 中同步调用 `ensureRuntime(placement)`，绑定关系（`WorkspaceRuntime` ↔ `RuntimeResource`）立即建立；失败则整个 workspace 创建回滚。
3. **`ensureRuntime` 是 scope-agnostic 的单一操作**：
   - 不同隔离级别的差异，仅体现在 `RuntimePlacementService` 计算出的 `resourceKey` / `mountTarget` 上，`ensureRuntime` 本身不需要按 scope 分支。（`resourceName` 字段已在 Phase 1 中删除，见下方"容器命名"设计）
   - 逻辑：检查 `scopeStates.get(resourceKey)` 是否已有 `runtimeResourceId`：
     - 有 → 复用，仅新增一条 `WorkspaceRuntime` 绑定记录（"user" 级别下，同一用户的多个 workspace 复用同一容器，这本来就是该隔离级别的既有语义，不是新行为）。
     - 没有 → 走现有 `createSandbox`（`getOrCreate` + `startWorker`）路径，与 `start()` 今天的行为一致。
   - **不需要**针对 `RuntimeResource.status = stopped` 做特殊的"视为不存在、重新创建"分支——因为目前两种引擎的 `stop()` 都是彻底销毁（见话题二），不存在"恢复已停止资源"的中间态。**但话题二一旦落地（stop 不销毁），这里需要重新评估。**

### 容器生命周期问题（用户提出的疑问，已澄清）

- "user" 隔离级别下，**一个用户的所有 workspace 本来就共享同一个容器**（`resourceKey = userId`），eager provisioning 不改变这一点，只是把绑定关系提前到创建 workspace 时建立。
- 现状的空闲回收（`IdleWatchdog`，默认 `RUNTIME_IDLE_TIMEOUT_SECONDS=1800`）按 `resourceKey` 维度计时：当该 resourceKey 下**所有** workspace 都没有 `activeRuns` 且持续超时，才会触发 `handleIdle` → `releaseScopeRuntime` → `engine.stop()`。
- "复用"不等于"永不回收"——这是两个独立的概念，eager provisioning 只影响"创建时刻"的行为，不改变回收逻辑。

### 尚未解决

- 与话题二的交叉点：如果话题二让 `stop()` 变成"停止但不销毁"，`ensureRuntime` 在"resourceKey 已有一个 stopped 的资源"场景下要不要尝试"唤醒"而不是新建？需要在话题二方案确定后回头修订本话题的设计。

---

## 话题二：容器 stop ≠ 销毁（核心问题，根因分析）

### 触发缘由

用户提出疑问："为什么容器停了就回收了，不能 stop 之后再 start 吗？数据不就一直在了吗？"

### 根因调查结果

**Claude session 的 resume 数据默认存在容器内部，不在挂载卷里：**

- Claude Agent SDK 默认把 session transcript 写到 `CLAUDE_CONFIG_DIR ?? $HOME/.claude/projects/<projectKey>/<sessionId>.jsonl`（确认自 `@anthropic-ai/claude-agent-sdk` 的 `sdk.mjs`）。
- worker 容器的 Dockerfile（`apps/worker/Dockerfile`）设置 `HOME=/home/agent`，代码中未设置 `CLAUDE_CONFIG_DIR`。
- 因此 session transcript 落在 `/home/agent/.claude/projects/...`，这是容器的**可写层**，跟挂载卷（`workspaceHostPath` → `workspaceMountPath`，如 `/workspaces`）是两块完全不同的存储。
- **现状**：容器一旦被 `docker rm`（无论是 idle-timeout 还是其他原因回收），`/home/agent/.claude` 数据永久丢失，下次用 `resume: sessionId` 必然失败 —— 这是独立于"话题零"心跳 bug 的另一个问题，心跳 bug 只是让它更频繁触发。

> 备注：`2026-06-12-docker-persistent-container-design.md` 中提到的"DB 兜底 `agentResumeId`"机制，目前看仅解决了"内存 `sessions` Map 丢失但容器内 `.claude` transcript 还在"的场景；若容器本身被销毁、`.claude` transcript 一起消失，单靠 DB 里的 sessionId 字符串无法让 SDK 找到对应 transcript 内容，resume 仍会失败。

### Docker / Docker 机制本身的澄清

容器 = 进程 + 专属可写文件系统层，两者生命周期可以分离：

| 操作 | 效果 |
|------|------|
| `docker stop <name>` | 结束容器内进程（类似关机），容器对象和写层文件系统**保留在磁盘上** |
| `docker start <name>` | 把已停止的容器重新启动，写层数据原样可用 |
| `docker rm <name>` | 删除容器对象及其写层，数据真正消失 |

**现状代码的问题**：
- `DockerSandboxEngine.stop()` = `docker stop` **紧接** `docker rm`，相当于把"关机"和"销毁"绑在一起。
- `DockerSandboxEngine.getOrCreate()` 永远 `docker run --name <resourceName>` 全新创建，没有"先找同名已停止容器、`docker start` 复用"的路径。

这是这套代码自己的实现选择，不是 Docker 本身的限制。

### OpenSandbox 引擎的限制

- `OpenSandboxClientLike` 接口（`apps/api/src/runtime/providers/opensandbox-client.ts`）目前只有 `createSandbox` / `getSandbox` / `deleteSandbox` 三个方法，没有暂停/恢复的概念。
- `OpenSandboxEngine.stop()` 直接调用 `deleteSandbox`。
- 要支持"stop 不销毁、start 可恢复"，需要先确认 OpenSandbox 上游 SDK 是否提供对应能力——目前封装层完全没有体现，需要进一步调研。

### 用户的诉求（本话题核心）

> "我只想它 stop 和 start，别的操作不要做。"

即：希望容器的"停止"语义变成 docker stop（保留写层数据），"恢复使用"变成 docker start（复用同一容器对象），完全不依赖把 `.claude` 目录挂载到宿主机卷这种额外改动。

### 待决问题

1. **范围（已决定）**：先做 Docker。OpenSandbox 暂不改动，维持现状（destroy + recreate，session 丢失）。
2. OpenSandbox 后续若要支持，需先调研上游 SDK 是否有暂停/恢复能力；不支持的话再考虑"挂载 `CLAUDE_CONFIG_DIR` 到卷里"的替代方案。本次不处理。
3. 与话题一的交叉：见下方"resume 接入 start()/createSandbox 的设计"。
4. `RuntimeResource.status` / `releaseScopeRuntime` 的拆分：见下方设计。

### 设计：`stop()` 统一改为"只停止，不销毁"

不再区分"软停止/硬停止"，`engine.stop()` 在所有调用路径下统一变为 `docker stop`（不 `docker rm`）。容器对象和可写层数据始终保留在磁盘上；真正的 `docker rm` / "DB 记录与容器对不上"的对账清理，作为后续独立工作，本次不做。

| | 现状 | 新行为（所有路径统一） |
|---|---|---|
| 容器 | `docker stop` + `docker rm` | 只 `docker stop`，**不 rm** |
| `RuntimeResource.status` | → `stopped`，但 `runtimeResourceId` 实际已失效（容器已被销毁） | → `stopped`，`runtimeResourceId` 仍指向一个真实存在、可 `docker start` 的容器 |

两个调用路径的差异仅体现在 access key 上：

- `handleIdle`（idle 回收）/ 心跳超时 → `engine.stop()` + DB `status=stopped`（保留 `runtimeResourceId`）+ **不撤销 access key**（容器里 baked-in 的 key 还有效，撤销了下次 `docker start` 起来的 worker 用旧 key 回调会 401 退出）+ 清理内存 `scopeStates.runtimeResourceId`（设为空，触发下次走"resume 已停止容器"路径）。
- workspace/用户删除（`runtime-lifecycle.service.ts` → `shutdownRuntimeResourceByKey`）→ `engine.stop()` + DB `status=stopped` + 撤销 access key（维持现状行为不变，删除场景下该 resourceKey 之后不会再有 `start()` 调用，撤销与否不影响 resume）。

### 设计：resume 接入 `start()`/`createSandbox`

触发点：`start()` 中"内存里没有活跃容器引用"的分支（`!scopeState.runtimeResourceId && !this.pendingSandboxes.has(resourceKey)`），现状总是 `issueWorkspaceKey()` 生成新 key——需要拆成两种情况：

1. 进入该分支后，先查 DB：这个 `resourceKey` 是否有 `RuntimeResource` 记录 `status === "stopped"` 且 `runtimeResourceId` 非空？
2. **有 → resume 路径**：
   - 不调用 `issueWorkspaceKey`（沿用已有 access key，因为容器里 baked-in 的就是这个，软停止时没撤销）。
   - `createSandbox` 先尝试 `engine.resume?.(existingResourceId, input)`（新接口方法，Docker 实现为 `docker start <id>`）。
   - 成功 → 复用该 `runtimeResourceId`，标记 DB `status=running`，重新 `heartbeats.start(...)`。
   - 失败（容器已被外部清掉等）→ fallback 到第 3 步。
3. **没有 / resume 失败 → 全新创建**（现状逻辑不变）：`issueWorkspaceKey` 生成新 key → `engine.getOrCreate()` + `startWorker()`。

新增引擎接口（可选方法，OpenSandbox 不实现）：

```ts
interface SandboxEngine {
  // 现有：getOrCreate / startWorker / stop（stop 改为只 docker stop，不 rm）
  resume?(runtimeResourceId: string, input: SandboxStartInput): Promise<SandboxRuntime>;
}
```

**实现细节备注**：`docker run -e AGEWORK_RUNTIME_ACCESS_KEY=...` 是创建时刻的环境变量快照，`docker start` 不会更新它——这正是"软停止不能 revoke access key、resume 不能重新签发 key"的根本原因，实现时不要"顺手"把 revoke 加回去。

### 设计：容器命名（`resourceName`）与冲突处理

**问题背景**：`getOrCreate()` 全新创建走 `docker run --name <resourceName>`，`resourceName` 由 `agework-user-${userId}` / `agework-ws-${workspaceId}` 派生，固定不变。一旦 resume 路径未命中（容器已被外部清理等），全新创建会因为"同名已停止容器仍占用该名字"而 `docker run` 报错。

**关键澄清**：`runtimeResourceId`（真正用于查找/resume/stop 的唯一标识）本来就是 Docker 自己分配的随机 container ID hash，存进 `RuntimeResource.runtimeResourceId`（`@@unique([runtimeType, runtimeResourceId])`），按 `resourceKey` 查找（`ownerWhere`/`upsertRunning`）——这部分机制本身没问题，跟 OpenSandbox 的 `sandbox.id` 完全对应，**不需要改**。`resourceName` 只是 `docker run --name` 这个展示用的容器名，跟 `runtimeResourceId` 的存取无关。

**决定（方案 A）**：
- `DockerSandboxEngine.getOrCreate()` 不再传 `--name`，让 Docker 自动生成随机容器名 —— 与 OpenSandbox 的"引擎自身分配随机 ID"模式一致，结构性消除重名冲突。
- `resourceKey` / `runtimeIsolationScope` 等归属信息改为 `--label agework.io/runtime-resource-key=<resourceKey>`、`--label agework.io/runtime-isolation-scope=<scope>`——`SandboxStartInput.metadata` 里已经有这两个值（`sandbox-runtime-provider.ts:185-188`），直接复用即可，无需新增字段。
- `RuntimePlacement.resourceName` / `SandboxPlacement.resourceName` 字段及其在 `RuntimePlacementService.resolveForRun()` 中的计算逻辑随之变为死代码，一并删除（涉及 `packages/shared/src/protocol/transport.ts`、`runtime-placement.service.ts`、`sandbox-engine/index.ts`、`docker-sandbox-engine.ts`、`sandbox-runtime-provider.ts` 及相关 spec）。
- 不再需要"`docker rm -f` 后重试"之类的自动销毁兜底：全新创建不会因为命名冲突失败，若仍然失败（如 image 不存在、磁盘满等），按现状抛错即可，无需特殊处理。

### 设计：resume 的范围 —— 仅同进程内（Phase 1）

resume 依赖"上次释放时记下的 `runtimeResourceId`"，这份信息存在 `SandboxScopeState`（内存）里：

- `releaseScopeRuntime` 释放时，把 `state.runtimeResourceId` 转存到 `state.lastStoppedRuntimeResourceId`，再清空 `runtimeResourceId`。
- 下次 `start()` 进入 `createSandbox` 时，若 `lastStoppedRuntimeResourceId` 非空且 `engine.resume` 存在，先 `docker start <id>` 尝试复用；成功则清空该字段并复用；失败则 fallback 到 `engine.getOrCreate()`（全新创建，方案 A：不传 `--name`）。

**本 Phase 不处理跨进程（API 服务重启）后的 resume**：服务重启后内存 `scopeStates` 为空，`start()` 走全新创建路径——这与现状行为一致，不是回归。重启前残留的容器由下方"`run-recovery.service.ts` 改造"标记为 `status=stopped` 并 `stop`（不 rm），数据保留在磁盘上，但暂不会被自动 resume，会随时间积累。这属于"清理/对账"范畴，按之前的结论本次不做，作为 Phase 1b 的候选（需要额外解决：resume 时如何拿到旧容器 baked-in 的 access key —— 涉及把 key 持久化到 `RuntimeResource.metadata`，是 Phase 1b 的核心工作）。

### 设计：`run-recovery.service.ts` 改造——孤儿容器发现改为基于 DB

现状 `recoverOrphanContainers()` 用 `docker ps -a --filter name=agework-ws-/agework-user-` 按命名前缀发现重启前残留的容器。方案 A 去掉确定性命名后，此机制失效，改为：

- 查询 `RuntimeResource` 中 `status === "running"` 的所有行（重启前仍在运行、重启后内存态丢失，视为孤儿）。
- 对每一行，复用现有 `shouldRecoverOrphanRuntime` 的判断逻辑（"user" 隔离级别的共享资源不处理，避免误杀其他 workspace 仍在用的共享容器）；需要处理的调用 `provider.recoverOrphan(resource.runtimeResourceId)`（stop+kill，不 rm）。
- **新增**：处理后将这些行的 `status` 更新为 `"stopped"`（现状 `recoverOrphan` 不更新 DB，这是个缺口）。

---

## 实施阶段划分

1. **Phase 1（本次优先实现）**：
   - `engine.stop()` 改为只 `docker stop` 不 `rm`（所有路径统一）。
   - `SandboxEngine` 新增可选 `resume()`；`DockerSandboxEngine` 实现为 `docker start`。
   - `sandbox-runtime-provider.ts`：同进程内 resume 接入（`lastStoppedRuntimeResourceId`）+ `releaseScopeRuntime` 不再撤销 access key。
   - `resourceName` 改为引擎自生成随机名 + `--label` 标签化归属信息；删除 `RuntimePlacement.resourceName` / `SandboxPlacement.resourceName` 及相关计算逻辑。
   - `run-recovery.service.ts`：孤儿容器发现改为基于 `RuntimeResource(status=running)` DB 记录，处理后标记 `status=stopped`。
   - 范围涉及 `sandbox-runtime-provider.ts`、`docker-sandbox-engine.ts`、`SandboxEngine` 接口、`RuntimePlacementService`、`run-recovery.service.ts`、`packages/shared/src/protocol/transport.ts`，不涉及数据库 schema 变更。
   - 跨进程（服务重启后）resume、access key 持久化 → Phase 1b（候选，未排期）。
2. **Phase 2（后续）**：话题一——`Workspace.runtimeIsolationScope` 字段 + 创建 workspace 时 `ensureRuntime` 同步建容器。依赖 Phase 1 的 resume 能力（"resourceKey 已绑定 stopped 容器"分支）。
