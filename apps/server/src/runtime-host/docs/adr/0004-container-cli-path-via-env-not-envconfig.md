# Container CLI 路径不经 envConfig 传播，直接 env 注入

native 和 container 两类 runtimeType 的 CLI 路径传播链路不同。native：Runtime Host 检测
envConfig → DB → RunConfig → worker env。container：Host 在宿主机检测到的路径在容器里不一定存在。

最初考虑三种方案：A. 容器镜像预装 CLI + worker 内自己 resolve；B. 宿主机 CLI binary 挂载进容器；
C. envConfig 对 container 无意义，只对 native 传播。

决定：方案 C 的变体。container 镜像里 CLI 装在固定位置（镜像构建时已知），路径通过 env 直接
注入 worker（`AGEWORK_CLAUDE_CLI_PATH` 等），不经 envConfig → RunConfig 传播链路。RunLauncher
仅对 native 类型从 envConfig 提取路径写 RunConfig。worker 侧 `resolveCliPaths` 读 env 优先，
`which`/`where` 兜底——container 靠 env 注入，native 靠 RunConfig 传播的 env。

## Consequences

- RunLauncher 的 envConfig → RunConfig 路径提取逻辑只在 `runtimeType === "native"` 时启用，container 不走。
- container 镜像负责把 CLI 装进固定路径并通过 worker env 传入，这是镜像构建的职责。
- envConfig 对 container runtimeType 仍有展示价值（admin 能看到 Host 上检测到了什么），只是不参与 run 启动链路。
