# ADR 0003: Worker 作为 Runtime 内部执行组件

## Decision

- Worker 与 per-run Runner 的源码移入 `apps/runtime/src/worker`。
- `apps/runtime/src/main.ts` 与 `apps/runtime/src/runner.ts` 继续作为两个独立 bundle entry。
- 删除私有且没有独立产物的 `@agework/worker` workspace package。
- Agent Plugin 的公共依赖边界仍是 `@agework/agent-sdk`；插件不能依赖 Runtime 内部 Worker。

## Rationale

Worker 有真实进程职责，但没有独立发布、安装或构建产物。它的唯一生产消费者是 Runtime，最终
也只存在于 Runtime 生成的 `main.js` 和 `runner.js` 中。独立 package 因而增加了 manifest、
typecheck、测试命令和文档入口，却没有提供部署隔离。

源码内收不改变 Worker/Runner 的进程边界、IPC、环境白名单或 sibling Runner 路径推导。

## Consequences

- Runtime Host 的 typecheck 与测试同时覆盖 Worker/Runner。
- Runtime manifest 直接声明 adapters、ACP、Agent SDK、Shared 和 RxJS 依赖。
- 外部 Agent Plugin 继续只面向 Agent SDK 和 Runner 动态加载协议。
- 若 Worker 未来重新获得独立部署或发行生命周期，可以从该目录反向提取 package。
