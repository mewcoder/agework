# ACP Agent Profile 扩展

本文说明如何在官方 `@agework/agent-acp` 插件中增加一个 ACP Agent Profile。通用 Agent
Plugin 的安装、Driver 契约和动态 catalog 边界见
[`Agent 插件使用与开发`](agent-plugin.md)。

## 1. 什么时候使用 Profile

```text
目标 Agent 支持 ACP
  ├─ 是 → 增加 AcpAgentProfile
  └─ 否 → 寻找 ACP bridge
           ├─ 有 → Profile.resolveLaunch() 启动 bridge
           └─ 无 → 开发独立 Agent Plugin / Driver
```

Profile 只描述一个 Agent 如何启动和注入环境，不重新实现以下能力：

- ACP initialize、session/new、session/load 和 session 生命周期。
- 子进程、stdio NDJSON JSON-RPC 和退出清理。
- `session/request_permission` 与 AgeWork pending action 的桥接。
- ACP update 到 AG-UI run/message/tool 事件的映射。
- interrupt、cancel、approval 和 shutdown。

## 2. 前置验证

动代码前先确认：

1. 启动 Agent 的 ACP 入口，完成 `initialize` → `session/new` 冒烟。
2. 如果本体不支持 ACP，确认 bridge 的真实命令、参数和平台支持，不按包名猜测。
3. 确认 system/custom 两种模式的认证、模型和 base URL 注入方式。
4. 查看 Agent 上报的 session modes、config options 和权限请求形态。
5. 确认恢复能力使用 `session/load`、`session/resume`，或根本不支持恢复。

ACP registry 可用于查找发行信息：

- <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
- <https://agentclientprotocol.com/get-started/registry>

即使 registry 存在条目，也必须实际完成握手；错误的 bridge/参数常表现为启动后无输出并最终
等待超时。

## 3. 代码位置

| 作用 | 文件 |
|---|---|
| Profile 契约 | `packages/agent-acp/src/agents/types.ts` |
| Profile registry | `packages/agent-acp/src/agents/registry.ts` |
| OpenCode 示例 | `packages/agent-acp/src/agents/opencode/` |
| Pi bridge 示例 | `packages/agent-acp/src/agents/pi/` |
| Profile → Adapter 构造 | `packages/agent-acp/src/create-adapter.ts` |
| ACP Agent Plugin manifest | `packages/agent-acp/src/plugin.ts` |

新增一种 ACP Agent 时，以独立目录收拢它的 Profile、测试和后续专属逻辑：

```text
packages/agent-acp/src/agents/
├── example/
│   ├── index.ts
│   ├── profile.ts
│   └── profile.spec.ts
├── registry.ts
└── types.ts
```

`engine/` 负责 ACP client、session、process 和协议能力，`bridge/` 负责权限与 AG-UI
映射；新增 Agent 通常不需要修改这两个通用层。

每个 bundled Profile 还必须声明 `runtimeRequirement`：精确 npm 包版本和主
binary。Runtime 会把 Profile 的 `command` 直接生成为 `acpExecutable`，因此 Pi 的
`pi-acp` bridge 也会被镜像门禁验证，无需在两处重复声明。

## 4. 实现 AcpAgentProfile

Profile 契约：

```ts
export interface AcpAgentProfile {
  agentType: string;
  displayName: string;
  command: string;
  args: readonly string[];
  runtimeRequirement: AgentRuntimeRequirement;

  buildEnv(input: AcpProfileEnvInput): Record<string, string>;

  resolveLaunch?(executablePath?: string): {
    command: string;
    args: readonly string[];
    env: Record<string, string>;
  };
}
```

原生 ACP Agent 示例：

```ts
import type { AcpAgentProfile } from "../types";

export const exampleAcpProfile: AcpAgentProfile = {
  agentType: "example",
  displayName: "Example",
  command: "example",
  args: ["acp"],

  buildEnv(input) {
    const env = { ...input.baseEnv };

    if (input.source === "custom") {
      if (input.apiKey) env.EXAMPLE_API_KEY = input.apiKey;
      if (input.baseUrl) env.EXAMPLE_BASE_URL = input.baseUrl;
      if (input.model) env.EXAMPLE_MODEL = input.model;
    }

    return env;
  },
};
```

在 `agents/example/index.ts` 导出 Profile：

```ts
export { exampleAcpProfile } from "./profile";
```

然后在 `agents/registry.ts` 增加一次导入和注册：

```ts
import { exampleAcpProfile } from "./example";

const PROFILES = new Map([
  [exampleAcpProfile.agentType, exampleAcpProfile],
]);
```

`@agework/agent-acp` 的 plugin manifest 通过 `listAcpProfiles()` 派生 `agentTypes`，所以执行侧
不需要修改 Worker 分流代码。

## 5. 环境与凭证规则

`AcpProfileEnvInput` 提供：

| 字段 | 含义 |
|---|---|
| `source` | `system` 使用 Agent 自己的本地配置；`custom` 使用 AgeWork Provider |
| `baseEnv` | 已剔除 Host/Worker 私密变量和隔离名单中 ambient credentials 的安全环境 |
| `apiKey`、`baseUrl`、`model` | custom Provider 配置 |
| `apiFormat` | Provider 使用的 API 协议格式 |
| `extraConfig` | 经过边界传入的扩展配置，Profile 必须显式挑选 |
| `permissionMode` | 本次 run 的权限预设 |

约束：

- 不要直接 spread `process.env`，只从 `baseEnv` 开始构造。
- 不要把 `extraConfig` 整包透传给子进程，逐项白名单读取。
- API key 优先通过子进程 env 间接引用，不写入持久配置文件。
- custom 临时配置必须与用户全局配置隔离，并保证多 run 幂等。
- system 模式不要覆盖 Agent 自己的认证和模型配置，除非产品设置明确要求。

OpenCode 通过 `OPENCODE_CONFIG_CONTENT` 注入临时 Provider；Pi 使用临时配置目录并让
`models.json` 的 API key 引用环境变量。两者分别代表“env 直通配置”和“临时目录配置”。

## 6. Bridge 型 Agent

Bridge 型 Agent 的检测目标和 spawn 目标不同：

```text
executablePath → Agent 本体
resolveLaunch → ACP bridge + args + bridge env
```

参考 `agents/pi/profile.ts`：

- 用户安装和 Runtime Host 检测的是 `pi`。
- 实际 spawn 的是同一 npm prefix 下的 `pi-acp`。
- `PI_ACP_PI_COMMAND` 把本体路径交给 bridge。
- 找不到 sibling bridge 时才回退 PATH。

主包和 bridge 包必须安装到同一 prefix。CLI 安装 manifest 的 companion package 能力后续也应
由动态 Agent manifest 声明，不应要求 Profile 开发者修改共享闭集。

## 7. 权限与 session modes

### 7.1 ACP 标准权限请求

Agent 发出 `session/request_permission` 时，`AcpPermissionBridge` 会生成 AgeWork pending
action。没有产品预设档位的 Agent 也可以使用这条标准路径。

必须实测 Agent 的默认策略；有些 Agent 默认直接执行工具，只有显式注入 `ask` 配置才会发起
权限请求。

### 7.2 Session mode/config option

通用 Adapter 支持两种模式来源：

- 原生 `modes`：切换时调用 `session/set_mode`。
- `configOptions` 中 `category: "mode"` 的选项：切换时调用
  `session/set_config_option`。

run input 中的 `forwardedProps.acpModeId` 会在 prompt 前应用。Profile 自己的
`permissionMode` 则在 `buildEnv()` 中映射为 Agent 私有配置。

产品权限菜单目前仍是控制面闭集。新的 Agent options 应由动态 Agent manifest/schema 描述；
在该能力完成前，Profile 能完成执行侧权限桥接，但不能自动生成新的 Web 设置项。

## 8. 当前产品 catalog 边界

新增 Profile 并注册后，`@agework/agent-acp` 执行侧会认识新的 `agentType`。但 Server/Web 的
Agent catalog 还没有从插件 manifest 动态生成，因此它不会自动出现在产品入口。

不要把修改以下核心闭集当作正式的 ACP 扩展流程：

- `AGENT_TYPES`、labels、protocol 和 API format matrix。
- Server 的按 Agent options。
- Web icon 和 forwarded-props 分支。
- CLI package/known-location 静态表。

这些数据的目标归属是 Agent Plugin 的可序列化 manifest，由 Runtime Host 上报并由
Server/Web 消费。完整目标契约见
[`Agent 插件使用与开发`](agent-plugin.md#6-动态-agent-manifest-的目标契约)。

## 9. 验证

### 9.1 Profile 单测

`agents/<agent>/profile.spec.ts` 至少覆盖：

- system/custom 两种模式的 env。
- API format 到 Agent Provider 配置的映射。
- API key 不落盘、不写入可记录配置。
- permissionMode 映射。
- bridge 型 Agent 的 executable/bridge 路径选择。

参考 `agents/opencode/profile.spec.ts` 和 `agents/pi/profile.spec.ts`。

### 9.2 协议冒烟

- 使用真实二进制完成 `initialize` 和 `session/new`。
- 检查 modes/configOptions/capabilities 与预期一致。
- 触发一次文本输出和工具调用，确认事件能映射成 AG-UI。
- 如果支持权限，确认 `session/request_permission` 能 resolve 后继续。
- 如果支持恢复，确认第二轮能 load/resume 原 session。

### 9.3 包级验证

```bash
pnpm --filter @agework/agent-acp typecheck
pnpm --filter @agework/agent-acp test
pnpm --filter @agework/runtime typecheck
```

按项目约定决定是否执行完整 Runtime 构建和平台端到端测试。

## 10. 已知坑

- bridge/本体双包不在同一 prefix，导致检测成功但 spawn 找不到 bridge。
- Agent 启动横幅被当成 `agent_message_chunk`，污染第一条助手消息。
- system/custom 共用 session 时，临时配置目录改变了默认 session 存储位置。
- 不同 Provider 对 base URL 是否包含 `/v1` 的要求不同，必须在 Profile 内按协议处理。
- 子进程启动成功但 ACP 握手无响应时必须有超时，不能永久等待。
- 不要在日志、trace、临时 JSON 中写入明文 API key。
