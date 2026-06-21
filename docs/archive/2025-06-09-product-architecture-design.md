# AgeWork 产品架构设计

## 1. 产品定位

**AgeWork** — 可扩展的多 Agent 工作台，让个人和小团队自由选择最适合的 AI Agent 来完成工作。

### 目标用户

| 用户类型 | 部署模式 | 核心需求 |
|---------|---------|---------|
| 个人开发者 | 客户端（Electron/Tauri） | 打开即用、原生体验、无需沙箱 |
| 小团队（2-20人） | Server + Web | 共享 Agent 资源、团队协作、沙箱可选 |

### 核心差异化

1. **多 Agent 并存** — Claude、Codex、GPT、Gemini 等，用户按任务选择
2. **两种交付形式** — 客户端（个人）、Server + Web（团队）
3. **可扩展的 Agent 生态** — 适配器模式，持续接入新 Agent

---

## 2. 架构层级

```text
AG-UI Client（浏览器 / 客户端 Web 视图）
  → API（控制面）
    → Runtime Gateway（调度）
      → Runtime Provider（启动方式）
        → Worker（执行面）
          → Agent Adapter（SDK 适配）
            → Agent SDK（Claude / Codex / ...）
```

### 各层职责

| 层 | 职责 | 位置 |
|----|------|------|
| AG-UI Client | 前端，消费 AG-UI 事件 | `apps/web` |
| API | 控制面：用户、任务、事件、鉴权 | `apps/api` |
| Runtime Gateway | 选择 RuntimeProvider | `apps/api/src/runtime/` |
| Runtime Provider | 启动 Worker（local / docker / k8s） | `apps/api/src/runtime/providers/` |
| Worker | 执行面：运行 Agent SDK，上报事件 | `apps/worker` |
| Agent Adapter | 将不同 SDK 事件转为 AG-UI | `apps/worker/src/adapters/` |

### 事件流

```text
Agent SDK → Agent Adapter → AG-UI Event → Worker → Event Store → AG-UI Client
```

### 控制流

```text
AG-UI Client → API → Control Store → Worker polling → Agent Adapter
```

---

## 3. 领域模型

| 模型 | 说明 |
|------|------|
| User | 用户 |
| Workspace | 工作空间（项目） |
| Messenger | 对话线程 |
| Task | 用户提交的一次任务 |
| Run | 某个 Agent 对某个 Task 的一次执行 |
| Event | AG-UI 事件 |
| Artifact | Run 的产物（patch、summary 等） |

---

## 4. 运行模式

### 客户端（Electron / Tauri）

```text
┌─────────────────────────────────────┐
│  Electron / Tauri 壳                │
│  ┌───────────────────────────────┐  │
│  │  API（Node.js）               │  │
│  │    ├── Web 前端（静态资源）    │  │
│  │    └── Worker（子进程）        │  │
│  └───────────────────────────────┘  │
│  SQLite                             │
└─────────────────────────────────────┘
```

- 打开即用，无需认证
- Web + API + Worker 整体打包

### Server + Web

- `apps/api` 独立部署
- 沙箱可选（Docker / K8s）
- 认证可选

---

## 5. 目录结构

```text
apps/
  api/          — 控制面（NestJS）
  web/          — 前端（React + Vite）
  worker/       — 执行面（Agent SDK）
  client/       — 客户端壳（Electron/Tauri），打包 api + web + worker
```

---

## 6. 做什么 ✅

1. 完善 Claude/Codex 体验
2. 逐步接入更多 Agent
3. 拆分 Worker
4. Runtime Provider 抽象
5. Event Store
6. Task/Run 模型
7. 沙箱（可选）
8. 团队管理
9. 客户端壳
