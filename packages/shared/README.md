# @agework/shared

跨 web / api / worker 的共享类型包。**纯类型、零构建、零运行时代码。**

## 子路径边界

| 入口 | 内容 | 允许的消费者 |
| --- | --- | --- |
| `@agework/shared` | 三端共享字面量类型（AgentType、RunStatus） | web / api / worker / adapters |
| `@agework/shared/protocol` | api↔worker 运行时协议（Envelope、RuntimeTransport 等） | api / worker / adapters |
| `@agework/shared/api` | web↔api HTTP wire 契约（请求/响应形状） | web / api |

## 为什么必须纯类型

api 的 `nest build` 是纯 tsc 构建，生产用 `node dist/src/main` 启动，
Node 无法加载本包的 `.ts` 运行时代码。所有导出必须是 `export type`，
编译后被完全擦除。需要值字面量时在消费侧本地声明并用
`satisfies readonly X[]` 对齐契约类型。

## 契约约定

- 描述 wire format：日期是 ISO 字符串，可省略字段用 `?:`，可为 null 用 `| null`，按 api 实际返回为准。
- 请求类型以 api 端 DTO 真实形状为准；api DTO 通过 `implements` 对齐。
- 命名：响应 `XxxResponse`，请求 `XxxRequest`。
