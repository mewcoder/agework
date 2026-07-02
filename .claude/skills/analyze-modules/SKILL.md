---
name: analyze-modules
description: >
  分析后端全部 feature module 之间的依赖/调用/事件关系,生成一个 HTML 报告:
  上半是 mermaid 关系图(只画箭头,正向蓝实线、反向 Port 红实线、事件紫虚线,每条边带序号),
  下半是按序号逐条解释的调用关系明细(A→B 调用了什么函数、干什么;B→A 反向回流了什么)。
  当用户输入 "/analyze-modules" 或 "分析模块关系"、"画模块依赖图"、"模块调用关系" 时使用。
  固定分析 apps/server 全部 feature module,不接受范围参数。只读分析,不改代码。
---

# Analyze Modules

分析 `apps/server` 后端**全部** feature module 之间的依赖与调用关系,输出一个自包含 HTML:mermaid 关系图 + 按序号的调用明细。只读,不改代码。**固定全量,不接受范围参数**;无论用户是否给模块名,都扫 `apps/server/src` 下所有 `*.module.ts`。

## Ground Rules

- 中文输出(规则、报告都用中文)。
- 关系分类**严格按项目架构规则**判定,先读 `.claude/rules/backend-architecture.md`(尤其 §4 依赖与反向依赖、§5 Event、Port 纪律),以当前文件为准,不凭记忆。规则会演进。
- 三种边的语义,不要混:
  - **正向依赖**(蓝实线 `-->`):A `imports` B 且 A 的根 Service 注入了 B 导出的根 Service;或 A 正向调 B 的根 Service。编译依赖方向 A→B。
  - **反向回流**(红实线 `-->`,红色):**仅指 Port**。下层 A 在公开 `*.types.ts` 定义 `XxxPort`,上层 B 实现 Port 并启动期 `setXxxPort(...)` 接线,运行时下层 A 回调上层 B。**事件不是反向依赖**,不要把事件标红。
  - **事件**(紫虚线 `-.->`):`EventEmitter2.emit()/emitAsync()` 发布 + `@OnEvent()` 订阅,跨模块通知,过去式语义。箭头从发布者指向订阅者(通知流向)。
- 每条边必须有证据(`file:line` 可点击),指向具体的注入处 / 调用处 / emit 处 / handler 处。推断的标"推断",无证据的不画。
- 同两个模块间可有多条边,各自独立编号;反向回流和事件也算独立边。
- 编号在图与明细表里**一一对应**,顺序一致。
- 不 build / lint / 开浏览器;只读代码取证。

## Workflow

1. **读规则** — 先读 `.claude/rules/backend-architecture.md` §4 / §5 / Port 纪律,把"正向 / 反向 Port / 事件"的判定装进脑子,不凭记忆。

2. **定范围** — 固定全量。扫 `apps/server/src` 下所有 `*.module.ts`,**必须覆盖全部 feature module,不得遗漏**(漏模块是本 skill 最常见的失败)。先列出纳入分析的模块清单。用户若给模块名也忽略,始终全量;图过密时靠页面筛选复选框收窄,不在生成阶段裁剪。

3. **跑分析脚本取证(首要)**
   - 先跑 `node .claude/skills/analyze-modules/analyze.mjs`,它会机械扫描全部模块,输出结构化 JSON:`modules`(每个模块 imports/exports/根 Service)、`forwardEdges`(跨模块正向调用,每条带 `callerClass`/`callee`/`file:line`)、`portEdges`(Port 定义/接线/回调)、`eventEdges`(emit↔@OnEvent 配对)。
   - **以脚本输出为骨架**,不要凭记忆推断模块关系。脚本保证不漏模块、每条边有 `file:line` 证据。
   - 脚本是正则提取,会有噪音 / 漏判,需要人工核对:
     - `forwardEdges` 里同模块内或 `config`(`@Global`)的注入要按规则判定是否算边(`config` 是基础领域,正向依赖但通常不画进图,只在明细里说明,避免噪音)。
     - `portEdges` 里 `definedIn.module === wiredIn.module`(同模块 Port)不是跨模块边,丢弃。
     - 重复的接线调用(如 `setSandboxWorkerEventPort` 在多处)合并成一条;只保留有业务语义的调用。
     - 脚本抓不到的语义(调用干什么)由 LLM 读对应源码补一句话说明。
   - 补脚本漏掉的边:脚本只扫 `this.<field>.<method>(` 形式的直接调用,对于通过参数喂入 / 间接调用 / 同文件函数调用的跨模块关系,需要 `grep` 补证(见 Useful Search Patterns)。

4. **编号 + 分类** — 把所有跨模块边汇总,按"模块出现顺序 + 类型"稳定编号(1,2,3…),记录每条边:序号、from→to、类型(正向/反向/事件)、调用点(逐条,见下方"调用点逐行"要求)、证据 `file:line`。图里序号与明细表序号一一对应。

5. **生成 HTML** — 读内置 `template.html`,只替换 `{{SCOPE}}` / `{{MODULES}}` / `{{MERMAID}}` / `{{ROWS}}` 四个占位符(规则见下方 HTML Template),落盘到**项目根目录 `reports/` 下**(目录不存在则创建),**文件名固定 `module.relations.html`**(每次覆盖)。`{{SCOPE}}` 固定填 `backend`。同时在对话里给一句话摘要 + 文件链接。

### 调用点树形(强制)

明细卡的调用点**用树形,不许合并成一段话**。同一调用方调多个方法时,调用方为父节点、多个被调方法为子节点挂下面;每条必须说清三件事:

1. **谁**:`.caller-name` 写调用方类名 + 方法名,如 `AgentService.run()`。
2. **调了谁的什么**:`.callee` 写被调方类名 + 方法名,如 `RunService.start()`。
3. **干啥**:`.what` 一句话用途。

结构见下方「`{{ROWS}}` 卡片模板」。反向(Port)、事件边的 `caller-name`/`callee` 写法见卡片模板说明。

## Useful Search Patterns

脚本(`analyze.mjs`)已覆盖大部分提取,以下仅用于核对 / 补漏:

```bash
# 模块清单(核对脚本未漏)
rg --files apps/server/src -g '*.module.ts'

# 正向:根 Service 注入了哪些别 module 的 Service
rg -n 'constructor\(' apps/server/src/<module>/<module>.service.ts
rg -n 'this\.[A-Za-z]+Service\.[A-Za-z]+\(' apps/server/src/<module>   # 调用了对方什么方法

# 反向 Port:接口定义 + 接线
rg -n 'export interface \w*Port\b' apps/server/src
rg -n 'set[A-Z][A-Za-z]*Port\(' apps/server/src

# 事件:emit + handler 配对
rg -n '@OnEvent\(' apps/server/src
rg -n '\.emit(Async)?\(' apps/server/src
```

## HTML Template

**风格由内置模板固定,不要自由发挥样式。** 生成时**先读** `.claude/skills/analyze-modules/template.html`,只替换以下占位符,其余结构(样式、图例、筛选 UI、表头、script)原样保留:

| 占位符 | 替换为 |
|---|---|
| `{{SCOPE}}` | 报告范围名(标题用),固定 `backend` |
| `{{PROJECT_ROOT}}` | **项目根绝对路径,正斜杠**,如 `e:/2026-new/agework`(即当前工作目录,用正斜杠)。用于 JS 拼接 `vscode://file/` 链接,必须填对,否则点击跳转会路径错误 |
| `{{MODULES}}` | 分析范围说明文本,列出纳入的模块,如 `agent / auth / conversation / ...` |
| `{{MODULES_CHECKBOX}}` | 模块筛选复选框 HTML,每个出现过的模块一个,见下方约定 |
| `{{MERMAID}}` | mermaid `graph LR` 块内容(节点声明 + 边 + `linkStyle` 行);会同时渲染到图区和隐藏的 `#mermaid-src` 供筛选重画 |
| `{{ROWS}}` | 明细卡片 HTML,按序号顺序,每条边一个 `.edge-card`,**必须带 `data-from`/`data-to`** |

### `{{MODULES_CHECKBOX}}` 约定

每个出现过的模块一个复选框,**`value` 必须等于 mermaid 节点 label 的模块名**(与 `data-from`/`data-to` 一致),否则筛选失效:

```html
<label><input type="checkbox" class="mf" value="runtime" checked> runtime</label>
<label><input type="checkbox" class="mf" value="run" checked> run</label>
```

默认全部 `checked`。

### `{{MERMAID}}` 语法约定

**节点 id 不能含连字符**(mermaid 语法限制),故约定:节点 id = 模块名去掉连字符,`[label]` 写原模块名(含连字符)。每个出现的模块**先声明再用**。例:`model-provider` 模块 → `modelprovider[model-provider]`。不要用 `CONV`/`WS` 这类与模块名无关的缩写。

边只画箭头,序号写在线上 label:

- 正向:`agent -->|1| run`
- 反向(Port,实线):`runtime -->|2| run`
- 事件(虚线):`workspace -.->|3| runtime`

块末尾按**边出现顺序**(`0` 起)追加 `linkStyle`:

- 正向:`linkStyle <i> stroke:#3b82f6`
- 反向:`linkStyle <i> stroke:#ef4444`
- 事件:`linkStyle <i> stroke:#7c3aed,stroke-dasharray:5`

示例:

```text
graph LR
  agent[agent]
  run[run]
  runtime[runtime]
  workspace[workspace]
  agent -->|1| run
  run -->|2| runtime
  workspace -.->|3| runtime
  runtime -->|4| run
  linkStyle 0 stroke:#3b82f6
  linkStyle 1 stroke:#3b82f6
  linkStyle 2 stroke:#7c3aed,stroke-dasharray:5
  linkStyle 3 stroke:#ef4444
```

注意:`data-from`/`data-to` 和复选框 `value` 用**原模块名**(含连字符),与 mermaid 节点 label 一致;模板 JS 会自动建立「节点 id ↔ 模块名(label)」映射做筛选。

### `{{ROWS}}` 卡片模板

明细**不用表格**,每条边一个 `.edge-card`(筛选依据 `data-from`/`data-to`,必须填模块全名,与 mermaid 节点 id 一致)。调用点用**树形**:同一调用方(`caller`)为父节点,它调用的多个被调方(`callee`)为子节点挂下面;只有一个调用时也用同样结构,保持一致。

```html
<div class="edge-card" data-from="agent" data-to="run">
  <div class="head">
    <span class="num">1</span>
    <span class="dir">agent → run</span>
    <span class="tag fwd">正向</span>
  </div>
  <div class="calls">
    <div class="caller">
      <div class="caller-name"><a class="ev" data-file="apps/server/src/agent/agent.service.ts" data-line="149">AgentService.run()</a></div>
      <div class="callee"><a class="ev" data-file="apps/server/src/agent/agent.service.ts" data-line="152">RunService.start()</a><span class="what">:启动一次 run 并接 SSE</span></div>
    </div>
    <div class="caller">
      <div class="caller-name"><a class="ev" data-file="apps/server/src/agent/agent.service.ts" data-line="197">AgentService.stop()</a></div>
      <div class="callee"><a class="ev" data-file="apps/server/src/agent/agent.service.ts" data-line="200">RunService.stop()</a><span class="what">:停止会话的活跃 run</span></div>
    </div>
  </div>
</div>
```

- 类型标签三种:`<span class="tag fwd">正向</span>` / `<span class="tag rev">反向</span>` / `<span class="tag evt">事件</span>`。
- 调用点树形:**每个调用方法一个 `.caller`**,`.caller-name` 写调用方**类+具体方法名**(如 `AgentService.createConversation()`,不能只写类名 `AgentService`),`.callee` 是被调方方法+一句话用途。同一调用方法调多个被调方法时,多个 `.callee` 挂在同一个 `.caller` 下。脚本 `forwardEdges.calls` 每条已带 `callerClass` + `callerMethod`(由 `analyze.mjs` 反查 enclosing method 得到),直接用 `callerClass.callerMethod()` 作为 caller-name,按 `callerClass.callerMethod` 分组。
- **函数名直接做成可点击跳转**:每个 `.caller-name` 和 `.callee` 的函数名用 `<a class="ev" data-file="相对项目根路径" data-line="行号">函数名</a>` 包裹(`.callee` 里函数名后紧跟 `<span class="what">`)。`data-file` 写相对项目根路径(如 `apps/server/src/agent/agent.service.ts`),`data-line` 是**该调用语句所在行号**(脚本 `forwardEdges` 的 `file:line`)。模板 JS 读取 `<meta name="project-root">` 里的项目根绝对路径,拼接成 `vscode://file/<项目根>/<相对路径>:<行号>`,点击即在 VSCode 打开并定位到该行。**不要手写 `.evidence` 行**——JS 会自动在每个 `.edge-card` 底部汇总该边所有 `a.ev` 的**文件路径**(去重,仅文件名不带行号)作为证据行展示。
- 反向(Port)边:只一个 caller,`caller-name` 写 `runtime(SandboxWorkerExecutor).<method>()`,`callee` 写 `回调 SandboxWorkerEventPort.notifyWorkerError()/notifyCancelledBeforeReady()`,`.what` 补决策链说明;同样把函数名包成 `a.ev`,`data-line` 用 Port 回调调用处行号。
- 事件边:`caller-name` 写 `WorkspaceService.emit(EVENT)`(或具体发布方法),`callee` 写 `runtime.RuntimeInstanceLifecycleListener.<handler>()`,`.what` 补用途;`caller-name` 的 `a.ev` 指向 `emit` 处行号,`callee` 的 `a.ev` 指向 `@OnEvent` handler 处行号。
- 反向(Port)边:只一个 caller,`caller-name` 写 `runtime(SandboxWorkerExecutor)`,`callee` 写 `回调 SandboxWorkerEventPort.notifyWorkerError(),由 run 实现`,`.what` 补决策链说明;同样把函数名包成 `a.ev`,`data-line` 用 Port 接线(`setXxxPort`)或回调调用处行号。
- 事件边:`caller-name` 写 `WorkspaceService.emit(EVENT)`,`callee` 写 `runtime.RuntimeInstanceLifecycleListener.@OnEvent(EVENT)`,`.what` 补用途;`caller-name` 的 `a.ev` 指向 `emit` 处行号,`callee` 的 `a.ev` 指向 `@OnEvent` handler 处行号。

## Quality Bar

- 三种边分类准确:只有 Port 算反向(红);事件一律虚线紫、不染红;正向是编译期 imports + 注入。这是最容易错的地方,逐条复核。
- 每条边可追溯到 `file:line` 调用/emit/handler 处,不泛泛而谈"A 依赖 B"。
- 图里序号与明细表序号一一对应、顺序一致;`linkStyle` 索引与边出现顺序对齐。
- 同模块内的事件/调用不画;只画跨模块关系。
- 不臆测隐式关系(如"可能通过共享状态通信");没有证据的边不画,缺证据的标"推断"。
- 范围过大时主动收窄,保证图可读;不要堆出一张几十条边不可读的图。
