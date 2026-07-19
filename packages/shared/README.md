# @agework/shared

跨 Web、Server 与 Runtime 的共享契约和小型基础工具包。它既包含 TypeScript 类型，也包含
协议校验、ID、CLI 路径解析和文件系统等运行时代码，并通过 `tsc` 保留多 subpath 目录结构。

## 子路径边界

| 入口 | 内容 | 允许的消费者 |
| --- | --- | --- |
| `@agework/shared` | 三端共享字面量类型（AgentType、RunStatus） | web / api / worker / adapters |
| `@agework/shared/protocol` | api↔worker 运行时协议（JSON-RPC、RunChannelMessage、RuntimeChannel 等） | api / worker / adapters |
| `@agework/shared/api` | web↔api HTTP wire 契约（请求/响应形状） | web / api |

## 运行时边界

包根、protocol、CLI、filesystem 和 git 入口包含运行时代码；Server/Runtime 的生产构建必须
能解析对应 `dist` 产物。仅用于 wire shape 的声明继续优先使用 `export type`，避免无意义的
运行时依赖。

## 契约约定

- 描述 wire format：日期是 ISO 字符串，可省略字段用 `?:`，可为 null 用 `| null`，按 api 实际返回为准。
- 请求类型以 api 端 DTO 真实形状为准；api DTO 通过 `implements` 对齐。
- 命名：响应 `XxxResponse`，请求 `XxxRequest`。
