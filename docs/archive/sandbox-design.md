# Agent 沙箱方案设计

## 背景

当前 agent 运行在宿主机进程内（方案 A），多用户并发场景下存在以下问题：

- 无进程并发上限，高并发可能导致 OOM / CPU 跑满
- 多个 agent run 共享同一运行环境，存在环境污染风险（npm global install、pip install 等）
- 无 CPU / 内存配额，用户间资源互相竞争

## 现有隔离能力（方案 A）

SDK 内置的隔离，开销极小，已启用：

| 能力 | 实现 |
|---|---|
| 文件写入限制 | `sandboxMode: 'workspace-write'`，macOS 用 seatbelt、Linux 用 landlock 内核强制 |
| 目录隔离 | 自定义 HOME、XDG_CONFIG_HOME、XDG_CACHE_HOME、XDG_DATA_HOME，指向独立的 codexHome |
| 网络控制 | `networkAccessEnabled: false` / `webSearchMode: 'disabled'` |
| 行为控制 | `approvalPolicy: 'never'`，全自动执行 |

**方案 A 适合场景**：内部团队工具、成员互信、小规模并发。

**方案 A 无法做到**：CPU/内存配额、跨用户进程隔离、防止环境污染。

## 容器化沙箱方案（方案 B）

### 架构

```
NestJS API（宿主机）
    │
    ├── Codex SDK  →  codexPathOverride  →  sandbox-wrapper
    │                                            │
    └── Claude SDK →  pathToClaudeCodeExecutable →  sandbox-wrapper
                                                     │
                                            OpenSandbox / Docker
                                                     │
                                            codex / claude CLI（容器内）
                                                     │ stdout JSONL
                                            ←────────┘
```

### 关键设计

**SDK 代码无需修改**。两个 SDK 均提供了可执行文件路径覆盖选项：

- Codex：`codexPathOverride`
- Claude Code：`pathToClaudeCodeExecutable`

将这两个选项指向同一个 sandbox wrapper 脚本，wrapper 负责在沙箱内运行真实 CLI 并透传 stdout，SDK 感知不到差异。

**切换方式**：通过环境变量控制，无需改动 adapter 代码：

```typescript
new Codex({
  codexPathOverride: process.env.AGENT_SANDBOX === 'true'
    ? '/path/to/sandbox-wrapper'
    : undefined,
});
```

### 镜像

使用 OpenSandbox 官方镜像，内置多语言运行时：

```
opensandbox/code-interpreter:v1.0.2
- Node.js（可指定版本）
- Python 3（可指定版本）
- Java、Go
- 基础工具（git、curl、bash 等）
```

在此基础上追加安装 codex / claude CLI 即可，无需自行维护 Dockerfile。

容器为临时容器（run 结束即销毁），agent 在容器内安装的任何依赖不会污染宿主机或其他用户的环境。

### 文件系统

- **单机部署**：bind mount 项目 workdir 到容器 `/workspace`，文件天然持久化
- **多节点部署**：需要共享存储（NFS / 对象存储 / K8s PVC）

### OpenSandbox 优势

| 能力 | 说明 |
|---|---|
| 隔离级别可选 | Docker（本地）→ gVisor → Kata Containers → Firecracker，同一套 API，代码不变 |
| 网络管控 | 每个沙箱独立出入口策略，精确控制外网访问 |
| 生命周期管理 | 创建、执行、销毁全部封装，无需自己处理 pipe / 超时 / 崩溃恢复 |
| 多语言 SDK | TypeScript、Python、Go、Java、Kotlin |
| 本地→生产 | Docker Compose 本地开发，Kubernetes 生产，同一套 API |
| 开源免费 | Apache 2.0，自托管，无使用限制 |

GitHub：https://github.com/alibaba/OpenSandbox

## 适用场景对比

| | 方案 A（SDK 本地） | 方案 B（容器沙箱） |
|---|---|---|
| 部署复杂度 | 低 | 中 |
| 环境污染 | 有风险 | 无（容器销毁即干净） |
| CPU/内存限制 | 不支持 | 支持 |
| 多用户隔离 | 文件层面 | 完整隔离 |
| 冷启动延迟 | 无 | ~300-800ms |
| 适合场景 | 内部工具、小团队 | 多用户、对外开放、私有化部署 |

## 实施计划

1. **当前阶段**：方案 A，加 BullMQ 并发队列控制，防止资源耗尽
2. **后期阶段**：实现 sandbox wrapper 脚本，通过 `AGENT_SANDBOX=true` 切换到方案 B
3. **生产阶段**：接入 OpenSandbox + Kubernetes，支持大规模多用户
