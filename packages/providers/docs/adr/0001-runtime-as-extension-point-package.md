# runtime provider 抽为 `packages/runtime` 扩展点包,config 注入、导出收到最小

系统有两个扩展点:agent adapter(`packages/adapters`)与 runtime provider。为让两个扩展点对称、边界由编译器强制,把 runtime provider 从 `apps/server/src/runtime` 抽成 `packages/runtime`(`@agework/runtime`),与 `packages/adapters` 并列。worker 是被启动的可部署载荷,留 `apps/worker` 不动。

## 决定

- **位置**:`packages/runtime`(库,不是 app)。不放 `apps/`——runtime provider 无入口、不可独立部署,`apps/` 只放可部署单元。
- **config 注入,不依赖 ConfigService**:包内 provider 是普通类,构造时收自己需要的 config 值;server 用 `ConfigService` 拼出 `RuntimeConfig` 后经工厂 `createRuntimeProviders(cfg)` 喂入。包不 import `ConfigService`、不读 `process.env`。
- **worker 入口路径当 config 传入**:server 侧 `require.resolve("@agework/worker")` / `require.resolve("tsx/cli")`,把路径塞进 `cfg.local`。**包因此不依赖 `@agework/worker`**,保持纯下游叶子(与 adapters 一致),无"包→app"反向依赖。
- **导出收到最小**:`index.ts` 只导出 `createRuntimeProviders`(工厂)、`resolveRuntimeSpec`(纯函数)、`SUPPORTED_RUNTIME_TYPES`/`isRuntimeType` 与契约类型(`RuntimeProvider`/`RuntimeLaunchContext`/`RuntimeInstanceRef`/`RuntimeConfig`/`RuntimeType`/`RuntimeSpecInput`)。**具体 provider 类、OpenSandbox client、内部 helper/契约一律不导出**——server 只经工厂拿到 `RuntimeProvider` 接口实例,无法耦合到某个具体 runtime,才是真开放/封闭。
- **runtime 类型单一真相**:`SUPPORTED_RUNTIME_TYPES` 是"实现了哪些 runtime"的权威;server 的 `allowedRuntimeTypes`(部署子集)据此校验。契约字段收紧成 `RuntimeType`;worker-manager 从 DB 行派生 ref/ctx 时用 `isRuntimeType` 在边界收窄,禁止盲 cast。

## 为什么

- **对称性**:adapter 已是 packages/ 里"契约 + 多实现"的扩展点库;runtime 照做,两个插件点同构、加新实现的位置一致。理由是架构一致性,不是复用(runtime 目前只有 server 一个消费者)。
- **adapters 的导出方式不作为参考**:它直接导出 `ClaudeAgentAdapter`/`CodexAgentAdapter` 具体类(一袋实现)。runtime 反过来藏实现、只露工厂+契约。

## Consequences

- server 侧只剩薄接线:`RuntimeModule`(`ConfigService` → `toRuntimeConfig` → `createRuntimeProviders`)+ `RuntimeService`(注入 Map 分发 + `getRuntimePolicy`)。Nest DI 机器全留在 server,包保持 Nest-agnostic(仅用 `Logger`)。
- `swallow`/`safePathPart`/`safeLogJson` 三个小工具在包内自带(不 import server `common/`)。容器路径常量(`CONTAINER_WORKSPACES_ROOT` 等)下沉进包 `placement`。
- 历史关联决策：runtime 生命周期 start/stop/destroy 见 `apps/server/src/runtime-host/docs/adr/0002`（已 superseded）。
