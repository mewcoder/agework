# ADR-0001: Codex First-class 后端从 SDK 迁移到 app-server

日期:2026-07-12
状态:已实施(Ticket 01-05 完成,08 默认切换完成;SDK 回退保留,待稳定后单独 PR 删除)

## 背景

Codex 接入原走 `@openai/codex-sdk`。核实其 `dist/index.d.ts` 全部公开面:`Codex` 只有 `startThread/resumeThread`,`Thread` 只有 `run/runStreamed`,`ThreadEvent` 纯出站,审批只有开 turn 前设死的静态枚举 `approvalPolicy`。**SDK 是单向的,没有任何把请求送回一个进行中 turn 的方法**。因此今天 Codex 只能"按策略自动批",无法"让用户中途批/拒命令与改文件"——而 Claude 已经能(`pendingActionSink`+`canUseTool`+terminal interrupt)。产品体验因此割裂:选 Claude 有中途审批,选 Codex 只能设而不问。

`codex app-server` 是官方双向 JSON-RPC 协议(VS Code 扩展同款),server 能反向发 request 并阻塞等 response。审批、`turn/steer`、`tool/requestUserInput`、MCP elicitation 全部派生自这一个"双向"结构。

## 决策

1. Codex First-class 后端迁到 `codex app-server`(newline-delimited JSON over stdio 子进程),assistant-ui/AG-UI 链路不变——app-server 只投影为 AG-UI 事件,不进 Server 控制面、不暴露浏览器。
2. **第一版一个 Codex Runner 一个 app-server 子进程**。与现有 runner 隔离模型一致(等同 Claude `query()` 每 run spawn `claude`),Worker 级共享 app-server 明确留作未来 ADR。
3. **版本源真相 = 锁 Managed + 握手 gate + capability 降级**:`@openai/codex-sdk` 精确锁定 Managed runtime 的 codex 版本(当前 0.144.1),构建/类型检查按该版本自动生成被忽略的 TypeScript schema,避免提交约 600 个派生文件;`initialize` 记录运行期 `codexVersion`,与生成版本不一致时已知兼容按 capability 降级、不兼容 `RUN_ERROR(version_mismatch)`;Registered/用户自带 codex 为 **best-effort,不阻塞**。理由:app-server 与 generate-ts 均 `[experimental]`,而运行期二进制由 runtime 环境提供、可能漂移,不能只靠"构建期锁一个版本"假设运行期一致。
4. 旧 SDK adapter 保留为回退(factory + `AGEWORK_CODEX_BACKEND=sdk|app-server` env 切换),app-server 为默认 backend。SDK 删除留待稳定后单独 PR。
5. backend 选择经 `packages/adapters/src/codex/factory.ts`,上层 worker/runner 不知具体 backend。

## 取舍与代价

- 收益高度集中在**审批平级**(Codex 用户级命令/文件审批),其余(plan/diff/usage 富通知、原生 interrupt/steer)是增量顺带品。做到审批可用(Ticket 05)即达成核心价值。
- 成本:一整套 JSON-RPC client + 子进程生命周期 + 事件转换 + **跨包 resume 契约泛化**(见 server run ADR resume 泛化),外加**永久税**——每次 codex 升级都要 regen schema + diff + 契约测试,且押在 experimental 协议上。
- 迁移期双份 adapter 维护,直到后续稳定后单独 PR 删 SDK。

## 何时重评 Worker 级共享 app-server

app-server 冷启动明显影响体验、需跨 Run 保留后台终端、同 Worker 多 Codex Run 并发成高频、需统一 Thread 订阅时。届时单独设计 AppServerSupervisor + Unix socket + 多 Thread 路由 + 崩溃隔离,不在本次实现。

## 关联

- 执行文档:`docs/agework-codex-app-server-migration.md`;协议源真相:`docs/codex-app-server.md`。
- resume 契约泛化:`apps/server/src/run/docs/adr/0002-resume-payload-generalization.md`。
- 承接问答 terminal model:`apps/server/src/run/docs/adr/0001-question-interrupt-terminal-model.md`。
