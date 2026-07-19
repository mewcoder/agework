# 日志系统整理实施文档（apps/server）

> 交接说明：本文是可直接执行的实施清单，按 NestJS 官方 logger 最佳实践整理 `apps/server` 的日志系统。执行者请从 **Step 0** 开始，逐步做完并跑「验证」章节。全程只动 `apps/server`，不碰 worker / web。

## 1. 背景与目标

- **触发问题**：启动/运行时 `WorkerEventService` 逐条 AG-UI 事件打 DEBUG（`worker event received` + `publish message`，每事件 2 行 ×几千 seq），终端刷屏；一旦 prod 开 debug 会导致日志膨胀。
- **根因**：dev 默认日志级别就含 `debug`；逐事件日志挂在 `debug` 档且过滤不全（`isHighFrequencyStreamingEvent` 只挡了 text chunk）。
- **已有事实**：每条原始事件其实已由 worker 侧 `TraceLogWriter` 全量落进 `<conversationId>.agui.jsonl` / `.raw.jsonl`（`apps/runtime/src/worker/logging/trace.ts`），并通过 admin「原始事件」tab（`GET /api/v1/admin/runs/raw-events/list`）可查。`agentEventTrace.enabled` 默认 `true`（`apps/server/src/config/config.service.ts` `getAgentEventTraceConfig`）。所以 console 逐事件日志是**冗余**的。
- **目标**：
  1. 清晰的五档级别（含默认 info），启动不再刷屏。
  2. 采用 Nest 11 内置 `ConsoleLogger` 配置化：prod 结构化 JSON、dev 彩色文本（**无需引入 pino/winston**）。
  3. 用自定义 logger 集中脱敏，去掉散落 14 文件的手写 `safeLogJson`。
  4. 逐事件流水日志降到最详细的 `trace` 档（默认不打）。

## 2. 关键决策（已拍板，勿再纠结）

| 项 | 决策 |
|---|---|
| 级别命名 | 五档 `error / warn / info / debug / trace`，env 变量 `AGEWORK_LOG_LEVEL`，默认 `info` |
| prod 输出 | `json: true`（结构化，喂日志平台）；dev `colors: true` 文本 |
| 日志库 | **不引外部库**，用 Nest 11 内置 `ConsoleLogger` |
| 脱敏 | 自定义 `RedactingConsoleLogger` 集中脱敏；移除调用点手写 `safeLogJson` |
| 逐事件日志 | 降到 `trace`（= Nest `verbose`）档，无 `isHighFrequencyStreamingEvent` 过滤 |
| 请求/响应日志 | **本次不新增** |

## 3. Step 0：回到干净基线

本仓库工作树可能残留一轮探索性 WIP（改了 `logging.ts`、删了 `message-payload-summary.*`、动了 `worker-event.service.ts` 等，且 `logging.spec.ts` 未同步会变红）。**先确认并丢弃这些未提交改动**，从 HEAD 干净基线开始：

```bash
git -C apps/server status --short          # 确认都是本任务相关的未提交改动
git checkout -- .                          # 丢弃工作树未提交改动，回到干净基线
```

> 若 `git status` 里有与本任务无关的改动，先与提交者确认，不要盲目 checkout。

## 4. 现状审计（基线事实）

- 33 处 `new Logger(context)` 分散在各 service —— **标准用法，保留，不改调用方式**。
- 无 `console.*` 直写。
- 级别控制：`apps/server/src/main.ts` 把 `resolveNestLogLevels()` 数组直接塞给 `NestFactory.create(..., { logger })`，**没用上 ConsoleLogger 任何配置**（无 json / timestamp / prefix）。
- 脱敏：`safeLogJson` / `redactLogValue`（`apps/server/src/common/logging.ts`）在 **14 文件、43 处**手写调用。
- 缺：`fatal` 级（Nest 11 是 6 级 `log/fatal/error/warn/debug/verbose`）、`bufferLogs`、JSON 结构化输出。

`resolveNestLogLevels` 现状（`common/logging.ts`）：
```ts
export function resolveNestLogLevels(): NestLogLevel[] {
  const raw = process.env.AGEWORK_LOG_LEVEL?.toLowerCase();
  if (raw === "debug") return ["error", "warn", "log", "debug"];
  if (raw === "warn") return ["error", "warn"];
  if (raw === "error") return ["error"];
  if (raw === "verbose") return ["error", "warn", "log", "debug", "verbose"];
  return process.env.NODE_ENV === "production"
    ? ["error", "warn", "log"]
    : ["error", "warn", "log", "debug"];   // ← dev 默认含 debug，就是刷屏根因
}
```

## 5. 实施步骤

### Step 1 — 五档级别 + fatal（`apps/server/src/common/logging.ts`）

1) 给 `NestLogLevel` 类型补 `fatal`：
```ts
export type NestLogLevel = "fatal" | "error" | "warn" | "log" | "debug" | "verbose";
```

2) 重写 `resolveNestLogLevels`（`fatal` 并入最高 severity，任何档都显示；默认 `info`，dev/prod 一致）：
```ts
/**
 * AGEWORK_LOG_LEVEL 五档语义（低→高信息量）：
 * - error：仅严重错误        → ["fatal","error"]
 * - warn ：错误 + 警告        → +["warn"]
 * - info ：一般操作信息（默认）→ +["log"]
 * - debug：详细信息           → +["debug"]
 * - trace：全部日志，含逐事件 upstream 流水（最详细）→ +["verbose"]
 * 未设置默认 info（dev/prod 一致）。`verbose` 作为 `trace` 旧别名保留。
 */
export function resolveNestLogLevels(): NestLogLevel[] {
  switch (process.env.AGEWORK_LOG_LEVEL?.toLowerCase()) {
    case "error":
      return ["fatal", "error"];
    case "warn":
      return ["fatal", "error", "warn"];
    case "debug":
      return ["fatal", "error", "warn", "log", "debug"];
    case "trace":
    case "verbose":
      return ["fatal", "error", "warn", "log", "debug", "verbose"];
    case "info":
    default:
      return ["fatal", "error", "warn", "log"];
  }
}
```

### Step 2 — 新增自定义脱敏 logger（`apps/server/src/common/redacting-console.logger.ts`）

新建文件。继承内置 `ConsoleLogger`，对 message 与全部 optionalParams 统一过 `redactLogValue`（字符串走值正则、对象按 key 脱敏），集中兜底脱敏。context（末位字符串）经脱敏后原样透传，不影响 Nest 的 context 识别。

```ts
import { ConsoleLogger } from "@nestjs/common";
import { redactLogValue } from "./logging";

/**
 * 内置 ConsoleLogger 的脱敏包装：任何经过日志的 message / 参数都统一过
 * redactLogValue，集中屏蔽 apiKey / token / cookie 等敏感字段，
 * 调用点不必再手写 safeLogJson。通过 main.ts 的 app.useLogger 全局接入后，
 * 所有 `new Logger(ctx)` 实例都会路由到这里。
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(redactLogValue(message), ...optionalParams.map((p) => redactLogValue(p)));
  }
}
```

> `redactLogValue` 已能处理字符串（→值正则脱敏）、对象（→按 key 脱敏）、数组、循环引用、bigint 等，直接复用。

### Step 3 — main.ts 接线（`apps/server/src/main.ts`）

把裸 `logger: resolveNestLogLevels()` 换成 `bufferLogs + useLogger + 配置化 ConsoleLogger`。

- create 时不再直接传 logger，改传 `bufferLogs: true`（早期启动日志先缓冲，避免丢失）。
- create 之后立刻 `app.useLogger(new RedactingConsoleLogger({...}))`，配置从第一条日志起生效并 flush 缓冲。

```ts
// import 增补
import { ConsoleLogger } from "@nestjs/common"; // 若最终只用子类可不引，见下
import { RedactingConsoleLogger } from "./common/redacting-console.logger";
// resolveNestLogLevels 已在 import 列表

async function bootstrap() {
  const isProd = process.env.NODE_ENV === "production";

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,           // ← 替换原来的 logger: resolveNestLogLevels()
  });

  app.useLogger(
    new RedactingConsoleLogger({
      logLevels: resolveNestLogLevels(),
      json: isProd,             // prod：结构化 JSON
      colors: !isProd,          // dev：彩色文本
      timestamp: true,
    })
  );

  // ...（其余中间件、pipe、filter 等保持不动）
}
```

> 说明：`new Logger("Bootstrap")` 等实例保持不变，它们会自动路由到 `useLogger` 注入的实例。`ConsoleLogger` 的 `import` 若未直接使用可删，只保留 `RedactingConsoleLogger`。

### Step 4 — 逐事件日志降到 trace（`apps/server/src/run/upstream/worker-event.service.ts`）

把原本挂在 `debug` 的两处逐事件日志改到 `verbose`（= trace 档），并**移除 `isHighFrequencyStreamingEvent` 过滤**（trace 就是要全）。payload 用精简标签，完整 payload 仍在 `.agui.jsonl`。

删除：
- `HIGH_FREQUENCY_AGUI_EVENT_TYPES` 常量、`isHighFrequencyStreamingEvent` 函数。
- `import { summarizeMessagePayload } from "./message-payload-summary";`
- 连带删除文件 `apps/server/src/run/upstream/message-payload-summary.ts` 及其 `.spec.ts`（迁移后无人再用）。

新增一个模块级精简标签函数（agui.event 取内层 `type` / `name`，run.status 取 `status`）：
```ts
/** trace 档逐事件日志用的精简标签；完整 payload 见 <conversationId>.agui.jsonl。 */
function payloadTag(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { type?: unknown; name?: unknown; status?: unknown };
  const parts = [p.type, p.name ?? p.status].filter(
    (v): v is string => typeof v === "string"
  );
  return parts.length ? parts.join(":") : undefined;
}
```

两处日志改成（去掉 `safeLogJson`，直接传结构化参数，交给 RedactingConsoleLogger 脱敏 + json/文本渲染）：

`sendEvent` 入口：
```ts
this.logger.verbose("worker event received", {
  runId,
  seq: message.seq,
  type: message.type,
  event: payloadTag(message.payload),
});
```

`publish`（seq 记账后）：
```ts
this.logger.verbose("publish message", {
  runId,
  seq,
  lastSeq: decision.lastSeq,
  type: message.type,
  event: payloadTag(message.payload),
});
```

> 保留原有 `warn` 级异常日志（`drop duplicate message`、`seq gap detected`、`skip run status after terminal`）不动——它们是排障信号。

### Step 5 — 删除 agui handler 的 forward 日志

- `apps/server/src/run/upstream/worker-agui-event.handler.ts`：删除 `shouldLogAgUiEvent` 判定 + `forward AG-UI event` 那段 `logger.debug`（`recordAgUi` 逻辑保留）。
- `apps/server/src/run-event/run-event.service.ts`：`shouldLogAgUiEvent` 方法迁移后无人调用，删除。
- `apps/server/src/run-event/run-event.service.spec.ts`：删除断言该方法的用例（"keeps AG-UI debug logging scoped to lifecycle boundaries"）。

### Step 6 — 迁移调用点，去掉手写 safeLogJson（14 文件 / 43 处）

集中脱敏（Step 2/3）落地后，调用点的 `safeLogJson` 在脱敏上已冗余。目标是把
```ts
this.logger.debug(`worker commands fetched ${safeLogJson({ workerId, count })}`);
```
改为结构化参数形式：
```ts
this.logger.debug("worker commands fetched", { workerId, count });
```

**⚠️ 迁移前置验证门（必须先做，别一把梭）**：Nest 11 `ConsoleLogger` 在 `json:true` 下对「message 之外的对象参数」渲染方式需实测确认。先只改 **1 处**，分别用 dev（文本）与 prod（`NODE_ENV=production AGEWORK_LOG_LEVEL=trace`，json）跑一次，确认：
1. 对象作为结构化字段/可读片段正常出现，不被误当成 context；
2. 含敏感字段（如构造一个 `{ apiKey: "xxx" }`）时被脱敏成 `[redacted]`。

验证通过后再批量迁移。迁移规则：
- 需要 stringify 的对象 → 作为**最后一个非字符串参数**传入（不要拼进模板字符串）。
- 末位若需显式 context，仍可传字符串 context（一般依赖 `new Logger(ClassName)` 的实例 context，无需显式传）。
- 迁移清单（`git grep -l safeLogJson -- 'apps/server/src/**/*.ts' | grep -v spec`）：
  - `agent/agent.service.ts`
  - `common/filters/http-exception.filter.ts`
  - `run-event/run-event.service.ts`
  - `run/driver/run-driver.ts`
  - `run/launch/run-launcher.ts`
  - `run/live-run/live-run.registry.ts`
  - `run/status/run-status.service.ts`
  - `run/upstream/worker-agui-event.handler.ts`
  - `run/upstream/worker-event.service.ts`
  - `worker-manager/connection/command-queue.ts`
  - `worker-manager/connection/worker-endpoint.handler.ts`
  - `worker-manager/connection/worker-liveness.sweeper.ts`
  - `worker-manager/instance/worker.provisioner.ts`
- `common/logging.ts` 自身：`safeLogJson` **保留导出**（它内部即 `redactLogValue`，且可能有非日志用途；仅移除「日志调用点」的使用）。迁移后若全仓 `git grep safeLogJson` 只剩定义处，再决定是否连定义一起删。

> 若前置验证发现 json 模式对额外参数渲染不理想：退而求其次，保留 `safeLogJson`（此时它只做 stringify，脱敏由 logger 兜底），Step 6 缩减为「不再新增手写脱敏」，不强行批量改 43 处。此为可接受的降级结果，需在 PR 里说明。

### Step 7 — 同步测试（`apps/server/src/common/logging.spec.ts`）

`resolveNestLogLevels` 的 describe 块按新五档 + fatal 重写：
```ts
it("error → fatal+error", () => {
  process.env.AGEWORK_LOG_LEVEL = "error";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error"]);
});
it("warn → +warn", () => {
  process.env.AGEWORK_LOG_LEVEL = "warn";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn"]);
});
it("info → +log", () => {
  process.env.AGEWORK_LOG_LEVEL = "info";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log"]);
});
it("debug → +debug", () => {
  process.env.AGEWORK_LOG_LEVEL = "debug";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log", "debug"]);
});
it("trace → all", () => {
  process.env.AGEWORK_LOG_LEVEL = "trace";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log", "debug", "verbose"]);
});
it("verbose alias → all", () => {
  process.env.AGEWORK_LOG_LEVEL = "verbose";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log", "debug", "verbose"]);
});
it("defaults to info regardless of NODE_ENV", () => {
  delete process.env.AGEWORK_LOG_LEVEL;
  process.env.NODE_ENV = "development";
  expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log"]);
});
```
（保留原有 env 还原的 `afterEach`。）

## 6. 验证

```bash
# 1) 类型 + lint（type-aware 规则必须过 eslint，不能只信 tsc）
pnpm --filter server typecheck
pnpm --filter server exec eslint src/common/logging.ts src/common/redacting-console.logger.ts \
  src/main.ts src/run/upstream/worker-event.service.ts \
  src/run/upstream/worker-agui-event.handler.ts src/run-event/run-event.service.ts

# 2) 单测
pnpm --filter server test -- logging.spec run-event.service.spec worker-event

# 3) 运行时实测（关键）
pnpm dev:server
#   默认（不设 AGEWORK_LOG_LEVEL）：启动无逐事件刷屏，只有 info/warn/error。
AGEWORK_LOG_LEVEL=trace pnpm dev:server
#   trace：逐事件 verbose 行重新出现（worker event received / publish message）。
NODE_ENV=production AGEWORK_LOG_LEVEL=trace pnpm dev:server
#   prod：输出为单行 JSON；构造一条含 apiKey 的日志，确认值被 [redacted]。
```

**验收标准**：
- [ ] 默认级别 = info，启动/运行无逐事件刷屏。
- [ ] `AGEWORK_LOG_LEVEL=trace` 时逐事件行可见；`debug` 时不可见。
- [ ] prod（`NODE_ENV=production`）输出结构化 JSON；dev 彩色文本。
- [ ] 敏感字段（apiKey/token/cookie 等）在任意路径下都被脱敏。
- [ ] typecheck / eslint / 相关单测全绿。

## 7. 风险与注意

- **不预先跑 E2E**（除非明确要求）。
- **`worker-endpoint.handler.spec.ts` 关于 `fileCommands` 的用例在改动前即为红**，与本任务无关，不要试图在本任务里"修好"它，也别被它误导。
- Step 6 是**唯一高风险步**（43 处调用点 + json 渲染行为需实测）；务必先过验证门，不行就走降级结果。
- 保留 `safeLogJson` / `redactLogValue` 的定义与导出；只清理"日志调用点"的手写使用。
- 全程只改 `apps/server`。worker 侧 `TraceLogWriter`、admin 原始事件接口/前端 tab 都不动——它们才是查原始事件流水的正规入口。

## 8. 交接背景：事件可观测性分层（排障用）

整理后事件日志分三层，各司其职：
1. **结构化台账（DB，永久）**：`RunEvent` 表，20 种语义事件（`run.* / message.* / tool.* / command.* / system.issue`）。admin「事件」tab / `GET /api/v1/admin/runs/events/list`。
2. **原始流水（本地 JSONL，可截断）**：worker `TraceLogWriter` 全量落 `.agui.jsonl`（AG-UI 事件）/ `.raw.jsonl`（SDK 原始事件），默认开、每文件 50MB 上限。admin「原始事件」tab / `GET /api/v1/admin/runs/raw-events/list`。
3. **控制台日志（本次整理对象）**：默认 info 只报里程碑与异常；逐事件流水仅 `trace` 档。

**排障入口优先级**：run 发生了什么 → 看「事件」tab；某条工具/消息原始内容 → 看「原始事件」tab；事件丢/乱/重复 → 看 console 的 `warn`（seq 闸门信号）。
</content>
</invoke>
