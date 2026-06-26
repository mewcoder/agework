# ACP vs AG-UI 调研分析报告

> 议题:是否用 ACP(Agent Client Protocol)替代 AG-UI;是否保留自定义 adapter;是否去掉 AG-UI。
> 结论先行:**ACP 与 AG-UI 不在同一层,不是替代关系。推荐"SDK 深度层 + ACP 广度层"并存,AG-UI 保留为前端统一契约。**

---

## 1. 背景与现状

AgeWork 当前数据流(基于代码核对):

```
Adapter(Claude SDK / Codex SDK)
  └─ 产出 AG-UI BaseEvent(TEXT_MESSAGE_*、TOOL_CALL_*、RUN_*、STATE_*、REASONING_*、CUSTOM)
       ↓ worker-host / peer channel(Envelope 包 agui.event)
API(NestJS:runs / conversations)
  └─ POST /conversations/agent/run → SSE 下行;GET /resume 断线重连
       ↓
Web(@assistant-ui/react-ag-ui,本仓库维护)
  └─ HttpAgent 解析 SSE → assistant-ui runtime 渲染
```

关键事实:

- AG-UI 在此是**「后端 → 浏览器」的单向 UI 事件流**。
- 人在回路(HITL)是**旁路**接上去的:adapter 用 `canUseTool` / AskUserQuestion 挂起 → 发 CUSTOM 事件 + 置 `requires_action` → 浏览器另开 `POST /conversations/agent/reply` 回传答案(`agent.controller.ts:37`),不走下行流。
- 自定义深度能力:`AskUserQuestion`(多问题 + custom responseSchema)、per-thread 权限串行队列、`pendingAction` / run status、raw trace(`raw-event-log.writer`、`run-envelope.processor`)、ModelProvider 注入(baseUrl / key)。

---

## 2. 核心结论:ACP 与 AG-UI 是两个不同边界的协议

| | AG-UI | ACP |
|---|---|---|
| 边界 | 后端 → **前端 UI** | 编辑器/client → **agent 子进程** |
| 方向 | 单向事件流(HITL 靠旁路) | 双向 JSON-RPC,权限/文件/终端原生 |
| Client 角色 | 纯渲染端(浏览器) | **资源网关**,与 workspace 同机 |
| 传输 | SSE/HTTP,天然支持断线 resume | stdio / 双工长连(子进程) |
| 典型实现 | assistant-ui、CopilotKit | Zed、JetBrains、AionUi |

「用 ACP 替换 AG-UI」是把两个不同层混为一谈。ACP 的天然位置是 **agent 边界(AgentBackend)**,AG-UI 的位置是 **UI 边界**,二者互补。

---

## 3. ACP 的能力与限制

### 3.1 ACP 解决了什么

- **统一上行 schema**:`session/update` 通知类型固定(`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、usage…);ContentBlock 与 MCP 共用(text/image/audio/resource/resource_link);tool_call 字段统一(`kind` 枚举 read/edit/delete/move/search/execute/think/fetch/other,`status` pending/in_progress/completed/failed,content 支持 diff / terminal)。
- **per-agent 翻译从「你写 N 个」变成「上游写、你复用」**:
  - Claude → `@zed-industries/claude-code-acp` / 官方 `agentclientprotocol/claude-agent-acp`(v0.52,2.1k★,Apache,active)。暴露 @-mentions、图片、tool call + permission、following、edit review、TODO(=plan)、interactive/background terminal、custom slash commands、client MCP。
  - Codex → `@zed-industries/codex-acp`(官方 Rust 二进制,走 npm)。
- **横切能力标准化**:permission / fs / terminal / cancel / resume 作为协议自带,而非每个 adapter 各自 bolt-on。
- **加 agent 边际成本≈0**(只要它有 ACP adapter)。

### 3.2 ACP 的限制(对 AgeWork 杀伤力排序)

**结构性(架构假设不匹配):**

1. ACP 假设 **client = 本地编辑器、与 workspace 同机**。AgeWork 的 client 是服务端 worker、workspace 在 sandbox、浏览器隔两跳。**ACP 只覆盖 worker↔agent 这一跳,完全不碰你最难的 worker↔browser 多租户那跳**(仍需 SSE 下行 + 权限回传 + resume)。
2. **subprocess + stdio 模型 vs 多租户 run 生命周期**:并发 run = 管一堆子进程(spawn / 崩溃恢复 / 资源回收),而现在是 SDK in-process;`run-recovery` / resume 要扛子进程重启。

**会丢掉的定制能力:**

3. **自定义 HITL 映射不进去**:`AskUserQuestion`(多问题、custom schema、权限串行队列)在 ACP 里只有固定形状的 `request_permission`,对不上,只能特判或塞 `_meta`。
4. **`request_permission` 是阻塞式 JSON-RPC**,不是你现在「挂起 + 旁路 resume」的健壮模型;用户拖久/断线时要持有被卡住的子进程 + 挂起的 RPC。
5. **raw trace / 原始事件被挡在子进程里**:只看得到 adapter 选择吐出的 `session/update`,底层 SDK 原始 message 拿不到(除非转发进 `_meta`),审计深度缩水。
6. **自定义 ModelProvider 受限**:baseUrl / key 只能通过 adapter 认的 env 间接喂,adapter 不读的就传不了。

**协议层面:**

7. **`_meta` 是逃生舱 = 软性碎片化**:统一的是无聊的 80%,有价值的差异(各家特性)落在各自 `_meta`,仍需 per-adapter / per-version 分支,只是从「写 adapter」变成「读 `_meta`」。
8. **pre-1.0、移动靶**:逃离「追 Claude SDK 升级」会换成「追 ACP adapter 的 breaking change」。

---

## 4. 关键决策

### 决策 1:纯 ACP vs 自定义 + ACP → **并存,但分层**

**纯 ACP 不可取**:与产品定位(私有化、深度治理、审计、provider 可控)冲突——深度治理依赖 SDK 路径能力(raw trace、自定义 HITL、ModelProvider),纯 ACP = 亲手砍掉差异化去换 pre-1.0 标准。

**推荐:按 agent 分层(复用已有的 `AgentBackend` 抽象)。**

| 层 | 用什么 | 给谁 |
|---|---|---|
| 深度层 | 自定义 SDK backend | 旗舰 agent(Claude / Codex):要 HITL / trace / provider 深控 |
| 广度层 | ACP backend(官方 adapter) | 长尾 agent(Gemini 等):低成本接入,接受能力边界 |

> 不让深度层无限膨胀:ACP 成熟到覆盖某 agent 需求时,把它从深度层挪到广度层,让自定义路径自然收缩。短期 Claude/Codex 留在 SDK。

### 决策 2:去掉 AG-UI → **保留**

- **逻辑上**:纯 ACP 会抽掉 AG-UI 的「convergence 必要性」;但只要选了并存(多后端协议),AG-UI 作为「多协议 → 单一前端契约」的收敛层就更不可缺。**「去 AG-UI」与「并存」自相矛盾。**
- **浏览器当不了 ACP client**(不能为服务端 sandbox 提供 fs/terminal、隔网络),所以「浏览器朝向的 UI 协议」这个槽位永远存在;删 AG-UI ≠ 少一层,而是**把它换成自己写的**(自写 react-acp ≈ 2–3k 行 + 自补 rehydration,ACP 无 `STATE_SNAPSHOT`/`MESSAGES_SNAPSHOT`)。
- 现实约束:**无第一方 react-acp**(npm 404、本地 assistant-ui checkout 40+ 包无、上游 packages 无);唯一沾边的 `@axhub/acp` 是第三方实验 app,且仍过一层 AI SDK 才渲染。

> **唯一让「删 AG-UI」成立的触发条件**:出现第一方、成熟、含 rehydration 的 react-acp。届时再删,代价小得多。

---

## 5. 推荐的目标架构

```
Browser
 └─ AG-UI (react-ag-ui)              ← UI 边界:统一契约,不动
     └─ AgeWork Runtime
         └─ AgentBackend (统一 seam,所有 backend 都吐 AG-UI)
              ├─ Claude SDK backend   → 直接 emit AG-UI   [深度:HITL / trace / provider]
              ├─ Codex SDK backend    → 直接 emit AG-UI
              └─ ACP backend          → ACP client + ACP→AG-UI 映射  [广度:长尾 agent]
```

每个 backend 的唯一职责:**产出 AG-UI 事件**。ACP backend = 1 个 ACP client(用官方 `@agentclientprotocol/sdk`)+ 1 段 ACP→AG-UI 映射(机械,核心几百行:`agent_message_chunk→TEXT_MESSAGE_*`、`tool_call/update→TOOL_CALL_*`、`plan→CUSTOM/STATE`、usage→`RUN_FINISHED.result`;ACP 缺的 snapshot 用现有持久化补)。

与 dev 文档 `product-positioning-and-direction.md` 的路线一致:v1 SDK-first 深控 Claude/Codex + 保持 AG-UI;v2 评估 ACP / A2A backend 做广度。

---

## 6. 成本量化(自写 runtime 的基准)

本地 assistant-ui checkout 同类 runtime 适配器体量(业务代码,不含测试):

- `react-a2a` ≈ **1,880 行**(协议 runtime 下限)
- `react-ag-ui` ≈ **3,150 行**(现用,含 snapshot / 聚合 / 中断)

→ 自写 web 端 `react-acp` ≈ 1.5k–3k 行 + 测试,且要复刻 rehydration / run 聚合 / 工具拼装。**ACP client 那块两条路都得写**(有官方 SDK 兜底,几百~千行,主要把 fs/terminal/permission 回调接到现有 sandbox/runtime),是可控的小头;**贵的是 UI runtime,而它你已经拥有(react-ag-ui)。**

---

## 7. 案例:AionUi(../agent-project/aionui)

AionUi 把「ACP-direct + 砍掉 AG-UI + 不用 assistant-ui」真实实现了一遍:

- **Electron 桌面 app**(office-ai),栈 `@office-ai/aioncli-core`(fork gemini-cli core)+ `@office-ai/platform` + `@agentclientprotocol/sdk ^0.18.2`。
- **ACP client 在后端 aioncore**;desktop renderer 通过 **IPC→HTTP/WS 桥**(`common/adapter/ipcBridge.ts`)与之通信。**renderer 也不是 ACP client。**
- **UI 用 Arco Design 自研**,按平台分目录:`renderer/pages/conversation/platforms/{gemini, acp, aionrs, legacy}`——**每种 agent 各一套 chat UI**(无统一协议收敛)。
- 自研归一 / HITL 层在 `common/chat/`:`ApprovalStore`(权限)、`sideQuestion`(HITL)、`acpToolCallOutput`(处理 base64 图片截断等)、`normalizeToolCall`、`slash/acpMapping`、`errorDiagnostics`、`AgentRepair`。
- 支持自定义 ACP agent(command/args/env spawn 任意 ACP 二进制)。

**启示:**

| | AionUi | AgeWork |
|---|---|---|
| 形态 | 本地 Electron,agent 本机子进程 | Web 多租户,agent 在服务端 sandbox |
| 与 ACP 模型契合度 | 高(就是 Zed 那类本地 client) | 低(client≠浏览器,隔两跳) |
| 已有 UI 投资 | 无 assistant-ui,UI 反正自己写 | 已投 assistant-ui + react-ag-ui |
| 结果 | 自研 UI runtime + 归一层划算 | 自研 = 丢掉现成 react-ag-ui,净亏 |

两点佐证本报告判断:

1. AionUi「砍掉 AG-UI」的代价照样付了——只是以 `common/chat/*` 自研归一 + 桥 + 每平台 UI 的形式存在。**删 AG-UI ≠ 少一层,而是换成自己写。**
2. `ApprovalStore` / `sideQuestion` / `acpToolCallOutput` 全是 ACP 之上自补的,**验证「ACP 标准层不够、需要补一层」**,正对应你那些定制点在 ACP 下需要重做。

可直接借鉴:AionUi 的 `common/chat/*` 归一 / HITL 设计(ApprovalStore / sideQuestion / acpToolCallOutput)——无论走哪条路都得有这层。

---

## 8. 下一步建议

1. **能力对照(定生死)**:扒 `claude-agent-acp` 与 `codex-acp` 的 `src/`,逐项对照现有 adapter 定制点(permission / 原始事件 / provider 配置),产出「定制点 → ACP 能否做 → 缺了怎么补」表。判断哪些 agent 可进广度层、哪些必须留深度层。
2. **ACP backend PoC**:worker 里用官方 SDK 拉起一个 ACP agent 子进程,验证 `session/update` 能映射回现有 AG-UI 前端、前端零改动。
3. **借鉴 AionUi 归一层**:读细 `common/chat/{ApprovalStore,sideQuestion,acpToolCallOutput,normalizeToolCall}`,抽成「接 ACP 必须补的几层」清单。

---

## 附:参考来源

- ACP 规范:overview / prompt-turn / content / tool-calls / initialization(agentclientprotocol.com)
- 官方 adapter:`agentclientprotocol/claude-agent-acp`、`@zed-industries/codex-acp`、`@zed-industries/claude-code-acp`
- Zed:claude-code-via-acp 博客、external-agents 文档
- assistant-ui:AG-UI Runtime 文档;`@axhub/acp`(第三方实验)
- 案例:`../agent-project/aionui`(本地)
</content>
