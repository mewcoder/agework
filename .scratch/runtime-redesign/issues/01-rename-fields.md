# 01 — 字段重命名:source builtin→managed, runtimeType local→native

- Type: task
- Status: pending
- Blocked by: (none)

## 目标

把 runtime 字段值重命名:`source: "builtin" → "managed"`、`runtimeType: "local" → "native"`。纯命名,不动逻辑。让后续 ticket 用新词。

## 依据

- design.md §2.2(字段定稿)、§2.0(术语)
- 去重:现状 `local` 一词重载(非容器化 vs 本机),非容器化改 `native`

## 范围(改这些文件)

**packages/providers**(runtimeType 值):
- `packages/providers/src/types.ts:8-12` —— `SUPPORTED_RUNTIME_TYPES` 的 `"local"` → `"native"`
- `packages/providers/src/local/` 目录 → 重命名为 `native/`(`local-runtime.provider.ts` → `native-runtime.provider.ts`,`LocalRuntimeProvider` → `NativeRuntimeProvider`)
- `packages/providers/src/registry.ts:16` —— `["local", ...]` → `["native", ...]`
- `packages/providers/src/runtime-spec.ts` —— `"local"` 判断改 `"native"`
- 对应 spec 文件

**apps/server**(source + runtimeType 值):
- `apps/server/src/runtime/runtime.types.ts:8,12` —— `BUILTIN_RUNTIME_ID_PREFIX = "builtin-"` → `"managed-"`,`builtinRuntimeId` → `managedRuntimeId`,`isBuiltinRuntimeId` → `isManagedRuntimeId`
- `apps/server/src/runtime/runtime.service.ts:54-66,442-444` —— upsert builtin 行用新 id;`builtinIsolationScopes` 里 `runtimeType === "local"` → `"native"`
- `apps/server/src/config/config.service.ts` —— `RuntimeType` 默认值/allowed 列表的 `"local"` → `"native"`
- 所有 `runtimeType === "local"` / `source === "builtin"` 判断(grep 全 repo)
- `apps/server/prisma/schema.prisma:298` —— source 默认值注释

**packages/shared**:
- API 契约类型里 `source: "builtin" | "registered"` → `"managed" | "registered"`
- `runtimeType: "local" | "docker" | "opensandbox"` → `"native" | "docker" | "opensandbox"`

**apps/web**:
- `apps/web/src/types` / `apps/web/src/store` / `apps/web/src/api` 里对应值

## 不做

- 不改逻辑(只改字符串值/类名/文件名)
- 不处理历史数据(新环境,无 builtin-local 历史行)
- 不加 location 字段(本期 source=managed 兼带本机)
- 不碰 workerId/防重 key(那是 02/03)

## 验收

1. `pnpm typecheck` 全过
2. `pnpm test:server` + `pnpm --filter @agework/providers test` 全过
3. `pnpm dev` 起来,managed-native runtime 行正确 upsert,文件预览/git diff 仍工作(native 走进程内直读,逻辑没变)
4. grep 确认 repo 内无残留 `"builtin"`(source 值)/`"local"`(runtimeType 值)——`local` 作为变量名/路径片段可保留,只改枚举值

## 依赖

无(第一个做)
