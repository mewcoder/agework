# Agent 插件使用与开发

本文说明 Agent Plugin 在哪里实现、已有插件如何加载、新插件必须实现什么，以及当前执行侧
插件机制与产品侧动态 Agent catalog 之间的边界。

## 1. 扩展点与代码位置

| 作用 | 文件 |
|---|---|
| SDK 类型、Driver 与插件上下文 | `packages/agent-sdk/src/types.ts` |
| manifest 校验 | `packages/agent-sdk/src/plugin.ts` |
| 外部包动态加载 | `apps/runtime/src/worker/agent/plugin-loader.ts` |
| agentType 注册与重复检查 | `apps/runtime/src/worker/agent/plugin-registry.ts` |
| Worker 选择插件 | `apps/runtime/src/worker/agent/index.ts` |
| ACP 完整示例 | `packages/agent-acp/src/plugin.ts` |
| Claude/Codex 聚合示例 | `packages/adapters/src/plugin.ts` |

依赖方向固定为：

```text
worker ──> agent-sdk <── agent plugin
```

Agent Plugin 只依赖 `@agework/agent-sdk`，不能依赖 Runtime 内部 Worker。Claude/Codex 与 ACP
是默认随发行版注册的 bundled plugins。

## 2. 当前能力边界

当前代码已经完成执行侧插件化：Worker 能动态加载插件，并按 `agentType` 创建 `AgentDriver`。
但控制面的 Agent catalog 仍是封闭列表，所以一个全新的外部 `agentType` 还不能做到“安装包后
自动出现在 Server 和 Web”。

这不是插件开发者应当修改核心登记表解决的问题。真正的目标流程是：

```text
Agent Plugin serializable manifest
              ↓
Runtime Host 上报 Agent capabilities
              ↓
Server 生成当前 Host 的 Agent catalog
              ↓
Web 动态展示 label / protocol / options / icon
              ↓
Worker 按 agentType 创建 Driver
```

在动态 catalog 落地前：

- 官方已登记的 Claude、Codex、OpenCode、Pi 可以正常使用。
- 外部插件 Loader 和 Driver registry 可用于开发、验证执行层。
- 不把修改 `AGENT_TYPES`、Server options、Web icon 等核心文件写成插件接入步骤。
- 新 `agentType` 的端到端产品接入仍属于待完成的核心架构能力。

## 3. 使用已有 Agent Plugin

### 3.1 使用官方 bundled plugins

以下插件由 Worker 默认注册，不需要 `AGEWORK_AGENT_PLUGINS`：

| 包 | agentTypes |
|---|---|
| `@agework/adapters/plugin` | `claude`、`codex` |
| `@agework/agent-acp` | `opencode`、`pi` |

### 3.2 加载外部插件包

插件由 Runtime 产物中的 Runner 加载，因此包必须安装在 Runtime 产物可解析的位置：

```bash
pnpm --filter @agework/runtime add '@scope/agent-example@workspace:*'
pnpm --filter @scope/agent-example build
```

已发布到 npm 的包：

```bash
pnpm --filter @agework/runtime add @scope/agent-example
```

配置：

```dotenv
AGEWORK_AGENT_PLUGINS=@scope/agent-example
```

多个插件使用逗号分隔。Runner 启动时 Loader 会执行 `import(packageName)`，调用包根导出的
`createAgentPlugin()`，然后由 registry 按 `agentType` 路由。

CLI override 使用通用命名：

```dotenv
AGEWORK_EXAMPLE_CLI_PATH=/absolute/path/to/example
```

`example` 来自 `agentType`；连字符会转换成下划线。该变量会经过 Runtime Host、Worker、
Runner 的受控环境传递链，在 Native 和 Docker Runtime 下都可用。

### 3.3 Docker Runtime 注意事项

Agent 插件最终在 Worker 镜像内执行，只在宿主机安装包不会改变已有镜像：

- 官方 bundled plugin 必须在 `runtimeRequirements` 中用精确版本声明 npm 包和
  主可执行文件；ACP Profile 的 `command` 会自动成为 `acpExecutable`。
- `pnpm --filter @agework/runtime sync:bundled-agent-deps` 会由这些声明生成
  `sdk-deps/package.json`、lockfile 和镜像验证清单，不手工编辑生成文件。
- `pnpm worker:build` 和 OpenSandbox rebuild 会在构建前自动执行同步。
- Runtime typecheck/package 会先执行 `check:bundled-agent-deps`；声明与生成文件不一致时
  立即失败。Docker 构建还会验证每个声明的 package 版本和 binary。
- 私有 workspace 包应使用自定义 Worker 镜像。
- 官方插件可以像 `@agework/agent-acp` 一样作为静态 bundled plugin 编入发行产物。

## 4. 开发新的 Agent Plugin

### 4.1 包结构

```text
packages/agent-example/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── example.driver.ts
```

最小 `package.json`：

```json
{
  "name": "@scope/agent-example",
  "version": "0.0.1",
  "main": "./dist/index.cjs",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "require": "./dist/index.cjs",
      "default": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@agework/agent-sdk": "workspace:*"
  },
  "devDependencies": {
    "@agework/agent-sdk": "workspace:*",
    "tsdown": "^0.22.9",
    "typescript": "catalog:"
  },
  "tsdown": {
    "entry": "src/index.ts",
    "format": "cjs",
    "platform": "node",
    "target": "node22",
    "fixedExtension": true,
    "sourcemap": true,
    "dts": true,
    "deps": { "skipNodeModulesBundle": true }
  }
}
```

仓库外发布时，把 `workspace:*` 换成兼容的 SDK 版本范围。

最小 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "declaration": true,
    "isolatedDeclarations": true,
    "target": "ES2023",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

### 4.2 实现 Driver

```ts
import type {
  AgentControlCommand,
  AgentDriver,
  AgentEventStream,
  AgentPluginCreateContext,
  AgentRunInput,
} from "@agework/agent-sdk";

export class ExampleDriver implements AgentDriver {
  constructor(private readonly context: AgentPluginCreateContext) {}

  run(input: AgentRunInput): AgentEventStream {
    return createAgUiEventStream(input, this.context);
  }

  interrupt(threadId?: string): Promise<void> {
    return interruptExampleAgent(threadId);
  }

  cancel(threadId?: string): Promise<void> {
    return cancelExampleAgent(threadId);
  }

  resolveControl(command: AgentControlCommand): boolean | Promise<boolean> {
    if (command.type !== "approval_resolved") return false;
    return resolveExampleApproval(command);
  }

  shutdown(): Promise<void> {
    return shutdownExampleAgent();
  }
}
```

示例中的 stream、interrupt、cancel 和 approval 函数是具体 Agent SDK 的桥接占位。完整实现
可参考 `packages/agent-acp/src/plugin.ts` 和其内部 Driver。

`AgentPluginCreateContext` 已提供：

- 当前 `agentType`、工作目录 `runtimePath` 和原始 run input。
- system/custom provider 配置；custom 模式包含 API format、URL、key、model 和 extra config。
- Host 或环境解析出的 `executablePath`。
- trace 与 pending-action 回调。
- 显式 run env；不会把 Worker 私密环境完整暴露给插件。

`run()` 必须返回 Observable-like stream，并输出 AgeWork 当前消费的 AG-UI 事件。SDK 不强制
依赖 RxJS，只要求返回值满足 `AgentEventStream`。

### 4.3 导出 manifest

包根 `src/index.ts` 必须具名导出无参 `createAgentPlugin()`：

```ts
import { defineAgentPlugin } from "@agework/agent-sdk";
import { ExampleDriver } from "./example.driver";

export function createAgentPlugin() {
  return defineAgentPlugin({
    apiVersion: 1,
    id: "example",
    displayName: "Example Agent Plugin",
    agentTypes: ["example"],
    runtimeRequirements: {
      example: {
        npmPackages: { "example-agent-cli": "1.2.3" },
        agentExecutable: "example",
      },
    },
    create: (context) => new ExampleDriver(context),
  });
}
```

约束：

- `id` 和 `agentTypes` 只能使用小写字母、数字和连字符。
- 一个插件可以声明多个 `agentType`，但必须由同一个 `create()` 正确分流。
- bundled plugin 的 `runtimeRequirements` 必须覆盖全部 `agentTypes`，npm 包使用精确版本。
- API v1 外部插件可省略 `runtimeRequirements`，但需由自定义 Runtime 镜像或宿主环境提供 CLI。
- 不同插件不能声明相同的 `agentType`。
- `resolveControl()` 收到不属于自己的控制命令时返回 `false`。
- `cancel()`、`interrupt()` 和 `shutdown()` 必须能收敛底层进程或 SDK session。

## 5. ACP Agent 的快捷路径

如果目标 Agent 已支持 ACP，不需要重写进程、session、权限和 AG-UI 映射。新增
`AcpAgentProfile` 并注册即可。完整流程单独维护在
[`ACP Agent Profile 扩展`](acp-agent.md)。

```text
packages/agent-acp/src/agents/opencode/
packages/agent-acp/src/agents/pi/
packages/agent-acp/src/agents/registry.ts
```

这能完成执行侧接入；新的 `agentType` 自动进入产品 catalog 仍依赖第 2 节所述的动态 manifest
能力。Profile 的环境、bridge、权限和协议验证规则以 ACP 专项文档为唯一来源。

## 6. 动态 Agent manifest 的目标契约

为了让外部插件不修改 AgeWork 核心代码，后续 manifest 至少需要可序列化地声明：

```ts
type AgentDefinition = {
  type: string;
  displayName: string;
  protocol: string;
  apiFormats: {
    native: string;
    supported: string[];
  };
  cli?: {
    command: string;
    npmPackage?: string;
    companionPackages?: string[];
  };
  skills?: {
    directory: string;
  };
  options?: JsonSchema;
  icon?: string;
};
```

这些数据应由 Runtime Host 上报并由 Server/Web 消费，替代核心代码里的 `AGENT_TYPES`、label、
protocol、API format 矩阵、CLI spec 和按类型封闭的 options。未知 icon 使用通用 fallback。

## 7. 验证

执行侧至少验证：

- 包根导出了 `createAgentPlugin()`。
- 插件未安装、未构建或 manifest 非法时，Loader 给出明确错误。
- bundled Agent 的 runtime requirements 与 Runtime 生成清单一致。
- Docker 镜像内声明的 package 版本、主 binary 和 ACP executable 均存在且可执行。
- Driver 输出合法的 AG-UI run/message/tool 事件序列。
- interrupt、cancel、approval 和 shutdown 都能收敛。
- Native 与 Docker Worker 都能解析插件包和 CLI。
- 动态 catalog 完成后，安装新插件不再需要修改 shared、server 或 web。

常用类型检查：

```bash
pnpm --filter @scope/agent-example typecheck
pnpm --filter @agework/agent-sdk typecheck
pnpm --filter @agework/runtime typecheck
pnpm --filter server typecheck
pnpm --filter web typecheck
```
