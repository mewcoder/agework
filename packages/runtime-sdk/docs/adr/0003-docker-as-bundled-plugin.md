# ADR 0003: Docker 作为 bundled Runtime Plugin

## Decision

- Runtime Host 只内建 `native`，不再 import Docker provider 或探测逻辑。
- Docker 实现、健康探测和 manifest 位于 `@agework/runtime-docker`。
- builtin 与 registered 两种发行入口默认装配 Docker 插件，所以个人用户体验不变。
- Docker 与第三方 provider 使用同一个 `RuntimeProviderPlugin` registry。

## Rationale

Docker 是默认能力，但默认能力不等于宿主内建能力。独立包让 Sandbox 成为真正扩展点，
同时为 Podman、Firecracker、Kubernetes 等实现提供可运行的官方示例。

`bundled` 表示发行版默认携带和注册；`builtin` 表示实现代码属于 Host。Docker 属于前者，
Native 属于后者。
