---
name: analyze-backend-module
description: >
  Analyze a backend feature/module by tracing API routes or other entrypoints through Controller,
  Service, Repository/Prisma/data access, and cross-module dependencies, then apply the project's
  backend architecture rules to produce prioritized refactor recommendations. Use when the user
  asks "分析后端模块 xxx" or "分析模块 xxx", including variants that ask to draw ASCII
  call graphs, module interaction diagrams, 函数调用关系, rules 对照, or 重构建议 for that module.
---

# Analyze Backend Module

Produce an evidence-backed module analysis that helps the user understand call flow, module boundaries, and refactor targets. First map the real call relationships, then use the project's architecture rules to judge refactor opportunities. Default to analysis only: do not edit code unless the user explicitly asks for implementation changes.

## Ground Rules

- Answer in the user's language. If the user writes Chinese, write the report in Chinese.
- Respect local project instructions. In this repo, do not automatically build, lint, or open a browser; run type checks only when they are directly useful or requested.
- Prefer `rg`/`rg --files` to locate files and symbols, then read the relevant source. Do not infer architecture from filenames alone.
- Use exact class, method, function, DTO, provider, repository, event, queue, and Prisma model names.
- Cite important claims with clickable absolute file links and line numbers when possible.
- If a call edge cannot be proven from source, mark it as inferred or unknown instead of inventing it.
- Keep ASCII diagrams readable. Prefer width under 100 columns and split large graphs by entrypoint.
- Do the architecture-rules pass after the call graph is understood, so recommendations are grounded in actual dependencies instead of surface structure.

## Workflow

1. **Scope the module**
   - Identify the module path, likely feature directory, module file, controller(s), service(s), repository/data-access files, DTOs, tests, and related subfolders.
   - If the user gives only a domain name, search likely names and state the chosen scope.
   - For this repo, backend modules usually live under `apps/api/src`; read `.claude/rules/backend-architecture.md` when judging module-boundary or refactor issues.

2. **Inventory public entrypoints**
   - Find HTTP/RPC/worker/event entrypoints: NestJS `@Controller`, route decorators, message handlers, cron jobs, worker command handlers, subscribers, or exported public service methods.
   - Include route path, HTTP method, handler method, DTO/input shape, guard/auth/decorator hints, and response/output shape if visible.
   - Include global prefixes only if they are discoverable from source.

3. **Trace calls inward**
   - For each user-relevant entrypoint, trace:
     `entrypoint -> controller/handler -> service method(s) -> repository/data access -> database/external system`.
   - Capture branching, transactions, retries, event emission, background work, streaming, file/network IO, and important error paths.
   - When a service calls another service in the same module, show the concrete method call.
   - When a service reaches into another module, classify it as a cross-module dependency.

4. **Map module interactions**
   - Read `*.module.ts` imports/providers/controllers/exports and constructor injection.
   - Track inbound dependencies: other modules/controllers/services that call into this module.
   - Track outbound dependencies: services, repositories, Prisma, shared packages, adapters, queues, workers, event emitters, config, runtime clients, and external APIs used by this module.
   - Distinguish normal dependency injection from direct imports, event-driven communication, and shared type usage.

5. **Run the rules-backed refactor pass**
   - After the call graph and module interactions are clear, read the applicable architecture rules before giving recommendations.
   - In this repo, use `.claude/rules/backend-architecture.md` as the authority for backend refactor advice.
   - Classify each recommendation against the rules' priority model when possible: `P0` for boundary/cycle/data-access violations, `P1` for input/event/controller discipline, and `P2` for organization/naming/module-promotion guidance.
   - Look specifically for: controllers containing business logic, services with too many responsibilities, repository logic leaking into services, `PrismaService` injected into business services, Prisma calls scattered outside repositories, unclear transaction boundaries, cross-module private-service/internal/repository/DTO access, circular dependency risk, duplicated query/update flows, auth/validation scattered across layers, event misuse, and side effects hidden inside read paths.
   - Separate rules findings from general design observations. If something is a taste or maintainability suggestion rather than a rule issue, label it as such.
   - Name the exact functions/classes that create the pressure and cite the rule source plus code evidence.
   - Prefer practical refactor moves: extract cohesive service, introduce repository boundary, move DTO validation, add event boundary, split module, invert dependency, consolidate duplicate queries, isolate transaction orchestration, or keep a capability internal instead of promoting it.

## Useful Search Patterns

Use these as starting points and adapt to the framework:

```bash
rg --files apps/api/src | rg '<module-or-domain-name>'
rg -n '@(Module|Controller|Get|Post|Put|Patch|Delete|Injectable)\b|constructor\(' apps/api/src/<module>
rg -n 'PrismaService|\\.findMany\\(|\\.findUnique\\(|\\.create\\(|\\.update\\(|\\.delete\\(|\\$transaction' apps/api/src/<module>
rg -n 'EventEmitter|emit\\(|Queue|ClientProxy|CommandBus|Observable|Subject|stream|worker|dispatch' apps/api/src/<module>
rg -n '<ServiceOrRepositoryName>|<methodName>' apps/api/src packages
```

## Report Template

Use this structure unless the user asks for a different shape:

```text
模块范围
- Path: /absolute/path/to/module
- Main module: XxxModule
- Controllers: XxxController, AdminXxxController
- Services: XxxService, ...
- Repositories/Data access: XxxRepository, PrismaService.<model>, ...

接口/入口清单
| Entry | Handler | Input | Auth/Guard | Main service call |
|---|---|---|---|---|
| POST /api/v1/... | XxxController.create() | CreateXxxDto | JwtAuthGuard | XxxService.create() |

ASCII 总览
[Client/API]
    |
    v
[XxxController.method()]
    |
    v
[XxxService.method()]
    |
    +--> [XxxRepository.method()] --> [PrismaService.model.operation()]
    |
    +--> [OtherModuleService.method()]  (cross-module)

入口调用链
XxxController.create()
├─ XxxService.create()
│  ├─ XxxService.validateSomething()
│  ├─ XxxRepository.create()
│  │  └─ PrismaService.xxx.create()
│  └─ OtherService.notifySomething()  [cross-module side effect]
└─ returns XxxResponseDto

模块交互图
                 inbound
[OtherModule] --------------+
                            v
                     [TargetModule]
                     /     |      \
                    v      v       v
           [Prisma]  [WorkerHost]  [Shared Types]
                    outbound dependencies

Rules 对照重构建议
1. [P0/P1/P2 or Design] ExactClass.exactMethod(): concrete issue and why it matters.
   Rule: cite the specific backend architecture rule or say "Design observation".
   Evidence: /absolute/path/file.ts:line
   Refactor move: practical next step.
   Risk if ignored: short concrete risk.

建议执行顺序
1. First small refactor with the best risk/reward.
2. Next boundary cleanup or extraction.
3. Larger optional follow-up if needed.

未知/需要确认
- Any behavior that cannot be proven from the code read so far.
```

## Quality Bar

- The diagram should make it obvious where the request enters, where state changes happen, and where the module talks to other modules.
- The rules-backed recommendations should tell the user what to refactor first, not merely describe every file.
- Prefer fewer, accurate call chains over a huge speculative graph.
- For large modules, prioritize the user-named workflow plus the highest-fan-out entrypoints, then say what was intentionally left out.
