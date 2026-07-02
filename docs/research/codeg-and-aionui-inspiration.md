# Codeg + AionUi 对 AgeWork 的联合架构启示（深度版）

> 对上层 `agent-project/` 下两个标杆项目（**codeg** + **AionUi**）的源码进行交叉研究，提取对 AgeWork（NestJS API + React Web + Worker + Electron 壳）有参考价值的设计。
>
> **本次更新重点**（按用户要求）：
> 1. **客户端/服务端双支持架构** — 两项目都用同一份代码同时跑桌面和 Web 模式，但实现路径完全不同
> 2. **多 Agent 支持** — Codeg 的"父 agent 通过 MCP 委派子 agent"和 AionUi 的"Leader-Teammate Team Mode"是两种范式
> 3. **AgeWork 暂未实现的功能** — 把两项目的能力清单逐项拆解，每条都给出 AgeWork 可借鉴的最小可实施版本
>
> 与已有 `aionui-inspiration.md` / `codeg-and-aionui-inspiration.md` 互补——前者是单一项目总览，本报告是**主题导向**的横向深度对比。

---

## 目录

- [一、客户端/服务端双支持架构](#一客户端服务端双支持架构)
- [二、多 Agent 支持架构](#二多-agent-支持架构)
- [三、AgeWork 暂未实现的能力清单](#三agework-暂未实现的能力清单)
- [四、综合实施建议](#四综合实施建议)

---

## 一、客户端/服务端双支持架构

### 1.1 为什么这件事对 AgeWork 关键

AgeWork 当前有三端：
- `apps/web`：React + Vite，浏览器访问
- `apps/desktop`：Electron 壳，包装 Web
- `apps/api`：NestJS 后端
- `apps/worker`：Agent runtime

但**没有"无 desktop 的 server 模式"**。Codeg 和 AionUi 都已经实现了"同一份代码既能给 Electron 桌面用，又能独立 Web 服务化"。这是一个产品分水岭——决定了 AgeWork 是"单用户桌面工具"还是"可团队私有化部署的服务"。

### 1.2 Codeg 怎么做：一套 Rust 核心 + 三种二进制

Codeg 的核心做法是**用 Cargo feature flags 把同一份 Rust 代码编译成三个二进制**（详见 `codeg/src-tauri/Cargo.toml`）：

| 二进制 | Feature | 用途 |
|--------|---------|------|
| `codeg` | `tauri-runtime`（默认） | 完整桌面应用（Tauri 窗口、通知、自动更新） |
| `codeg-server` | `--no-default-features` | 独立服务端（Axum HTTP + WebSocket，命令行启动） |
| `codeg-mcp` | `--no-default-features` | stdio MCP 伴生进程，被注入到 agent CLI |

**条件编译约定**（`codeg/AGENTS.md:103-108`）：

```rust
// 仅桌面模式编译
#[cfg(feature = "tauri-runtime")]
fn show_notification(app: &AppHandle, msg: &str) { ... }

// 函数始终可用，仅在桌面模式标记为 Tauri command
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
async fn start_agent(...) -> Result<...> { ... }

// _core 后缀：接受普通引用参数，供 Tauri command 和 Web handler 共用
async fn start_agent_core(
    state: &AppState,
    ...
) -> Result<...> { ... }
```

**统一的状态抽象**（`src-tauri/src/app_state.rs`）：

```rust
pub enum EventEmitter {
    Tauri(AppHandle),                                 // 桌面：Tauri 事件总线
    WebOnly(Arc<WebEventBroadcaster>),                // Web：WebSocket 广播器
}
```

`web/router.rs`（Axum）和 `commands/*.rs`（Tauri command）都接收 `Extension<Arc<AppState>>` 或 `State<Arc<AppState>>`，调用同一组 `*_core` 业务函数。

**前端配套：Transport 抽象**（`src/lib/transport/index.ts`）：

```typescript
export function detectEnvironment(): "tauri" | "web" {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return "tauri"
  }
  return "web"
}

function createTauriTransport(): Transport {
  // 动态 require 避免 web 模式打包 tauri 依赖
  const { TauriTransport } = require("./tauri-transport")
  return new TauriTransport()
}
```

**远程桌面模式**（`src/lib/transport/remote-desktop-transport.ts`）—— 这是 Codeg 最强的设计：

```typescript
/**
 * Transport that the desktop client uses when a window is bound to a
 * remote codeg-server. Every HTTP call and WebSocket event is routed
 * through Rust commands (`remote_http_call`, `remote_ws_subscribe`,
 * `remote_ws_unsubscribe`) defined in `src-tauri/src/commands/remote_proxy.rs`.
 *
 * We never open a fetch or WebSocket from the webview directly: the Tauri
 * webview is a secure context, so plain `http://` / `ws://` connections
 */
```

也就是说，**桌面客户端可以绑定远程 server**，所有 API/WS 都通过 Rust 中转（绕过 webview 的 mixed-content 限制）。后端是 `src-tauri/src/commands/remote_proxy.rs`（2311 行），核心要点：

- **隔离合同**（`remote_proxy.rs:13-24`）：
  - 不同 `connection_id` 用独立的 Tauri event channel (`remote-ws-event-{id}`) 和独立的 background WS 任务
  - 多个 webview 共享一条 WS，但每个事件只分发给明确订阅的 webview label
  - 从不 `app.emit(...)` 全局广播——一律用 `app.emit_to(EventTarget::webview(label), ...)`
- **认证**：`sec-websocket-protocol` header 带 `codeg-token.{base64url}`（必须和 `web/auth.rs` 与 `lib/transport/ws-auth.ts` 完全一致）
- **重连**：`WS_RECONNECT_FAIL_THRESHOLD = 3`，指数退避 1s/2s/4s/8s/16s/32s

### 1.3 AionUi 怎么做：进程拆分 + Bridge 双后端

AionUi 的实现路径不同——它**没有共享核心代码**，而是把"web host"能力**从 Electron 主进程中剥离**到一个独立的 package `packages/web-host/`。

**包结构**：

```
packages/
├── web-host/         # 零 Electron 依赖的 web 服务化能力
│   ├── backend-launcher.ts   # spawn 或复用 aioncore 进程
│   ├── static-server.ts      # SPA 静态服务 + /api 和 /ws 反向代理
│   ├── agent-process-registry.ts
│   └── types.ts
├── web-cli/          # Bun 编译的 CLI（`aionui-web` 单文件二进制）
│   ├── bin/aionui-web.js
│   └── src/{index,browser,ensureAdminPassword}.ts
└── desktop/          # Electron 桌面（仅窗口管理 + IPC 桥接 + 系统能力）
    └── src/{process,preload,renderer,common}
```

**`web-host/src/index.ts`**（79 行）—— 整个 web 化的入口：

```typescript
export async function startWebHost(opts: WebHostOptions): Promise<WebHostHandle> {
  // 1. 启动后端（aioncore 子进程 or 复用现有）
  const backendHandle = opts.backend.kind === 'ownBackend'
    ? await startBackend({ ... })
    : { port: opts.backend.port, stop: async () => {} };

  // 2. 启动静态服务（SPA + 反向代理 /api /ws）
  const staticHandle = await startStaticServer({ ... });

  return { port, backendPort, url, localUrl, networkUrl, ... }
}
```

**Electron 主进程只是 web-host 的"另一种启动方式"**（`desktop/src/index.ts:30-37`）：

```typescript
import { startWebHost } from '@aionui/web-host';
// ...
const handle = await startWebHost({
  app: { version, isPackaged, resourcesPath, userDataPath },
  staticDir: '/path/to/out/renderer',
  backend: {
    kind: 'ownBackend',
    resolveBackend: () => '/path/to/aioncore',
  },
});
```

**前端配套：bridge.adapter 抽象**（`desktop/src/common/adapter/main.ts:39-98`）：

```typescript
bridge.adapter({
  emit(name, data) {
    // 1. 发送到所有 Electron BrowserWindows
    for (let i = adapterWindowList.length - 1; i >= 0; i--) {
      const win = adapterWindowList[i];
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(ADAPTER_BRIDGE_EVENT_KEY, serialized);
      }
    }
    // 2. 同时广播到所有 WebSocket 客户端
    broadcastToAll(name, data);
  },
  on(emitter) {
    setBridgeEmitter(emitter);
    ipcMain.handle(ADAPTER_BRIDGE_EVENT_KEY, (_event, info) => {
      const { name, data } = JSON.parse(info);
      return emitter.emit(name, data);
    });
  },
});
```

**`ipcBridge.ts`（2011 行）—— 这是 AionUi 的灵魂文件**：

```typescript
/**
 * IPC Bridge → HTTP/WS adapter.
 *
 * This file replaces the original IPC bridge calls with HTTP REST and WebSocket
 * calls routed to aioncore. Electron-native operations (window controls,
 * native dialogs, auto-update, devtools, zoom, CDP, deep links) remain as IPC.
 */
```

也就是说：**`ipcBridge.conversation.create.invoke(...)` 这套 API 在 Electron 模式下走 IPC，在 Web 模式下走 HTTP/WS，业务代码完全无感**。

**Bun 单文件二进制打包**（`web-cli/bin/aionui-web.js` + `scripts/pack-web-cli.js`）：

```typescript
// web-cli/src/index.ts:47-50
const isPackaged = (() => {
  const exeName = path.basename(process.execPath).toLowerCase();
  return exeName === 'aionui-web' || exeName === 'aionui-web.exe';
})();
```

打包后 `tarball layout`：
```
aionui-web/
├── aionui-web              ← bun-compiled standalone binary
├── package.json
├── bundled-aioncore/<plat-arch>/aioncore[.exe]
└── static/                  ← SPA assets
```

### 1.4 两项目架构对比

| 维度 | Codeg | AionUi |
|------|-------|--------|
| **核心抽象** | Cargo feature flags + `EventEmitter` 枚举 | 独立 `web-host` package + `bridge.adapter` |
| **代码共享机制** | 编译期（同一份代码，feature gating） | 运行时（不同进程，依赖同一 package） |
| **远程桌面支持** | ✅ 一等公民（`remote_proxy.rs`，2311 行） | ⚠️ 仅 CLI 启动（`bun run webui:remote`） |
| **Web 模式启动** | `codeg-server` 二进制 | `aionui-web` Bun 单文件二进制 |
| **数据目录隔离** | 同进程，无冲突 | 显式分离 `~/.aionui` vs `~/.aionui-web`（防 symlink 冲突） |
| **IPC 协议** | Transport 抽象（4 个实现） | `bridge.adapter` + `ipcBridge.ts`（2011 行） |
| **前端打包** | Next.js 16 静态导出 | electron-vite 输出 `out/renderer/` |
| **可服务化程度** | ⭐⭐⭐⭐⭐（远程桌面 + 服务端） | ⭐⭐⭐⭐（CLI + 服务化） |

### 1.5 AgeWork 当前状况与改进建议

**现状**：

| 端 | 已实现 | 缺什么 |
|----|--------|--------|
| Web | ✅ `apps/web`（React + Vite） | 远程 server 模式（现在要靠 `pnpm start` 跑 Node） |
| Desktop | ⚠️ `apps/desktop`（Electron 壳） | 是否能直接绑定远程 server？ |
| API | ✅ `apps/api`（NestJS） | 桌面模式 vs server 模式的代码分支 |
| Worker | ✅ `apps/worker`（独立进程） | 桌面内嵌 vs 远程调用的统一抽象 |

**建议（按优先级）**：

#### 1.5.1 [P0] 把 `apps/api` 打包成可独立启动的二进制（参考 AionUi `aionui-web`）

**重要前提纠正**（感谢用户指出）：AionUi **不是没有 web API**——它有独立的 `aioncore` 后端进程（`package.json:266` 声明 `aioncoreVersion: v0.1.37`），暴露 `/api/auth/status`、`/api/shell/open-file`、`/ws`、`/api/stt/stream` 等端点。`web-host` 的 `static-server.ts:4` 注释明确说它"reverse-proxies /api/*, /ws, /api/stt/stream"到 aioncore。`ipcBridge.ts` 底层用 `httpGet` / `httpPost` / `httpRequest` 调后端。

**架构对比**：

| 项目 | 业务后端位置 | 客户端/服务端的"壳" |
|------|-------------|---------------------|
| **Codeg** | 一个 Rust 进程 + feature flags 切换桌面/server | 同进程 |
| **AionUi** | aioncore（独立后端进程） | aionui-web / Electron 都是壳 |
| **AgeWork** | `apps/api`（NestJS） | `apps/desktop`（Electron 壳） |

**AgeWork 的天然优势**：`apps/api` 已经是独立 HTTP/WS 服务，**不需要抽离 server-core**。

**真正的问题**：当前 `apps/api` 用 `pnpm start` 启动是 Node.js 进程，**部署时需要 Node.js 运行时**。Electron desktop 想内嵌后端避免用户启动两个进程时也面临同样问题。

**建议方案**：参考 AionUi 的 `aionui-web` 单文件二进制方案，把 `apps/api` 打包成可独立启动的二进制。

```
打包前：pnpm start:api → Node.js + ts-node + NestJS
打包后：./agework-server (单文件二进制，~50MB)
        - 内嵌 Node.js 运行时（Bun/NodeSEA/Nexe）
        - 内嵌编译后的 JS
        - 用户双击即可启动 server
```

可选工具：
- **`@yao-pkg/pkg`**（推荐，已成熟）—— 打包成单文件二进制
- **`nexe`** —— 类似方案
- **`bun build --compile`**（参考 AionUi）—— Bun 内置，但要求业务代码能跑在 Bun 上（AgeWork 用 Prisma + better-sqlite3，需要验证兼容性）
- **Spring Native 思路**（GraalVM）—— 重，不推荐

涉及文件：
- `apps/api/` —— NestJS 入口
- `scripts/build-server.mjs` —— 新增打包脚本
- `apps/desktop/src/main/startup.ts` —— 启动逻辑改用单文件二进制（如果有内嵌需求）

**为什么不是抽离 server-core**：

`apps/api` 已经是纯 NestJS，没有 GUI 依赖（不像 Codeg 一个 Rust 进程同时跑 GUI + API）。所以 AgeWork 的"客户端/服务端双支持"**更接近 AionUi 模式**（独立后端 + 不同壳），而不是 Codeg 模式（一个进程 + feature flag）。

**唯一需要抽离的场景**：如果 `apps/worker` 想直接调用 `apps/api` 的业务函数（绕过 HTTP）—— 这种情况下，把 `apps/api/src/` 里的纯业务函数（无 NestJS 装饰器）抽到 `packages/server-core/` 是合理的。但这跟"客户端/服务端"无关，是"worker 与 API 共享代码"的问题。

#### 1.5.2 [P0] 统一 EventEmitter 抽象

参考 Codeg 的 `EventEmitter` 枚举：

```typescript
// packages/server-core/src/common/event-emitter.ts
export type DomainEvent =
  | { kind: 'workspace.created'; workspaceId: string; userId: string }
  | { kind: 'run.started'; runId: string; conversationId: string }
  | { kind: 'run.tool_call'; runId: string; toolCallId: string; toolName: string }
  | { kind: 'message.delta'; runId: string; messageId: string; delta: string }
  // ...

export interface EventSink {
  emit(event: DomainEvent): Promise<void>;
}

export class LocalEventBus implements EventSink {
  // 进程内 broadcast（emitter 订阅 + emit）
}

export class HttpEventSink implements EventSink {
  // 转发到远端 server（HTTP POST /events）
}

export class WebSocketEventSink implements EventSink {
  // 包装 WS 推送
}
```

**关键原则**：业务层永远调用 `eventBus.emit(event)`，**不关心**事件的去向。

#### 1.5.3 [P1] Desktop 远程连接模式

参考 Codeg `remote_proxy.rs` 的设计，但 AgeWork 用 Electron 而非 Tauri，所以**不用 Rust 中转**，而是让 renderer 直接走 HTTP/WS，但要注意：

- 远程 server 必须是 HTTPS/WSS（或内网）
- 认证 token 单独走（参考 Codeg 的 `codeg-token.{base64url}` via `sec-websocket-protocol`）
- 断连时调用 `waitForReady()` 兜底（防止 receiver_count=0 期间丢事件）

**前端实现**（`apps/web/src/lib/transport/index.ts`）：

```typescript
type AgeworkMode = 'local' | 'remote';

interface RemoteConfig {
  baseUrl: string;       // e.g. "https://agework.acme.internal"
  token: string;         // JWT or service token
}

export function createTransport(mode: AgeworkMode, config?: RemoteConfig): Transport {
  if (mode === 'remote') {
    return new RemoteTransport(config!);
  }
  return new LocalTransport();  // 同源，相对路径
}
```

**环境检测**：

```typescript
// 编译时注入
declare const __AGEWORK_MODE__: 'local' | 'remote';
declare const __AGEWORK_REMOTE_CONFIG__: RemoteConfig | null;

export const mode: AgeworkMode = __AGEWORK_MODE__;
```

Vite 的 `define` 可以做这个：
```ts
// vite.config.ts
define: {
  __AGEWORK_MODE__: JSON.stringify(process.env.AGEWORK_MODE || 'local'),
  __AGEWORK_REMOTE_CONFIG__: JSON.stringify(
    process.env.AGEWORK_REMOTE_URL
      ? { baseUrl: process.env.AGEWORK_REMOTE_URL, token: process.env.AGEWORK_REMOTE_TOKEN }
      : null
  ),
}
```

#### 1.5.4 [P1] 数据目录隔离

参考 AionUi 的 `~/.aionui-web` vs `~/.aionui` 教训：

| 模式 | 数据目录 |
|------|----------|
| Local (Electron) | `app.getPath('userData')` |
| Local Web (pnpm start) | `~/.agework-local` |
| Remote Web (内嵌在桌面) | `~/.agework` (Electron) |
| Remote (浏览器访问 server) | 服务端控制，建议 env 注入 |

**关键原则**：**绝不让多个模式共享默认数据目录**。必须显式隔离，否则会引发 symlink 冲突 / 数据覆盖。

#### 1.5.5 [P2] Docker 镜像统一

参考 Codeg 的 `docker-compose.yml`，AgeWork 可以统一发布三个镜像：

```yaml
# docker-compose.yml
services:
  api:        # NestJS API
    image: agework/api:latest
  worker:     # Agent runtime
    image: agework/worker:latest
  web:        # 静态前端（nginx）
    image: agework/web:latest
  opensandbox: # 沙箱服务
    image: agework/opensandbox:latest
```

部署时通过环境变量（`AGEWORK_MODE=server` / `AGEWORK_MODE=worker`）切换。

---

## 二、多 Agent 支持架构

### 2.1 两种范式对比

| 范式 | 项目 | 核心抽象 | 适用场景 |
|------|------|----------|----------|
| **MCP 委派** | Codeg | `delegate_to_agent` MCP tool + 伴生进程 `codeg-mcp` | agent 间 function-call 式调用，异步一次性 |
| **Team 编排** | AionUi | `TTeam` + `TeamAssistant[]` + Leader 角色 | 长期持久化的多 agent 团队 |

**AgeWork 现状**：无多 agent。`apps/api/src/agent/agent.service.ts` 直接调用单个 adapter。

### 2.2 Codeg 的 MCP 委派范式

**架构图**（`src-tauri/src/acp/delegation/mod.rs:8-32`）：

```
parent LLM ─┐
            │ ToolUse(delegate_to_agent, ...)
            ▼
parent CLI ──stdio──► codeg-mcp (per-launch companion binary)
                          │
                          │ UDS / named pipe (token-authed)
                          ▼
                DelegationBroker (this module)
                          │
                          │ ConnectionSpawner trait
                          ▼
                ConnectionManager.spawn_agent / send_prompt_linked
                          │
                          ▼
                child ACP session  ── TurnComplete ──┐
                                                     │
parent LLM ◄── MCP tool_result ◄── DelegationOutcome ◄───┘
```

**关键设计**：

1. **伴生进程 `codeg-mcp`**：被注入到主 agent CLI 的 MCP 配置中。LLM 调用 `delegate_to_agent` tool 时，parent CLI 通过 stdio 把请求转发到 codeg-mcp。
2. **UDS / 命名管道通信**：codeg-mcp 通过 Unix Domain Socket（Windows 是命名管道）和父 codeg 进程通信，token 鉴权。
3. **一次性 function-call 语义**（v1）：子 agent 第一个 TurnComplete 后，broker resolve pending call，发送 `disconnect`，返回结果。v2 将引入 `continue_with_session` / `close_session` tools，**不破坏协议**。
4. **depth 限制**（`acp/delegation/depth.rs`，103 行）—— 防止无限递归：

```rust
pub async fn compute_depth<F, Fut>(
    start: i32,
    mut parent_resolver: F,
    cap: u32,
) -> Result<u32, DelegationError>
where
    F: FnMut(i32) -> Fut,
    Fut: Future<Output = Result<Option<i32>, DelegationError>>,
{
    let mut current = start;
    let mut depth = 0u32;
    while depth < cap {
        match parent_resolver(current).await? {
            None => return Ok(depth),
            Some(parent) => { current = parent; depth += 1; }
        }
    }
    Ok(depth)
}
```

注释特别说："`cap` saturates the walk so a corrupted chain (cycle, deep history) can't cause unbounded DB load."

5. **parent_watcher 自清理**（`acp/delegation/parent_watcher.rs`，144 行）—— Windows 上子进程不会随父进程死，Unix 上中间进程僵死会留下孤儿 codeg-mcp：

```rust
// 关键注释：
//! When the parent codeg / codeg-server passes `--parent-pid <pid>` on
//! the command line, `codeg-mcp` spawns this watchdog. It polls the OS
//! every couple of seconds and, the moment the parent PID stops existing,
//! tears down the process.
```

每 2 秒轮询（默认），父进程死了立刻 `process::exit`。Unix 用 `kill(pid, 0)` 探测，Windows 用 `OpenProcess + GetExitCodeProcess`。

6. **完整子模块**（`delegation/` 总计 13784 行）：

| 文件 | 行数 | 职责 |
|------|------|------|
| `broker.rs` | 7554 | 核心 broker：受理委派、wait child、resolve pending call |
| `companion.rs` | 2202 | `codeg-mcp` 伴生进程的 stdio 协议 |
| `transport.rs` | 590 | 父子进程 UDS 通信 |
| `spawner.rs` | 320 | spawn 子 agent 的 trait |
| `event_emitter.rs` | 277 | 把子 agent 事件转发给父 LLM |
| `meta_writer.rs` | 288 | 元数据持久化（parent_id / child_id） |
| `types.rs` | 232 | 类型定义 |
| `depth.rs` | 103 | 递归深度限制 |
| `parent_watcher.rs` | 144 | 父进程死亡自清理 |
| `live_reply.rs` | 94 | 实时回传子 agent 输出 |

7. **前端 sub-agent overlay**（`src/components/chat/sub-agent-overlay.tsx`，201 行）—— 把子 agent 列表显示为内联面板，可点击跳转到子会话：

```typescript
// 显示在主回复旁边的"子 agent 列表"面板
// 点击行 → 打开 SubAgentSessionDialog → 跳转子会话
<SubAgentOverlay delegations={delegations} overlayKey={msgId} />
```

### 2.3 AionUi 的 Team 编排范式

**核心类型**（`packages/desktop/src/common/types/team/teamTypes.ts`，230 行）：

```typescript
export type TeammateRole = 'leader' | 'teammate';
export type WorkspaceMode = 'shared' | 'isolated';

export type TeamAssistant = {
  slot_id: string;
  conversation_id: string;
  role: TeammateRole;
  assistant_backend: string;     // 可以是不同后端的 agent
  assistant_name: string;
  status: 'pending' | 'idle' | 'active' | 'completed' | 'failed';
  pending_confirmations?: number;
  // ...
};

export type TTeam = {
  id: string;
  user_id: string;
  name: string;
  workspace: string;
  workspace_mode: WorkspaceMode;     // shared / isolated
  leader_assistant_id: string;
  assistants: TeamAssistant[];
  session_mode?: string;             // 当前权限模式（plan / auto），新 spawn 的 agent 继承
  // ...
};
```

**关键设计**：

1. **持久化 Team 实体**：Team 不是临时任务，是 SQLite `teams` 表里的真实记录，跨会话持续。
2. **每个 Teammate 有独立 conversation**：通过 `slot_id` 关联到 team，可以是不同后端的 agent。
3. **Workspace 共享/隔离**：`shared`（所有 teammate 操作同一目录）或 `isolated`（每个 teammate 独立工作区）。
4. **权限传播**：`session_mode` 持久化到 team，新 spawn 的 agent 自动继承。
5. **消息归属**：`IMessageText` 增加 `teammateMessage` / `senderName` / `senderAgentType` / `senderConversationId` 字段，UI 可以区分消息来自哪个 teammate。

**事件系统**（`teamTypes.ts:100-230`）：

```typescript
// 18+ 团队相关事件
ITeamCreatedEvent | ITeamRemovedEvent | ITeamRenamedEvent
| ITeamListChangedEvent | ITeamAgentSpawnedEvent | ITeamAgentRemovedEvent
| ITeamAgentRenamedEvent | ITeamAgentStatusEvent
| ITeamRunEvent | ITeamRunAck | ITeamTeammateMessageEvent
| ITeamChildTurnEvent | ICancelTeamChildTurnParams
| ITeamSessionChangedEvent | ITeamTaskChangedEvent | ITeamMcpStatusEvent
| IPauseTeamSlotParams
```

**SlotWork 状态**：

```typescript
export type ITeamSlotWork = {
  slot_id: string;
  role: 'lead' | 'teammate';
  pending_wake_count: number;        // 待唤醒数
  starting_child_count: number;      // 正在启动的子 agent 数
  paused?: boolean;                  // 用户暂停
  suppressed_wake_count?: number;    // 压制的唤醒数
  active_turn_id?: string;
  active_turn_started_at_ms?: number;
  active_turn_elapsed_ms?: number;
  active_turn_slow?: boolean;        // 慢任务检测
  active_turn_slow_threshold_ms?: number;
  runtime_health?: 'disconnected' | 'unhealthy';
};
```

**UI 实现**（`packages/desktop/src/renderer/pages/team/`，20+ 文件，1209 行 +）：

- `TeamPage.tsx`（597 行）—— Team 主页，水平 Tab 切换不同 assistant
- `TeamTabs.tsx` —— Tab 组件（Leader 永远在第一个，可拖拽排序）
- `TeamChatView.tsx` —— 单个 teammate 的聊天视图
- `TeamAgentIdentity.tsx` —— Agent 头部（图标 + 名字 + 角色）
- `TeamCreateModal.tsx` —— 创建 Team 对话框（选择 Leader + 添加 Teammate）
- `useTeamRunView.ts` —— Team run 状态聚合
- `useTeamPendingPermissions.ts` —— 权限待确认数
- `useTeamSession.ts` —— Team 会话管理
- `useSiderTeamBadges.ts` —— Sidebar 上的 Team 徽章

**E2E 测试覆盖**（`tests/e2e/cases/teams/`，10+ 文件）：

- `team-create.e2e.ts` —— 创建流程
- `team-agent-lifecycle.e2e.ts` —— Agent 生命周期
- `team-whitelist.e2e.ts` —— 白名单（防止意外 agent 加入）
- `team-communication.e2e.ts` —— Agent 间通信
- `team-workspace-migration.e2e.ts` —— Workspace 隔离/共享切换
- `team-view-modes.e2e.ts` —— 单视图/全屏切换
- `team-name-validation.e2e.ts` —— 名字校验

### 2.4 两范式核心区别

| 维度 | Codeg MCP 委派 | AionUi Team 编排 |
|------|----------------|------------------|
| **生命周期** | 临时（一次性） | 持久（数据库实体） |
| **触发方式** | LLM 工具调用 | 用户手动创建 + 配置 |
| **Agent 关系** | 父子（depth 限制） | 对等（Leader 是协调者） |
| **Workspace** | 继承父 | shared / isolated 可选 |
| **通信** | child → parent（结果回传） | teammate ↔ teammate（共享 team run 状态） |
| **后端架构** | 伴生进程 + UDS 通信 | SQLite 持久化 + WebSocket 事件 |
| **前端** | 嵌入式 overlay（sub-agent-overlay） | 独立 TeamPage（597 行） |
| **权限** | 继承父 | 独立 + 传播 |

### 2.5 AgeWork 建议

AgeWork 的 `apps/worker` 已经独立，可以两条路都走：

#### 2.5.1 [P0] Worker 间 MCP 委派（短期）

参考 Codeg 的 `codeg-mcp` 思路，但用 WebSocket 替代 UDS（AgeWork 是跨进程跨主机）：

```
Worker A (parent)
  ├─ spawn Worker B (child) via WS
  ├─ receive child events via WS
  └─ return aggregated result to API
```

**最小可实施**：

```typescript
// apps/worker/src/delegation/broker.ts
interface DelegationRequest {
  parentRunId: string;
  parentConversationId: string;
  childAgentType: string;
  childWorkspaceId: string;
  childPrompt: string;
  maxDepth: number;     // 默认 3
}

interface DelegationResult {
  childRunId: string;
  childConversationId: string;
  finalMessage: string;
  status: 'completed' | 'failed' | 'timeout';
}
```

API 层加一个 `/agents/delegate` 端点，worker 接到后内部 spawn 子 worker，await 结果。

**关键控制**：
- `maxDepth` 默认 3（防无限嵌套）
- parent worker 死了 → child worker 也停（定期检查 parent 心跳）
- 子 worker 完成后立刻清理（释放 sandbox runtime）

#### 2.5.2 [P1] Team 模式（中期）

参考 AionUi 的 `TTeam` / `TeamAssistant` 设计，扩展 AgeWork 数据模型：

```prisma
// packages/api/prisma/schema.prisma
model Team {
  id              String   @id @default(cuid())
  workspaceId     String
  name            String
  workspaceMode   String   // 'shared' | 'isolated'
  sessionMode     String?  // 'plan' | 'auto'
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  leaderSlotId    String?
  members         TeamMember[]
}

model TeamMember {
  id              String   @id @default(cuid())
  teamId          String
  slotId          String   // 对话框 ID
  role            String   // 'leader' | 'teammate'
  agentType       String
  agentConfig     Json     // { model, provider, ... }
  status          String   // 'pending' | 'idle' | 'active' | 'completed' | 'failed'
  pendingConfirms Int      @default(0)
  
  team            Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
  conversation    Conversation @relation(fields: [slotId], references: [id])
}
```

**关键 API**：
- `POST /api/teams` —— 创建 Team
- `POST /api/teams/:id/members` —— 添加 Teammate
- `POST /api/teams/:id/run` —— 发起 Team run（向 Leader 发送消息）
- `WS /api/teams/:id/events` —— 订阅 Team 事件流

**关键前端**：
- `TeamPage`（`/teams/:id` 路由）—— 水平 Tab + ChatView
- Team 创建 Modal（选择 Leader + 添加 Teammate）
- 共享/隔离 workspace 切换 UI

#### 2.5.3 [P2] MCP 委派的 LLM Tool 化（远期）

把 worker 间委派包装为 MCP tool，让主 agent 在对话中**自己决定**要不要委派子 agent：

```typescript
// packages/shared/src/tools/delegate-to-agent.ts
export const delegateToAgentTool: Tool = {
  name: 'delegate_to_agent',
  description: 'Delegate a subtask to a sub-agent (Claude / Codex / ...). Returns the sub-agent\'s final answer.',
  parameters: {
    type: 'object',
    properties: {
      agent_type: { type: 'string', enum: ['claude_code', 'codex', ...] },
      task: { type: 'string' },
      workspace_id: { type: 'string' },
      max_depth: { type: 'number', default: 3 },
    },
    required: ['agent_type', 'task'],
  },
}
```

注册到 `packages/adapters/` 的各 SDK 中，agent 调用时通过 `worker.delegate()` 触发。

---

## 三、AgeWork 暂未实现的能力清单

> 按"用户已经在产品定位中提到 / 两项目都已成熟实现"为筛选标准。每条给出：
> - **Codeg 实现**（具体文件 + 行数）
> - **AionUi 实现**（具体文件 + 行数）
> - **AgeWork 建议**（最小可实施版本）

### 3.1 客户端/服务端相关

#### A1. 远程桌面（绑定远程 server）

- **Codeg**：`src/lib/transport/remote-desktop-transport.ts`（436 行） + `src-tauri/src/commands/remote_proxy.rs`（2311 行）
- **AionUi**：仅 CLI 启动（`bun run webui:remote`），无桌面绑定远程 server 模式
- **AgeWork 建议**：
  - 短期：Electron desktop 通过 `AGEWORK_REMOTE_URL` + `AGEWORK_REMOTE_TOKEN` 环境变量绑定远程 server
  - 中期：参考 Codeg `remote_proxy.rs` 的隔离合同（per-connection 独立 WS）
  - 涉及文件：`apps/desktop/src/main/`, `apps/web/src/lib/transport/`

#### A2. 单文件可执行 CLI（`aionui-web`）

- **Codeg**：`codeg-server` 是独立二进制
- **AionUi**：`packages/web-cli/bin/aionui-web.js` + `bun build --compile` 单文件打包
- **AgeWork 建议**：
  - 短期：`pnpm dlx agework-server` 启动 server
  - 中期：参考 AionUi 打包成 `agework-server` Bun 单文件二进制
  - 涉及文件：`apps/api/`, `scripts/pack-server.mjs`

#### A3. Tunnel（公网访问本地 server）

- **Codeg**：内置（`codeg` 桌面模式自动生成二维码）
- **AionUi**：内置（`bun run webui:remote` 时 `AIONUI_HOST=0.0.0.0`）
- **AgeWork 建议**：
  - 短期：文档说明 `AGEWORK_HOST=0.0.0.0` + 防火墙
  - 中期：集成 cloudflared / ngrok tunnel，提供 `pnpm agework tunnel` 命令
  - 涉及文件：`docs/usage.md`, `scripts/tunnel.mjs`

### 3.2 多 Agent 相关

#### B1. Team 模式（持久化多 agent 团队）

- **Codeg**：无（只有 MCP 委派）
- **AionUi**：`packages/desktop/src/renderer/pages/team/`（20+ 文件） + `tests/e2e/cases/teams/`（10+ 文件）
- **AgeWork 建议**：参考 §2.5.2 实现 Team 模式

#### B2. Agent 间委派（MCP-style）

- **Codeg**：`src-tauri/src/acp/delegation/`（13784 行）
- **AionUi**：无（MCP 协议层面支持，但没实现）
- **AgeWork 建议**：参考 §2.5.1 实现 worker 间委派

#### B3. Agent 全自动模式（YOLO）

- **Codeg**：每个 agent 有自己的 YOLO 模式（claude_code → `bypassPermissions`，codex → `CODEX_MODE_NATIVE_FULL_ACCESS`，gemini → `yolo`）
- **AionUi**：`FULL_AUTO_MODE: Record<string, string>` 映射
- **AgeWork 建议**：
  - `apps/api/src/agent/agent.service.ts` 增加 `yoloMode` 字段
  - `apps/web/src/components/settings/` 增加 UI

#### B4. Agent 间消息归属显示

- **Codeg**：`message` 中带 `fromAgent` / `toAgent` 字段
- **AionUi**：`IMessageText` 带 `teammateMessage` / `senderName` / `senderAgentType` / `senderConversationId`
- **AgeWork 建议**：
  - 短期：`message.metadata` 扩展 `senderAgentType` / `senderSlotId`
  - 涉及文件：`packages/shared/src/types/`

### 3.3 自动化相关

#### C1. 定时任务（Cron）

- **Codeg**：`src-tauri/src/automation/engine.rs`（1079 行） + `src/components/automations/automations-page.tsx`（1209 行）
- **AionUi**：`croner` npm 包 + i18n `cron.json`（11 语言）
- **AgeWork 建议**：
  - 后端：`apps/api/src/scheduler/` 用 `@nestjs/schedule`
  - 调度：每个 Workspace 可注册 cron 任务，绑定到 conversation 或 team
  - 涉及文件：`apps/api/src/scheduler/`, `apps/web/src/pages/scheduler/`

#### C2. Automation 引擎（fire / reconcile / prune 三段式）

- **Codeg**：`src-tauri/src/automation/engine.rs` 完整三段式
  - `MAX_RUN_MINUTES = 180`（失控 run 强制失败）
  - `RECONCILE_INTERVAL_SECS = 30`（reconcile 周期）
  - `SCHEDULER_INTERVAL_SECS = 30`（cron 调度周期）
  - `PRUNE_INTERVAL_SECS = 6 * 60 * 60`（6h 清理）
  - `RUN_RETENTION_DAYS = 30`
- **AionUi**：仅基础 cron，无 reconcile / prune
- **AgeWork 建议**：直接参考 Codeg 实现，需要数据库 + 后台 worker

#### C3. Automation 模板（开箱即用）

- **Codeg**：`src/components/automations/automation-templates.ts`（内置 6-8 个模板）
- **AionUi**：无模板
- **AgeWork 建议**：参考 Codeg 内置 4-6 个模板（每日构建跑通测试 / 定期备份 / 定时同步等）

#### C4. Automation run history

- **Codeg**：`automations-page.tsx` 有完整的 run history 面板（成功 / 失败 / 取消 / 跳过 状态 + 持续时间 + 触发时间）
- **AionUi**：无 run history 面板
- **AgeWork 建议**：在 scheduler 表加 `runs` 子表

### 3.4 权限 / 安全

#### D1. 权限确认（always / once / reject always / reject once）

- **Codeg**：`src/components/chat/permission-dialog.tsx`（8089 字节，结构化选项）
- **AionUi**：ACP `AcpPermissionRequest` 类型（`option_id` + `kind`）
- **AgeWork 建议**：
  - 短期：基础弹窗（确认 / 拒绝）
  - 中期：增加"始终允许"记忆（按 tool 类型 + agent 维度）
  - 涉及文件：`apps/api/src/permission/`, `apps/web/src/components/permission/`

#### D2. Approval 记忆

- **Codeg**：`ApprovalStore` 持久化"始终允许"决策
- **AionUi**：同样
- **AgeWork 建议**：
  - 数据库表：`permission_allowlist (tool_name, agent_type, scope, expires_at)`
  - 涉及文件：`apps/api/prisma/schema.prisma`

#### D3. Team 级别权限策略

- **Codeg**：`propagateMode()` 把 session_mode 持久化到 team
- **AionUi**：`TTeam.session_mode` 字段
- **AgeWork 建议**：在 Team 数据模型加 `permissionPolicy` 字段

### 3.5 UI / UX

#### E1. 消息合并引擎（流式场景 O(1) 合并）

- **Codeg**：`src/lib/message-composer.ts`（参考 AionUi 报告）
- **AionUi**：`composeMessageWithIndex()` 用 `WeakMap` 缓存索引
- **AgeWork 建议**：
  - `packages/react-ag-ui/src/composer/` 实现
  - 用 `WeakMap<msgId, index>` 缓存

#### E2. Agent Plan Overlay（任务清单显示）

- **Codeg**：`src/components/chat/agent-plan-overlay.tsx`（7620 字节）
- **AionUi**：支持 `PlanUpdate` 事件
- **AgeWork 建议**：
  - 短期：AG-UI `STEP_STARTED` / `STEP_FINISHED` 渲染为进度条
  - 中期：增加 plan entries（pending / in_progress / completed 状态）

#### E3. Sub-agent Overlay（子 agent 列表）

- **Codeg**：`src/components/chat/sub-agent-overlay.tsx`（201 行）
- **AionUi**：TeamTabs
- **AgeWork 建议**：参考 §2.5.1 实现

#### E4. 文件预览面板（Markdown / Code / Diff / Image）

- **Codeg**：`src/components/files/`, `src/components/diff/`, `src/components/ai-elements/`
- **AionUi**：10 种内容类型（Markdown / Diff / Code / PDF / PPT/Word/Excel / Image / HTML / URL）
- **AgeWork 建议**：
  - 短期：Markdown + Code（Monaco）+ Diff（diff2html）
  - 中期：Image 预览 + 实时刷新（agent 写文件时自动 reload）
  - 涉及文件：`apps/web/src/components/preview/`

#### E5. 三栏合并编辑器

- **Codeg**：`src/components/merge/three-pane-merge-editor.tsx` + `merge-diff.ts` + `conflict-parser.ts`
- **AionUi**：无
- **AgeWork 建议**：仅在 git worktree 模式需要时实现

#### E6. 快捷命令（Slash Commands）

- **Codeg**：`src/components/chat/slash-command-menu.tsx`（1554 字节）+ `src-tauri/src/acp/slash_commands/` 13 个命令
- **AionUi**：`AcpSlashCommandApiItem` 类型（运行时从 agent 拉取）
- **AgeWork 建议**：
  - 短期：内置 5-6 个命令（/clear, /compact, /model, /help, /exit）
  - 中期：从 MCP 工具动态拉取

### 3.6 平台集成

#### F1. 飞书 / 钉钉 / Telegram / 微信 / Slack 通知

- **Codeg**：`src-tauri/src/chat_channel/backends/{lark,telegram,weixin}.rs` + `event_subscriber.rs`（65 KB） + `i18n.rs`（71 KB）
- **AionUi**：`@larksuiteoapi/node-sdk` + `dingtalk-stream` + `grammy`（Telegram）+ `@wecom/aibot-node-sdk`（企业微信）
- **AgeWork 建议**：
  - 短期：Webhook 出站（`apps/api/src/webhook/`，配置 URL + 签名校验）
  - 中期：飞书 + 钉钉（企业场景最常用）
  - 涉及文件：`apps/api/src/integrations/`

#### F2. 消息格式化（Agent 事件 → IM 友好格式）

- **Codeg**：`src-tauri/src/chat_channel/message_formatter.rs`（9 KB）
- **AionUi**：每个 channel 独立的 formatter
- **AgeWork 建议**：`apps/api/src/integrations/formatters/`

### 3.7 文档生成

#### G1. Office 文档生成（PPTX / DOCX / XLSX / PDF）

- **Codeg**：`src-tauri/src/office_watch/`（集成 officecli）+ `src-tauri/src/commands/office_tools.rs`（66 KB）
- **AionUi**：通过 OfficeCLI 集成；MCP skill `pptx` / `docx` / `xlsx`
- **AgeWork 建议**：
  - 后端：worker 集成 `pptxgenjs` / `docx` / `exceljs` / `puppeteer` (PDF)
  - 涉及文件：`apps/worker/src/office/`

#### G2. 实时文档预览（agent 写文件 → Web 端自动刷新）

- **Codeg**：WebSocket 推送 `fileStream.contentUpdate` 事件，500ms debounce
- **AionUi**：`fileStream.contentUpdate` 订阅 + 1 秒 mtime 轮询
- **AgeWork 建议**：
  - `apps/worker/src/file-watcher/`（chokidar 监听）
  - WebSocket 推送到 `apps/web/src/hooks/use-file-stream.ts`
  - 涉及文件：`apps/api/src/websocket/`, `apps/web/src/hooks/`

### 3.8 数据 / 配置

#### H1. 数据导入导出

- **Codeg**：`src-tauri/src/commands/backup/`（完整备份 / 恢复）
- **AionUi**：`examples/` 目录提供示例数据
- **AgeWork 建议**：
  - 短期：`apps/api/src/backup/` 提供 `/api/backup/export` 和 `/api/backup/import`
  - 涉及文件：`apps/api/src/backup/`

#### H2. 全局搜索（会话 / 消息 / 文件）

- **Codeg**：`src/components/conversations/search-command-dialog.tsx`（11.9 KB）
- **AionUi**：无显式搜索
- **AgeWork 建议**：
  - `apps/api/src/search/`（FTS5 全文检索）
  - `apps/web/src/components/search/`

#### H3. 会话分组 / 标签

- **Codeg**：`sidebar-conversation-grouping.ts`（20.6 KB，按时间 / 项目 / tag 分组）
- **AionUi**：Sidebar 显示
- **AgeWork 建议**：
  - 数据库：conversation 加 `tags: String[]` 字段
  - 涉及文件：`apps/api/prisma/schema.prisma`, `apps/web/src/components/sidebar/`

### 3.9 桌面相关

#### I1. 系统托盘 + 关闭到托盘

- **Codeg**：Tauri tray API
- **AionUi**：`packages/desktop/src/process/utils/tray.ts`
- **AgeWork 建议**：
  - `apps/desktop/src/main/tray.ts`
  - 设置页面加"关闭到托盘"开关

#### I2. 启动时单实例锁

- **Codeg**：Tauri `app.requestSingleInstanceLock()`
- **AionUi**：`app.requestSingleInstanceLock({ deepLinkUrl })`（含 deep link 转发）
- **AgeWork 建议**：
  - `apps/desktop/src/main/single-instance.ts`

#### I3. 全局快捷键

- **Codeg**：`src-tauri/src/web/keyboard_shortcuts.rs`（12 个全局快捷键）
- **AionUi**：无
- **AgeWork 建议**：
  - `apps/desktop/src/main/shortcuts.ts`（激活窗口 / 快速搜索 / 发送消息）

#### I4. 自动更新

- **Codeg**：`src-tauri/src/update/`（8 个文件，含 delta patch / 回滚）
- **AionUi**：`electron-updater` + `sentry`
- **AgeWork 建议**：
  - 短期：`electron-updater`
  - 中期：增量更新 + 灰度发布
  - 涉及文件：`apps/desktop/src/main/updater.ts`

#### I5. 桌面宠物 / 个性化

- **Codeg**：`src-tauri/src/pets/`（独立窗口 + preload 脚本）
- **AionUi**：桌面宠物（`resources/aionui-banner-1.png` 显眼位置）
- **AgeWork 建议**：**不实现**——AgeWork 定位是 Workbench，不是娱乐工具

### 3.10 可观测性

#### J1. 错误监控（Sentry）

- **Codeg**：Tauri Sentry 集成
- **AionUi**：`@sentry/electron`（含 main / preload / renderer）
- **AgeWork 建议**：
  - 短期：API 加 Sentry SDK
  - 涉及文件：`apps/api/src/main.ts`（初始化）

#### J2. 性能监控 / 基准测试

- **Codeg**：无显式
- **AionUi**：`scripts/benchmark-startup.ts` + `scripts/benchmark-acp-startup.ts`（共 65 KB 基准测试）
- **AgeWork 建议**：
  - `scripts/bench-startup.ts`（API / Web 启动时间）
  - `scripts/bench-run.ts`（典型 run 耗时分布）

#### J3. 审计日志

- **Codeg**：未明说（依赖 `app.log` + Sentry）
- **AionUi**：未明说
- **AgeWork 建议**（**重要**，团队场景必须）：
  - `apps/api/src/audit/`（所有 user action 落库：`who` / `what` / `when` / `where` / `result`）
  - 涉及文件：`apps/api/prisma/schema.prisma` 加 `AuditLog` 表

### 3.11 沙箱 / Runtime

#### K1. 沙箱超时配置

- **Codeg**：每个 agent session 有 timeout
- **AionUi**：`active_turn_slow_threshold_ms`（慢任务检测）
- **AgeWork 建议**：
  - `apps/api/src/runtime/instances/` 增加 `timeoutMs` / `slowThresholdMs` 配置

#### K2. Runtime 健康检查

- **Codeg**：`acp/idle_sweep.rs` 定期清理
- **AionUi**：`runtime_health: 'disconnected' | 'unhealthy'`
- **AgeWork 建议**：
  - `apps/api/src/runtime/instances/health.ts`（定期 ping / 资源使用监控）

### 3.12 部署 / DevOps

#### L1. 一键升级

- **Codeg**：`install.sh`（17 KB）/ `install.ps1`（13 KB）
- **AionUi**：`scripts/install-web.sh`（18 KB）/ `scripts/install-ubuntu.sh`（15 KB）
- **AgeWork 建议**：
  - `scripts/install.sh` 检测已安装版本，自动升级
  - 涉及文件：`scripts/`

#### L2. 健康检查端点

- **Codeg**：`/health` 端点（含 backend 启动检查）
- **AionUi**：`/health` 端点（端口探测）
- **AgeWork 建议**：
  - 短期：NestJS `@nestjs/terminus` 加 `/health` 端点
  - 中期：增加 DB / Worker / Sandbox 健康检查
  - 涉及文件：`apps/api/src/health/`

#### L3. 数据库迁移

- **Codeg**：`SeaORM` migration
- **AionUi**：`better-sqlite3` 直接 schema（无 migration）
- **AgeWork 现状**：`Prisma` migration（已实现）
- **可借鉴**：Codeg 的 `migration_service.rs` 提供运行时版本检查

### 3.13 国际化

#### M1. 多语言

- **Codeg**：10 种语言（i18n 71 KB）
- **AionUi**：11 种语言（locales/）
- **AgeWork 建议**：
  - 短期：现有 i18n 框架扩展
  - 涉及文件：`apps/web/src/i18n/`

#### M2. 翻译校验

- **Codeg**：`scripts/check-i18n.sh`（CI 检查缺失键）
- **AionUi**：`scripts/check-i18n.js`（11.9 KB）
- **AgeWork 建议**：
  - `scripts/check-i18n.mjs`（扫描所有用到的 key，对比 locale 文件）
  - 接入 CI

### 3.14 文档

#### N1. 文档站点

- **Codeg**：`docs/` 目录 + `docs/images/`
- **AionUi**：`docs/contributing/`, `docs/architecture/overview.md`
- **AgeWork 现状**：`docs/` 已有多份
- **可借鉴**：AionUi 的 `docs/architecture/overview.md`（架构图 + 进程边界）值得补充

---

## 四、综合实施建议

### 4.1 优先级总览

| 优先级 | 类别 | 关键能力 | 预计工作量 |
|--------|------|----------|------------|
| **P0** | 客户端/服务端 | `server-core` 抽离 + EventEmitter 抽象 | 2-3 周 |
| **P0** | 多 Agent | Worker 间委派（MCP 委派 v1） | 2 周 |
| **P0** | 沙箱 | 沙箱超时 + 健康检查 | 1 周 |
| **P1** | 客户端/服务端 | Desktop 远程连接模式 | 1-2 周 |
| **P1** | 多 Agent | Team 模式 | 3-4 周 |
| **P1** | 自动化 | Cron 任务 + Automation 引擎 | 2 周 |
| **P1** | 文档 | 实时文档预览（agent 写 → Web 刷新） | 1 周 |
| **P1** | 可观测性 | 审计日志 | 1 周 |
| **P2** | 平台集成 | 飞书 / 钉钉 通知 | 2 周 |
| **P2** | UI/UX | 消息合并引擎 + Sub-agent Overlay | 1-2 周 |
| **P3** | 文档生成 | Office 文档生成 | 3+ 周 |
| **P3** | 桌面 | 自动更新 / 全局快捷键 | 1-2 周 |

### 4.2 关键决策

| 决策点 | 建议 |
|--------|------|
| **客户端/服务端共享机制** | 参考 AionUi：抽离 `server-core` package（不是 Codeg 的 cargo feature，因为 AgeWork 是 TypeScript） |
| **多 Agent 范式** | 短期 MCP 委派（v1 一次性），长期 Team 模式（持久化） |
| **Cron 任务实现** | 参考 Codeg AutomationEngine 三段式（fire / reconcile / prune） |
| **远程桌面** | 短期：Electron 直接连远程 server（不需 Rust 中转），通过 `__AGEWORK_MODE__` 编译注入 |
| **数据目录隔离** | **必须**：4 个模式（Electron / Local Web / Remote Web / 浏览器）独立数据目录 |
| **协议标准化** | 继续用 AG-UI（不切换到 ACP，AG-UI 更标准化） |
| **不要做** | 桌面宠物、自动更新复杂灰度、Office 文档生成（除非明确产品需求） |

### 4.3 一句话总结

> **客户端/服务端双支持**是 AgeWork 团队化部署的前提；**多 Agent 支持**是从 Workbench 升级到 Control Plane 的关键。
>
> **短期路线**：抽离 `server-core` + EventEmitter 抽象 + Worker 间委派 v1，**让 AgeWork 既能本地试用，也能内网部署，且支持 agent 间协作**。
>
> **中期路线**：实现 Team 模式 + Automation 引擎 + 远程桌面绑定，**让 AgeWork 在团队场景下能落地**。
>
> **长期路线**：飞书 / 钉钉集成 + Office 文档生成 + 审计日志，**让 AgeWork 成为可治理的企业级 Agent Workbench**。
>
> **两项目最大的共同盲点**：都没有真正执行沙箱。这是 AgeWork 当前的差异化（OpenSandbox + Docker），**必须持续强化**——沙箱是多 Agent 协作的安全性前提，没有沙箱的 MCP 委派等于让 agent 在用户机器上裸跑。
