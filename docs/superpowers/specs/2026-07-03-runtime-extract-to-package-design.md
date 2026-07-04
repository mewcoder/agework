# runtime provider 抽为 `packages/runtime` —— 设计

## 目标与依据

系统有**两个扩展点**:agent adapter(已是 `packages/adapters`)与 runtime provider(现埋在 `apps/server/src/runtime`)。把 runtime 抽成 `packages/runtime`,与 `packages/adapters` 并列——**runtime ⟷ adapter 才是真正的同级**(两个"契约 + 多实现"的插件库)。worker 是被启动的载荷(可部署单元),留 `apps/worker`,**不动**。

理由是**架构对称/边界清晰**,不是复用(runtime 目前只有 server 一个消费者)。这点明确记账:抽包换来的是编译器强制的边界 + 两个扩展点同构,代价是打包税。

> adapters 的**导出方式不作为参考**:它直接导出 `ClaudeAgentAdapter`/`CodexAgentAdapter` 具体类,是"一袋实现"。runtime 反过来——只导出工厂 + 契约,藏具体实现。

## 一、config 注入,不 import ConfigService

包内 provider = 普通类,构造时只收自己要的 config,**不认识 server 的 `ConfigService`、不读 `process.env`**。凡是现在从 server 拿的(log 目录、镜像、apiBase、openSandbox 连接参数、worker 入口路径)全部由 server 算好、当参数传入。

`RuntimeConfig`(server 要喂进来的形状):

```ts
export type RuntimeConfig = {
  workerImage: string;             // 原 DEFAULT_WORKER_IMAGE
  runtimeLogHostPath: string;      // 原 ConfigService.getRuntimeLogDir()
  containerApiBaseUrl: string;     // host.docker.internal:<PORT>/api/v1(server 算好)
  local: {
    apiBaseUrl: string;            // 127.0.0.1:<PORT>/api/v1(server 算好)
    workerEntryPath: string;       // server 侧 require.resolve("@agework/worker")
    tsxCliPath: string;            // server 侧 require.resolve("tsx/cli")
  };
  openSandbox: {
    domain: string;
    protocol: string;
    apiKey: string;
    useServerProxy: boolean;
  };
};
```

**worker 入口路径当 config 传入(决策甲)**:server 负责 `require.resolve("@agework/worker")`/`require.resolve("tsx/cli")`,把路径塞进 `cfg.local`。这样 **`packages/runtime` 不依赖 `@agework/worker`**,包保持纯叶子、无"包→app"反向依赖(与 adapters 一样是下游叶子)。

## 二、导出面(公开 API 收到最小)

```ts
// packages/runtime/src/index.ts —— 全部公开面
export { createRuntimeProviders } from "./registry";  // (cfg: RuntimeConfig) => Map<RuntimeType, RuntimeProvider>
export { resolveRuntimeTarget } from "./placement/runtime-resource";  // 纯函数
export { SUPPORTED_RUNTIME_TYPES, isRuntimeType } from "./types";
export type {
  RuntimeType,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  RuntimeConfig,
  ResolveRuntimeTargetInput,
} from "./types";
```

```ts
// types.ts —— runtime 类型的权威事实
export const SUPPORTED_RUNTIME_TYPES = ["local", "docker", "opensandbox"] as const;
export type RuntimeType = (typeof SUPPORTED_RUNTIME_TYPES)[number];
export function isRuntimeType(s: string): s is RuntimeType {
  return (SUPPORTED_RUNTIME_TYPES as readonly string[]).includes(s);
}
```

**契约字段收紧成 `RuntimeType`(决策乙)**:`RuntimeProvider.type`、`RuntimeLaunchContext.runtimeType`、`RuntimeInstanceRef.runtimeType` 全用 `RuntimeType`,不再是裸 `string`。worker-manager 从 DB 行派生 `RuntimeLaunchContext`/`RuntimeInstanceRef` 时,用 `isRuntimeType(row.runtimeType)` 在 DB 边界收窄 + 校验(非法/历史值当场暴露,不拖到 `resolveProvider` 才炸),禁止盲 `as RuntimeType`。

**不导出(internal)**:三个具体 provider 类(`LocalRuntimeProvider`/`DockerRuntimeProvider`/`OpenSandboxRuntimeProvider`)、`OpenSandboxClient`/`OpenSandboxClientLike`、`buildSandboxStartInput`、`SandboxStartInput`/`SandboxPlacement`。

关键纪律:**具体 provider 类不导出**——server 只能经 `createRuntimeProviders` 拿到 `RuntimeProvider` 接口实例,无法 import 某个具体 runtime,才是真开放/封闭(adapters 恰恰没守住这条)。

`createRuntimeProviders` 返回 `Map<RuntimeType, RuntimeProvider>`(type → 实例,config 已注入)——即"提供给 server 用的映射表"。

## 三、包结构(每实现一个文件夹)

```
packages/runtime/
├── package.json          # name @agework/runtime, exports "." → src/index.ts
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts          # 唯一出口(见上)
    ├── types.ts          # RuntimeProvider / RuntimeLaunchContext / RuntimeInstanceRef / RuntimeConfig / ResolveRuntimeTargetInput
    ├── registry.ts       # createRuntimeProviders(cfg) → Map
    ├── local/            # LocalRuntimeProvider(+spec)
    ├── docker/           # DockerRuntimeProvider(+spec)
    ├── opensandbox/      # OpenSandboxRuntimeProvider + opensandbox-client(+spec)
    ├── placement/        # resolveRuntimeTarget + 容器路径常量(CONTAINER_WORKSPACES_ROOT 等下沉进包)
    └── common/           # buildSandboxStartInput 等内部 helper
```

依赖:`@agework/shared`(protocol 类型)+ opensandbox SDK + `@nestjs/common`(仅 Logger,可选,与 adapters 同)。**不依赖 `@agework/worker`、不依赖 server。**

## 四、server 侧(薄接线,Nest + config 留这边)

- 新 `RuntimeModule`(server 内,thin):从 `ConfigService` 拼出 `RuntimeConfig`,调包工厂,provide 成 `RUNTIME_PROVIDERS`。
  ```ts
  { provide: RUNTIME_PROVIDERS,
    useFactory: (c: ConfigService) => createRuntimeProviders(toRuntimeConfig(c)),
    inject: [ConfigService] }
  ```
- `RuntimeService`(server 内**保留**):注入 `RUNTIME_PROVIDERS` 这张 Map,做 `start/stop/destroy` 分发 + `resolveRuntimeTarget` 转发 + `getRuntimePolicy`(纯 config 读取,留 server)。
- `worker-manager`:`RuntimeInstanceRef`/`RuntimeLaunchContext`/`ResolveRuntimeTargetInput` 改从 `@agework/runtime` 导入类型;仍注入 server 的 `RuntimeService`。

## 五、非目标 / 已记账的取舍

- **不动 worker**(载荷,可部署单元)。不拆 worker-core。
- **不引入 runtime 微服务**(仍进程内 launcher)。
- 单消费者 → 包边界含"仪式"成分,接受,理由是扩展点对称。
- **(已解决)supported vs allowed 单一真相**:包导出 `SUPPORTED_RUNTIME_TYPES` 作为"实现了哪些 runtime"的权威事实;server 的 `allowedRuntimeTypes`(部署开放的子集)据此校验 `allowed ⊆ SUPPORTED_RUNTIME_TYPES`,不再硬编码另一份列表。加新 runtime = 包里加一项 + 建文件夹,server 的 allowed/policy/DTO enum 自动跟着包走。

## 六、迁移步骤(大纲)

1. 建 `packages/runtime` 骨架(package.json / tsconfig / vitest / workspace 注册)。
2. 搬 provider + helper + placement 进包,去掉 `ConfigService`/`process.env`/`@agework/worker`,改为 `RuntimeConfig` 注入;`@nestjs/common` 只留 Logger。
3. 写 `types.ts`(契约)、`registry.ts`(工厂)、`index.ts`(最小出口)。
4. server:改 `RuntimeModule` 为薄接线 + `toRuntimeConfig(ConfigService)`;`RuntimeService` 改注入 Map;`worker-manager` 类型改从 `@agework/runtime` 引。
5. 测试搬进包(provider spec 改用 `RuntimeConfig` 对象,不再 mock server ConfigService);server 侧留 `RuntimeModule`/`RuntimeService` 精准测。
6. 验证:`pnpm -w typecheck`、`pnpm test:server` + 包测试、eslint 0 error、turbo 构建图无环。

## 七、验证标准

- `packages/runtime` 无 `ConfigService`/`process.env`/`@agework/worker`/server 内部 import。
- server 内无 `import { DockerRuntimeProvider }` 之类对具体实现的引用(只经工厂 + 接口)。
- typecheck / test / eslint 全绿。
