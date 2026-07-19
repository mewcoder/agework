# @agework/agent-sdk

AgeWork Agent Adapter 的轻量扩展契约。插件只依赖本包，不需要依赖 Worker、内置
Adapter 或具体 Agent SDK。

完整的新建、安装、执行边界和动态 manifest 目标见
[`Agent 插件使用与开发`](../../docs/guide/agent-plugin.md)。

```ts
import { defineAgentPlugin, type AgentDriver } from "@agework/agent-sdk";

export function createAgentPlugin() {
  return defineAgentPlugin({
    apiVersion: 1,
    id: "example",
    displayName: "Example Agent",
    agentTypes: ["example"],
    create(context): AgentDriver {
      return new ExampleDriver(context);
    },
  });
}
```

将插件包安装到 Runtime 产物可解析的位置，再配置：

```bash
AGEWORK_AGENT_PLUGINS=@acme/agework-agent-example
```

Worker 会先注册随发行版携带的 `@agework/adapters/plugin` 与
`@agework/agent-acp`，再加载显式配置的外部插件；
不同插件不能声明相同的 `agentType`。控制面的动态 Agent 清单尚未插件化，因此新增
`agentType` 目前还需要在产品配置中显式开放。
