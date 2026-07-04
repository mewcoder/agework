// ── @agework/runtime 公开面 ──────────────────────────────────────────────
// 只导出:装配工厂 + placement 纯函数 + runtime 类型事实 + 契约类型。
// 具体 provider 类、OpenSandbox client、内部 helper / 契约一律不导出。

export { createRuntimeProviders } from "./registry";
export { resolveRuntimeSpec } from "./runtime-spec";
export { SUPPORTED_RUNTIME_TYPES, isRuntimeType } from "./types";
export type {
  RuntimeType,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  RuntimeConfig,
  RuntimeSpecInput,
} from "./types";
