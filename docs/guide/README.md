# AgeWork 插件开发指南

本目录面向插件使用者和开发者，说明插件怎样安装、启用、实现和验证。架构背景与历史决策
仍放在各包的 ADR；这里不重复设计过程。

## 文档

| 文档 | 内容 |
|---|---|
| [runtime-plugin.md](runtime-plugin.md) | Runtime Plugin 的使用、Provider 开发、外部加载与 bundled 发行 |
| [agent-plugin.md](agent-plugin.md) | Agent Plugin 的使用、Driver 开发、执行侧边界与动态 manifest 目标 |
| [acp-agent.md](acp-agent.md) | 在官方 ACP 插件中增加 Profile、bridge、权限和协议验证 |

## 扩展关系

```text
runtime-host ──> runtime-sdk <── runtime plugin
worker       ──> agent-sdk   <── agent plugin
                                  └── agent-acp profiles
```

Runtime Host 拥有 Runtime Plugin 的加载和生命周期；Worker/Runner 拥有 Agent Plugin 的加载和
执行。插件包只依赖对应 SDK，不反向依赖 Host 或 Worker。

## 当前边界

- Runtime Plugin 已具备完整的外部 type 加载能力。
- Agent Plugin 已完成执行侧动态加载。
- 新 Agent 的产品 catalog 尚未由插件 manifest 动态生成；这属于核心待完善能力，不要求插件
  开发者修改 shared、server、web 的闭集作为正式接入步骤。
