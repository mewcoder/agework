# 新增 ACP Agent 接入指南

预定义闭集接入:不开放用户自填命令,每个 agent 在代码内的声明表登记。本文以
opencode / pi 两个已接入 agent 为参照,列出接一个新 ACP agent 的全部触点与验证清单。
通用 ACP 适配层的设计背景见
[`../agework-generic-acp-adapter-development.md`](../agework-generic-acp-adapter-development.md)。

## 0. 前置确认(动代码之前)

1. **它会不会说 ACP?** 直接冒烟:spawn 它的 ACP 入口,走一遍
   `initialize` → `session/new`,确认 protocolVersion=1 握手成功。参考脚本模式:
   起子进程 + stdin/stdout NDJSON JSON-RPC(本仓接 opencode/pi 时的冒烟即此形态)。
2. **本体不说 ACP?找桥。** 权威数据源是官方 registry 的机器可读清单:
   <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
   (网页版 [get-started/registry](https://agentclientprotocol.com/get-started/registry))。
   每个条目带 `distribution`(npx 包名@钉死版本 + args,或平台二进制下载),
   即 spawn 所需的全部情报。本仓走 ACP 的是 opencode(原生 `opencode acp`)
   和 pi(经社区桥 `pi-acp`,ACP ⇄ `pi --mode rpc`,registry id 即 `pi-acp`)。
   桥包不要按包名猜,**必须实际握手验证**——有的 CLI 没有对应子命令,
   spawn 后会静默死锁握手。
3. **摸清三件事**(决定 profile 怎么写):
   - 自定义模型/凭证怎么注入?(env 直通配置如 `OPENCODE_CONFIG_CONTENT`?
     配置目录如 pi 的 `PI_CODING_AGENT_DIR`?)
   - 权限暴露成什么形态?(见 §3)
   - session 恢复走 `session/load` 还是 `session/resume`?(initialize 响应的
     agentCapabilities 里看)

## 1. 必改触点(逐文件)

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `packages/shared/src/common/index.ts` | `AGENT_TYPES` 加一项;`AGENT_LABELS`、`AGENT_PROTOCOLS`(标 `"acp"`)、`AGENT_SKILLS_DIR`(无 skills 约定填 `null`)、`AGENT_API_FORMAT_SUPPORT`(native + supported 格式)各加一行 |
| 2 | `packages/shared/src/cli/cli-resolver.ts` | `AGENT_CLI_SPECS` 加一行:`npmPackage`(可安装 CLI 包名)、`companionPackages`(桥包,与主包同 prefix 安装)、`extraKnownLocations`(该 agent 独有安装位置;npm 全局/homebrew/volta/scoop 等通用位置已统一探测) |
| 3 | `packages/adapters/src/acp/profiles/<agent>.profile.ts` | 新建 profile:`agentType`/`displayName`/`command`/`args` + `buildEnv`(system/custom 两种模式的 env 注入)+ 可选 `resolveLaunch`(桥接型 agent 把 resolved CLI 路径换成桥命令,见 `pi.profile.ts`) |
| 4 | `packages/adapters/src/acp/profiles/registry.ts` | `PROFILES` 注册新 profile(`isAcpAgent` / worker 分发都据此判定) |
| 5 | `packages/shared/src/protocol/channel.ts` | `RunConfig` 加 `<agent>ExecutablePath?: string` 字段 |
| 6 | `apps/runtime/src/host/run-config.ts` | cliPaths → RunConfig 的透传加一行 |
| 7 | `packages/worker/src/agent/index.ts` | `resolveCliPaths` 消费 + `acpExecutablePaths` map 加一项 |
| 8 | `apps/web/src/components/icons/agent.tsx` | 图标一行(`@lobehub/icons` 有现成的优先,如 `<Xxx.Avatar />`) |

改完 1 之后,以下**自动生效、不用碰**:DTO 校验、运行节点管理页/CLI 状态页的
四行渲染与一键安装按钮、`detectEnvConfig` 环境检测、ModelProvider 的
apiFormat→agent 矩阵、session modes 上报落库(`conversation.agentModes`)。

## 2. 权限接入(三层递进,按 agent 实际能力对号入座)

**第 0 层(零成本兜底)**:ACP 标准的 `session/request_permission` 对任何 agent
通用——agent 自己会问,审批卡片(`AcpPermissionBridge`)就自动工作。什么都不声明
时权限菜单不渲染,这是「不了解该 agent 也安全可用」的基线(pi 即此形态:官方无
权限系统,如实不渲染)。

**第 1 层(agent 有模式/档位)**:ACP 的 session modes 两种暴露形态 adapter 都已
通用支持——原生 `modes` 字段(切换走 `session/set_mode`)和 `configOptions` 里
`category: "mode"` 的下拉(切换走 `session/set_config_option`,opencode 1.17 即
此形态)。要暴露成产品档位:
- `packages/shared/src/api/agents.ts`:加 `XxxPermissionMode` 类型;
- `apps/server/src/agent/options/agent-options.ts`:声明档位(声明后前端权限菜单
  自动渲染,server 的归一化自动生效——server 不写任何 per-agent 分支);
- `apps/web/src/lib/runtime/agent-run-interceptor.ts`:档位 → forwardedProps 映射
  (模式类档位映射 `acpModeId`,配置类档位映射 `permissionMode`)。

**第 2 层(agent 有自家权限配置)**:在 profile 的 `buildEnv` 里把
`input.permissionMode` 映射成该 agent 自己的配置注入,如 opencode 的
`permission: { edit/bash/webfetch }` 经 `OPENCODE_CONFIG_CONTENT`
(见 `opencode.profile.ts` 的 `resolvePermissionConfig`)。

opencode 的三档即 1+2 组合:build/plan 走官方 session mode,「完全访问」注入
permission 全 allow。**注意实测教训**:opencode 官方默认不询问(bash 直接执行),
产品上看到的询问卡片来自显式 ask 注入——新 agent 的默认权限行为必须实测,
不要按文档想当然。

## 3. 验证清单

1. **profile 单测**:`<agent>.profile.spec.ts`——system/custom 两种模式的 env 注入、
   凭证不落盘断言(参照 `opencode.profile.spec.ts` / `pi.profile.spec.ts`)。
2. **协议冒烟(不花钱)**:真实二进制 `initialize` + `session/new`,确认握手、
   session 建立、modes/configOptions 形态与预期一致。
3. **权限冒烟(若声明了档位)**:注入 ask 类配置 → prompt 一条会触发工具的消息 →
   断言 `session/request_permission` 到达;以及模式切换请求被接受。
4. **平台全链**:运行节点管理页一键安装 → 新建会话选该 agent → 发消息 →
   流式输出/审批卡片/多轮 resume(`agentSessionId` 续接)各过一遍。
5. 惯例:`pnpm --filter @agework/adapters test` + 各端 typecheck + eslint;
   dev 环境改了 adapters 记得 `pnpm --filter @agework/runtime-host build`。

## 4. 已知坑速查

- **同名 `.ts`/`.mjs` 文件**与 ESM 动态 import 的解析陷阱(见 acp adapter 接入记录)。
- 桥接型 agent 的 CLI 检测目标是**本体**(用户视角"装没装"),spawn 目标是**桥**,
  两者经 `resolveLaunch` + env(如 `PI_ACP_PI_COMMAND`)缝合。
- 桥/本体双包必须装进**同一 npm prefix**(`companionPackages` 保证),worker 按
  兄弟文件解析。
- 有的桥会把自己的启动横幅当 `agent_message_chunk` 推进首条消息(pi-acp 的
  Skills 横幅,`quietStartup: true` 关闭)——接入后先看首条消息干不干净。
- anthropic 格式 baseUrl 带不带 `/v1` 各家惯例不同(opencode 要补,pi 不补),
  在 profile 里按该 agent 的 provider 形态处理。
