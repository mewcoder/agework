# CLI 检测属于 Runtime Host 执行面，server 领域层不直接探测 OS

CLI 检测需要访问执行机的文件系统、用户目录并运行 `--version`。这些都是 Runtime Host 能力，不能放进
server 的领域编排，也不应进入只承载跨包协议与纯工具的 `@agework/shared`。

决定：检测实现放在 `apps/runtime`，由 `RuntimeHostEnvironment.detectEnv` 统一暴露。builtin Host 通过
进程内 `RuntimeHost` 实例执行；registered Host 通过控制隧道执行。`RuntimeHostService` 只调用环境端口、
持久化检测结果并向 API 返回状态，不直接 `spawn` 或读取执行机路径。

Worker 启动时仍可按运行时环境解析最终 CLI 路径，但这属于 run 执行兜底，不替代 Host 的能力检测与
admin 展示数据。

## Consequences

- builtin 与 registered Host 共享同一个环境契约，没有 server 本机检测特例。
- `envConfig` 的生产者始终是目标 Host；server 只保存和合并 admin override。
- OS 级检测依赖不会泄漏到 server 领域层或 shared 协议包。
