# @agework/runtime-opensandbox

AgeWork 的实验性 OpenSandbox runtime provider 插件。它把 OpenSandbox SDK、连接配置和沙箱
生命周期实现隔离在公共 `@agework/runtime-sdk` 之外。

- 默认不加载；builtin Host 和 registered daemon 都只在各自允许的 runtime type 包含
  `opensandbox` 时动态装配。
- 当前按需维护，不属于 Native / Docker 主线的兼容性承诺。
- 启动、配置和排错见 [`../../docs/experimental/opensandbox.md`](../../docs/experimental/opensandbox.md)。

插件入口导出 `createOpenSandboxRuntimePlugin(connectionConfig)`，返回核心
`RuntimeProviderPlugin` 契约。插件私有配置通过工厂闭包持有，不进入 Host 提供的
`RuntimeProviderConfig`。
同时导出标准无参 `createRuntimePlugin()`，供 Runtime Host 通用 loader 调用。

```dotenv
AGEWORK_RUNTIME_PLUGINS=@agework/runtime-opensandbox
AGEWORK_RUNTIME_ALLOWED_TYPES=opensandbox
AGEWORK_SANDBOX_OPENSANDBOX_DOMAIN=localhost:8080
AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL=http
```

## 通用装配

```ts
import { RuntimeHost } from "@agework/runtime/host";
import { createOpenSandboxRuntimePlugin } from "@agework/runtime-opensandbox";

const host = new RuntimeHost({
  // 其余 RuntimeHostConfig...
  providerConfig,
  providerPlugins: [
    createOpenSandboxRuntimePlugin({
      domain: "localhost:8080",
      protocol: "http",
      apiKey: process.env.OPENSANDBOX_API_KEY,
      useServerProxy: false,
    }),
  ],
});
```

`RuntimeHost` 不区分 builtin、registered 或自定义宿主；谁创建 Host，谁就可以通过
`providerPlugins` 注入该插件。AgeWork 自带的 builtin Host 和 registered daemon 都会在
runtime type 显式包含 `opensandbox` 时按各自配置动态加载它。

源码部署若只单独构建 server 或 registered runtime，需要同时构建该可选包：

```bash
pnpm --filter @agework/runtime-opensandbox build
```

本地 OpenSandbox Server 的 compose 运维也归本包管理，不占用根 `package.json` 脚本：

```bash
pnpm --filter @agework/runtime-opensandbox infra:up
pnpm --filter @agework/runtime-opensandbox infra:down
pnpm --filter @agework/runtime-opensandbox infra:logs
pnpm --filter @agework/runtime-opensandbox infra:health
pnpm --filter @agework/runtime-opensandbox infra:rebuild
```
