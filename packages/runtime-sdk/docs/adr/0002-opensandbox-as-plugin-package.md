# OpenSandbox 拆为可选 RuntimeProvider 插件包

## 背景

AgeWork 面向个人与团队时，Native 和 Docker 是主要运行方式。OpenSandbox 仍可能服务于有额外
沙箱管理需求的部署，但不应让核心 provider 包长期承担其 SDK、配置和实现维护成本。

## 决定

- `@agework/runtime-sdk` 公开 `RuntimeProviderPlugin` 装配契约，Runtime Host 只内建 Native。
- Docker 与 OpenSandbox 都是独立插件；Docker 作为官方 bundled plugin 默认随发行版装配。
- OpenSandbox 实现和 `@alibaba-group/opensandbox` SDK 迁入独立包
  `@agework/runtime-opensandbox`。
- `RuntimeHost` 接收外部 plugin 列表，resolver 在初始化时完成一次性实例化，并拒绝重复类型或
  声明类型与实例类型不一致的插件。
- builtin Host 只有在 `AGEWORK_RUNTIME_ALLOWED_TYPES` 显式包含 `opensandbox` 时才动态加载插件；
  registered daemon 同样按 `--runtime` / `AGEWORK_RUNTIME_TYPES` 动态加载。默认配置均不加载它。
- builtin、registered 和自定义 Host 都使用 `RuntimeHostConfig.providerPlugins`，插件私有配置由各自
  的装配层提供，不重新塞回核心 `RuntimeConfig`。

## 结果

- 核心 provider 包不再依赖 OpenSandbox SDK。
- 插件私有连接配置留在插件包，核心只提供 worker 镜像、回连地址、日志路径等通用启动配置。
- OpenSandbox 能力仍可按需启用，但不再被视为核心 runtime 的同等维护承诺。
