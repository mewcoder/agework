# Agent CLI Runtime 管理方案

> 记录时间：2026-06-19

本文记录 AgeWork 客户端与本地 Agent CLI runtime 的管理策略，覆盖 Claude Code 与 Codex。

## 目标

AgeWork 客户端安装包应保持轻量，不默认内置 Claude Code / Codex CLI。

Agent CLI runtime 由应用在运行期检测、配置或按需安装。SDK 通过指定 CLI 可执行文件路径使用这些 runtime，而不是复用用户手动打开的交互式 CLI 进程。

核心目标：

- 减少客户端初始安装包体积。
- 支持用户已有的本机 `claude` / `codex` 安装。
- 支持 AgeWork 自管的按需 runtime 安装。
- 不污染用户全局环境，不默认改 PATH，不默认执行全局安装。
- 保持 local/desktop 与 docker/sandbox 的运行边界清晰。

## 基本判断

Claude Code SDK 与 Codex SDK 都是 CLI/native binary 之上的程序化控制层。

- Claude Code SDK 通过 `query()` 启动 Claude Code CLI/native binary 子进程，并支持 `pathToClaudeCodeExecutable`。
- Codex SDK 通过 `codex exec --experimental-json` 启动 Codex CLI 子进程，并支持 `codexPathOverride`。
- SDK 可以复用本地安装的可执行文件、配置目录、登录态和 session 文件。
- SDK 不应被设计成 attach 到用户已经打开的终端进程。

因此 AgeWork 应管理的是“CLI executable path + 配置来源 + 认证来源”，而不是外部进程句柄。

## Runtime 来源优先级

推荐优先级：

```text
custom path > managed runtime > system PATH > missing
```

含义：

| 来源 | 说明 | 适用场景 |
| --- | --- | --- |
| `custom` | 用户手动指定 CLI 路径 | 高级用户、特殊安装路径、私有部署 |
| `managed` | AgeWork 按需下载并安装到自己的数据目录 | 桌面客户端推荐的稳定路径 |
| `system` | 检测 `PATH` 中已有的 `claude` / `codex` | 本地开发、用户已安装 CLI |
| `missing` | 未检测到可用 CLI | 展示安装/选择路径入口 |

后台配置应允许用户选择来源，但默认可以使用 `auto` 策略按上述优先级解析。

## Managed Runtime 目录

AgeWork 自管 runtime 不放进安装包，也不安装到全局目录。

macOS 示例：

```text
~/Library/Application Support/AgeWork/runtimes/
  claude/
    versions/<version>/
    current -> versions/<version>/
  codex/
    versions/<version>/
    current -> versions/<version>/
```

Windows / Linux 使用对应 app data 目录。

每个 managed runtime 至少记录：

```text
agent: claude | codex
source: managed
version: <version>
path: <absolute executable path>
installedAt: <timestamp>
status: installed | installing | failed
```

## 后台配置页

新增 Agent Runtime 管理页面，展示 Claude Code 与 Codex 的状态。

每个 Agent 展示：

- 来源：`auto` / `managed` / `system` / `custom` / `disabled`
- 解析后的 CLI 路径
- CLI 版本
- 登录态检测结果
- 最近检测时间
- 状态：`missing` / `installed` / `installing` / `failed`
- 操作：重新检测、安装、更新、选择路径、卸载 managed runtime

检测命令：

```text
claude --version
codex --version
```

检测应有超时和错误摘要，避免后台卡死在异常 CLI 上。

## 安装策略

默认不静默安装。

不推荐：

- 默认 `npm install -g ...`
- 默认修改用户 shell 配置或 PATH
- 依赖用户机器一定存在 npm/pnpm
- 把 CLI 安装到系统全局目录

推荐：

- 用户明确点击安装后，后台启动安装任务。
- 安装到 AgeWork managed runtime 目录。
- 安装后运行 `--version` 验证。
- 验证通过后更新 runtime 配置。
- 失败时保留错误摘要和重试入口。

短期可先提供检测、手动路径和安装指引；managed install 可以作为第二阶段实现。

## SDK 接入

### Claude Code

当前已有路径注入链路：

```text
AGEWORK_CLAUDE_CLI_PATH -> pathToClaudeCodeExecutable
```

本地环境模式下应允许 Claude SDK 读取用户本地 Claude 配置和登录态。

`custom/provider` 模式下由 AgeWork 注入 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 等配置。

### Codex

当前已有路径注入链路：

```text
AGEWORK_CODEX_CLI_PATH -> codexPathOverride
```

需要补齐 Codex 的环境配置分支：

- `isEnvironmentConfig=true` 时，不注入 AgeWork 的 `apiKey` / `baseUrl` / provider override，让 Codex CLI 自己读取 `~/.codex` 和本地登录态。
- `isEnvironmentConfig=false` 时，继续由 AgeWork 注入 `apiKey` / `baseUrl` / `model` / config override。

这样 Claude 与 Codex 在模型配置来源上保持一致。

## Runtime 边界

### local / desktop

支持：

- system CLI
- custom path
- managed runtime

这是本地客户端的主路径，目标是轻安装包和良好的本机体验。

### docker / sandbox

不使用宿主机 CLI。

容器内 runtime 应来自 worker 镜像，避免挂载宿主机 CLI 或宿主机认证目录破坏隔离边界。

Docker/sandbox 镜像可以继续预装所需 SDK/CLI，版本由镜像构建流程控制。

### server Web

后台安装和检测发生在服务器上，不是用户浏览器所在电脑。

这类操作应限制为管理员权限，并清楚展示“当前配置影响服务器 runtime”。

## 与 Docker / OpenSandbox 的关系

CLI runtime 管理主要服务 local/desktop 体验。

Docker provider 应继续作为本地/小团队可信部署的基础执行层；OpenSandbox 保留为未来生产级沙箱平台方向。

不要为了本机 CLI 复用而把宿主 CLI、宿主登录态或用户 home 目录挂进 sandbox。sandbox 的安全边界应由镜像、runtime provider 和后续 OpenSandbox 能力维护。

## 阶段计划

### Phase 1: 检测与手动配置

- 检测 `PATH` 中的 `claude` / `codex`。
- 支持自定义 CLI path。
- 展示版本、路径、状态和错误摘要。
- 将解析后的路径传入 worker。

### Phase 2: Managed Runtime

- 增加后台安装任务。
- 下载/解包到 AgeWork runtime 目录。
- 支持安装、更新、卸载和重新检测。
- 安装后验证 `--version`。

### Phase 3: 体验完善

- Agent 首次启用时触发安装引导。
- 支持失败恢复、安装日志、版本 pin。
- 可选自动更新提示，但不静默更新。

## 当前建议

近期优先做：

1. Agent Runtime 后台状态页。
2. system/custom CLI 检测。
3. Codex `isEnvironmentConfig` 分支。
4. managed install 的数据结构和任务接口预留。

安装包先保持轻量，managed runtime 放到后续按需安装路径中。
