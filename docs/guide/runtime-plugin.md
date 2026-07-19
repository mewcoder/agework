# Runtime 插件使用与开发

本文说明 Runtime Plugin 在哪里实现、已有插件如何启用、新插件必须实现什么，以及怎样作为
外部插件或官方 bundled plugin 交付。

## 1. 扩展点与代码位置

| 作用 | 文件 |
|---|---|
| SDK 类型与生命周期契约 | `packages/runtime-sdk/src/types.ts` |
| manifest 校验 | `packages/runtime-sdk/src/plugin.ts` |
| 外部包动态加载 | `apps/runtime/src/plugins/runtime-plugin-loader.ts` |
| provider 注册与重复检查 | `apps/runtime/src/providers/registry.ts` |
| Docker 完整示例 | `packages/runtime-docker/src/index.ts` |
| OpenSandbox 可选插件示例 | `packages/runtime-opensandbox/src/index.ts` |

依赖方向固定为：

```text
runtime-host ──> runtime-sdk <── runtime plugin
```

Runtime Plugin 只依赖 `@agework/runtime-sdk`，不能依赖 `@agework/runtime`。Runtime Host
只内建 `native`；Docker 是默认随发行版注册的 bundled plugin。

## 2. 使用已有 Runtime Plugin

### 2.1 使用官方 bundled Docker 插件

Docker 已经随 builtin、registered 两种 Runtime Host 发行，不需要配置插件包名，只需允许该
runtime type：

```dotenv
AGEWORK_RUNTIME_ALLOWED_TYPES=native,docker
```

### 2.2 使用外部插件

先把插件安装到 Runtime Host 的依赖环境。仓库内 workspace 包示例：

```bash
pnpm --filter @agework/runtime add '@scope/runtime-example@workspace:*'
pnpm --filter @scope/runtime-example build
```

已发布到 npm 的包不需要 `workspace:*`：

```bash
pnpm --filter @agework/runtime add @scope/runtime-example
```

然后同时配置包名和允许的 runtime type：

```dotenv
AGEWORK_RUNTIME_PLUGINS=@scope/runtime-example
AGEWORK_RUNTIME_ALLOWED_TYPES=native,example
```

多个插件使用逗号分隔：

```dotenv
AGEWORK_RUNTIME_PLUGINS=@scope/runtime-example,@scope/runtime-second
```

registered Host 也可以使用参数：

```bash
agework-runtime \
  --runtime native,example \
  --plugins @scope/runtime-example
```

启动时 Loader 会动态执行 `import(packageName)`，调用包根导出的
`createRuntimePlugin()`。业务代码和 provider registry 都不需要修改。

## 3. 开发新的 Runtime Plugin

### 3.1 包结构

仓库内插件建议放在：

```text
packages/runtime-example/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── example-runtime.provider.ts
```

最小 `package.json`：

```json
{
  "name": "@scope/runtime-example",
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
    "@agework/runtime-sdk": "workspace:*"
  },
  "devDependencies": {
    "@agework/runtime-sdk": "workspace:*",
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

### 3.2 实现 Provider

```ts
import type {
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  RuntimeProvider,
  RuntimeProviderConfig,
} from "@agework/runtime-sdk";

export class ExampleRuntimeProvider implements RuntimeProvider {
  readonly type = "example";

  constructor(private readonly config: RuntimeProviderConfig) {}

  async start(
    context: RuntimeLaunchContext,
    _onExit?: () => void,
    onProvisioned?: (runtimeInstanceId: string) => void
  ) {
    const runtimeInstanceId = await createExampleSandbox(context, this.config);
    // 一拿到稳定资源 id 就回报，后续步骤失败时 Host 才能回滚。
    onProvisioned?.(runtimeInstanceId);
    return { runtimeInstanceId };
  }

  release(ref: RuntimeInstanceRef) {
    return this.destroy(ref);
  }

  stop(ref: RuntimeInstanceRef) {
    return stopExampleSandbox(ref.runtimeInstanceId);
  }

  destroy(ref: RuntimeInstanceRef) {
    return removeExampleSandbox(ref.runtimeInstanceId);
  }
}
```

示例中的 Sandbox 函数是插件自己的基础设施实现占位。真实实现可参考
`packages/runtime-docker/src/docker-runtime.provider.ts`。

生命周期语义：

| 方法 | 语义 |
|---|---|
| `start` | 创建运行环境并启动 Worker，返回稳定的 `runtimeInstanceId` |
| `release` | 正常释放；是否保留缓存由 Provider 决定 |
| `stop` | 停止运行实例，可作为 Provider 内部缓存原语 |
| `destroy` | 启动失败回滚或孤儿清理，必须能强制删除资源 |

### 3.3 导出 manifest

包根 `src/index.ts` 必须具名导出无参 `createRuntimePlugin()`：

```ts
import { defineRuntimePlugin } from "@agework/runtime-sdk";
import { ExampleRuntimeProvider } from "./example-runtime.provider";

export function createRuntimePlugin() {
  const privateConfig = readAndValidatePluginEnv(process.env);

  return defineRuntimePlugin({
    apiVersion: 1,
    type: "example",
    displayName: "Example Runtime",
    scopes: ["workspace"],
    probe: () => probeExampleService(privateConfig),
    create: (hostConfig) => new ExampleRuntimeProvider(hostConfig),
  });
}
```

约束：

- `type` 只能使用小写字母、数字和连字符。
- 插件私有配置由插件自己读取和校验；Host 只传通用 `RuntimeProviderConfig`。
- Sandbox Provider 可复用 `buildSandboxStartInput()` 生成 Worker env、挂载和 metadata。
- manifest 的 `type` 必须与创建出的 Provider `type` 一致。
- 不同插件不能声明相同的 `type`，也不能覆盖 `native`。

## 4. 外部插件与 bundled plugin

```text
external plugin
  安装包 + AGEWORK_RUNTIME_PLUGINS + AGEWORK_RUNTIME_ALLOWED_TYPES

bundled plugin
  随发行版携带 + 装配层默认注册
```

只有希望插件随 AgeWork 默认发行时才修改装配代码。参考 Docker：

- 在 `apps/runtime/package.json`、`apps/server/package.json` 增加依赖和构建前置。
- registered 入口在 `apps/runtime/src/registered/main.ts` 注册 manifest。
- builtin 入口在 `apps/server/src/runtime-host/contract/builtin-runtime-host.ts` 注册 manifest。
- Provider 实现仍留在独立包，不放回 `apps/runtime/src/providers`。

## 5. 验证

至少验证：

- 包根导出了 `createRuntimePlugin()`。
- 插件未安装、未构建或 manifest 非法时，Loader 给出明确错误。
- `probe` 能反映基础设施不可用和恢复。
- `start` 在获得资源 id 后及时调用 `onProvisioned`。
- `destroy` 能清理启动中途失败留下的资源。
- Native、Docker 等目标部署环境都能解析插件包。

常用类型检查：

```bash
pnpm --filter @scope/runtime-example typecheck
pnpm --filter @agework/runtime-sdk typecheck
pnpm --filter @agework/runtime typecheck
pnpm --filter server typecheck
```
