import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "@agework/providers";
import type { RuntimeEnvConfig } from "@agework/shared/api";
import type { RuntimeType } from "../config/config.service";

const BUILTIN_RUNTIME_ID_PREFIX = "builtin-";

/** builtin（本机 in-process）Runtime 的固定 id：`builtin-${runtimeType}`。
 *  这些行在服务启动时 upsert，id 恒定，不用查库反查 source 就能判断。 */
export function builtinRuntimeId(runtimeType: RuntimeType): string {
  return `${BUILTIN_RUNTIME_ID_PREFIX}${runtimeType}`;
}

/** 是否是 builtin Runtime id——固定前缀匹配，不用查库；替代原先 `runtimeId === null`
 *  判断 Managed 的方式（见 runtime 模块 ADR-0001）。 */
export function isBuiltinRuntimeId(runtimeId: string): boolean {
  return runtimeId.startsWith(BUILTIN_RUNTIME_ID_PREFIX);
}

/**
 * server 与执行侧的唯一控制面边界:起/停/毁 worker 载体 + CLI 环境检测。
 * 两个实现:`LocalRuntime`(Managed,in-process)/ `RemoteRuntime`(Registered,隧道 RPC)。
 * worker 的 event/command 不走此接口——worker 出站直连 server 事件端点(worker-manager 数据面)。
 */
export interface Runtime {
  /** 建环境 + 起 worker,返回运行时实例 id。onExit 是本地专属的进程退出钩子——
   *  只有 LocalRuntime 真正接线;RemoteRuntime 忽略它,远程 worker 死活走 server
   *  心跳 fence 兜底,不经隧道回传。 */
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void
  ): Promise<{ runtimeInstanceId: string }>;
  /** owner 仍在:停 worker,保留载体。 */
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  /** owner 永久消失:删除载体。 */
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
  /** 检测本机 CLI 环境(路径/版本/认证)。
   *  LocalRuntime 直接调本地检测;RemoteRuntime 通过隧道发 detect-env RPC 给远程 manager。 */
  detectEnv(): Promise<RuntimeEnvConfig>;
}
