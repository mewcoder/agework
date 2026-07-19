# @agework/runtime-docker

AgeWork 默认随发行版携带的 Docker Runtime Plugin，也是 `@agework/runtime-sdk`
的官方插件示例。Runtime Host 不包含 Docker 实现，只通过标准
`createRuntimePlugin()` 出口装配本包。

```ts
import { defineRuntimePlugin } from "@agework/runtime-sdk";

export function createRuntimePlugin() {
  return defineRuntimePlugin({
    apiVersion: 1,
    type: "example",
    displayName: "Example",
    scopes: ["workspace"],
    create: (config) => new ExampleRuntimeProvider(config),
  });
}
```
