# @agework/runtime-sdk

AgeWork Runtime 插件的公共 SDK。它只包含稳定契约、manifest helper、placement 类型和沙箱启动
公共工具，不依赖 NestJS、Runtime Host 或任何具体 sandbox SDK。

完整的新建、安装、启用和发行流程见
[`Runtime 插件使用与开发`](../../docs/guide/runtime-plugin.md)。

## 创建插件

插件包依赖 SDK，并把它声明为 peer dependency，避免宿主与插件各带一份不兼容契约：

```json
{
  "peerDependencies": {
    "@agework/runtime-sdk": "^1.0.0"
  }
}
```

标准入口必须导出无参 `createRuntimePlugin()`。插件私有配置由插件自己解析和校验：

```ts
import {
  defineRuntimePlugin,
  type RuntimeProvider,
  type RuntimeProviderConfig,
} from "@agework/runtime-sdk";

class ExampleProvider implements RuntimeProvider {
  readonly type = "example";

  constructor(private readonly config: RuntimeProviderConfig) {}

  // 实现 start / release / stop / destroy
}

export function createRuntimePlugin() {
  return defineRuntimePlugin({
    apiVersion: 1,
    type: "example",
    displayName: "Example Runtime",
    scopes: ["workspace"],
    probe: async () => ({ available: true }),
    create: (config) => new ExampleProvider(config),
  });
}
```

## 部署加载

把插件安装到 Runtime Host 的依赖环境后，再显式配置包名与允许的 runtime type：

```bash
pnpm --filter @agework/runtime add @acme/runtime-example
```

```dotenv
AGEWORK_RUNTIME_PLUGINS=@acme/runtime-example
AGEWORK_RUNTIME_ALLOWED_TYPES=native,example
```

registered Host 使用同一协议：

```bash
agework-runtime \
  --runtime native,example \
  --plugins @acme/runtime-example
```

Host 会验证插件 API 版本、type 格式、重复注册、manifest 与 provider type 是否一致，以及配置中
启用的 runtime 是否确实已有内建实现或已加载插件。

## SDK 边界

SDK 提供 `RuntimeProvider`、`RuntimeProviderPlugin`、`defineRuntimePlugin()`、能力探测、launch/ref/config 类型、
`resolveRuntimeSpec()` 与 `buildSandboxStartInput()`。插件自己的环境变量、SDK client、健康检查和
资源生命周期实现留在插件包中。
