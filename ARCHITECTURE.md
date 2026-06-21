# AgeWork 核心架构图

> Agent 运行基础设施（Provider / Transport / Run / Workspace 分层）当前实现状态。
> 详细设计见 `docs/archive/superpowers/specs/`。

## 1. 总体分层

```
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/web (AG-UI Client)                                                   │
│   - assistant-ui Thread / chat 界面                                       │
│   - SSE 订阅 Run 事件                                                     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                  │ HTTP /api/v1/...
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/api (NestJS) — 控制面                                                │
│                                                                            │
│  AgentController / AdminRunController                                    │
│   - 鉴权、workspace/conversation/message 业务逻辑                         │
│   - 创建 Run，解析 Workspace -> runtimePath/hostPath                      │
│   - 组装最小 RunConfig（含 model config，剥离业务数据）                  │
│   - AgentRunHandler -> RuntimeRunner                                      │
│                                                                            │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │ RuntimeProviderRegistry.resolve(runtimeType)                    │    │
│   │        │                                                        │    │
│   │        ├──► LocalRuntimeProvider  (runtimeType = "local")       │    │
│   │        │                                                        │    │
│   │        └──► SandboxRuntimeProvider (runtimeType = "sandbox")    │    │
│   │                ├── DockerSandboxEngine                          │    │
│   │                └── OpenSandboxEngine                            │    │
│   └────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│   RuntimeEventProcessor.publish()  ◄── 所有上行事件唯一汇入口            │
│        │                                                                  │
│        ├──► Run 状态更新 / ActiveRuntimeStore                             │
│        ├──► SSE subscribers (推给 apps/web)                               │
│        └──► RuntimeMessageAggregator -> Message upsert (ConversationService) │
│                                                                            │
│   RuntimeInternalController  /internal/runs/*  ◄── 仅供 Docker worker 调用│
│        - GET  /internal/runs/:runId            (拉取 RunConfig)         │
│        - POST /internal/runs/:runId/events     (上报 event)             │
│        - GET  /internal/runs/:runId/controls   (短轮询拉取 control)     │
│        RuntimeInternalAuthGuard 校验 run-scoped internal access key       │
│        RuntimeControlQueue（内存 Map<runId, Envelope[]>）                │
└───────────────────┬───────────────────────────┬──────────────────────────┘
                     │ fork() + IPC              │ docker run + HTTP
                     ▼                           ▼
┌────────────────────────────────┐   ┌──────────────────────────────────────┐
│ Local Worker (子进程)           │   │ Docker Worker (容器)                  │
│ apps/worker, IpcTransport       │   │ apps/worker, HttpTransport            │
│                                  │   │                                        │
│  fetchRunConfig() ◄─ via IPC    │   │  fetchRunConfig() ◄─ GET /internal/.. │
│  Agent Adapter (Claude/Codex)   │   │  Agent Adapter (Claude/Codex)         │
│   -> Observable<AGUIEvent>      │   │   -> Observable<AGUIEvent>            │
│  emit(agui.event/run.status/    │   │  emit(...) ◄─ POST /internal/.../events│
│       heartbeat) via child.send │   │  subscribeControls() ◄─ GET .../controls│
│  subscribeControls() via IPC    │   │       (2s 间隔短轮询, afterSeq)       │
└──────────────────────────────────┘   └──────────────────────────────────────┘
```

## 2. 事件与控制流向

```
事件上行（worker -> 前端）
  Agent SDK
    -> Agent Adapter
    -> 原始 AG-UI Event
    -> RuntimeTransport.emit(agui.event)   (Ipc | Http)
    -> RuntimeEventProcessor.publish()
        - 按 runId+seq 去重 / 顺序校验 (lastSeqMap)
        - 更新 Run 状态 (run.status / heartbeat)
        - 推送 SSE subscribers
        - RuntimeMessageAggregator -> Message upsert

控制下行（前端 -> worker）
  AG-UI Client
    -> API endpoint (stop / question-answer)
    -> RuntimeRunner 找到 active runtime handle
    -> RuntimeProvider.sendControl(runId, ControlPayload)
        - LocalRuntimeProvider:  child.send(envelope)                [IPC，立即送达]
        - SandboxRuntimeProvider: RuntimeControlQueue.push(runId, env) [等待 worker 轮询]
    -> worker subscribeControls() 回调
    -> Agent Adapter.interrupt() / resolveQuestion(...)
```

## 3. 心跳与终止清理

```
worker 每 5s 发 heartbeat ──► HeartbeatWatchdog (每个 provider 各自维护)
                                  │
                                  ├─ 60s 内收到心跳 -> 正常
                                  │
                                  └─ 超时 -> publishWorkerErrorStatus()
                                            -> Run.status = "error"
                                            -> provider.cleanup(runId)

正常/取消终止：
  worker emit run.status (finished | error | cancelled)
    -> RuntimeEventProcessor.handleRunStatus() 识别终态
    -> RuntimeInternalController.postEvent / IPC handler
        -> provider.cleanup(runId)   (清理 heartbeat watchdog / control queue / container)
```

## 4. 关键模块对应关系

| 概念 | 接口 (@agework/shared/protocol) | Local 实现 | Docker 实现 |
|---|---|---|---|
| 执行环境 | `RuntimeProvider` | `LocalRuntimeProvider` (fork) | `SandboxRuntimeProvider` (docker run / opensandbox) |
| 通信通道 | `RuntimeTransport` | `IpcTransport` | `HttpTransport` |
| 控制下发 | `sendControl()` | `child.send()` | `RuntimeControlQueue.push()` + 2s 短轮询 |
| 内部访问 | — | 同机父子进程信任 | `RuntimeInternalAccessService` 签发 run-scoped access key，`RuntimeInternalAuthGuard` 校验 |
| 心跳/清理 | — | `HeartbeatWatchdog` (runtime-provider-utils.ts) | 同左 |

## 5. 数据模型（要点）

```
Workspace ──< Project ──< Conversation ──< Run
                                       │
                                       ├ runtimeType: "local" | "sandbox"
                                       ├ runtimeResourceId: pid | containerId
                                       ├ status: queued/preparing/running/
                                       │         requires_action/cancelling/
                                       │         finished/error/cancelled
                                       ├ lastSeq / lastControlSeq
                                       └ lastHeartbeatAt
```

`Conversation.activeRunStatus` 等前端字段由 active/latest Run 派生，Run 是运行事实源。
