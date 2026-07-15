import type { HostUpstreamNotification } from "@agework/shared/protocol";

/**
 * host.upstream 回流 Port(架构规则 §4 决策链 5:infra 运行时回流):
 * registered Host 经隧道上行的事件/终态事实,由上层 runtime-host 模块实现、
 * 启动期由 `RuntimeHostAdapter` 向 `HostTunnelHandler` 接线。
 * 返回 Promise 时按连接串行 await,处理完成后才向 Host 回 ACK 水位。
 */
export interface HostUpstreamPort {
  onHostUpstream(
    runtimeHostId: string,
    notification: HostUpstreamNotification
  ): Promise<void> | void;
}

/**
 * RuntimeHost 表行的跨模块契约形状(workspace / run / runtime-host 经根 Service
 * 的公开方法消费)。tokenHash 永不出现在此形状里。
 */
export type RuntimeHostRow = {
  id: string;
  name: string;
  source: string;
  ownerId: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  capabilities: unknown;
  envConfig: unknown;
  envConfigOverride: unknown;
  removedAt: Date | null;
};

/** builtin（本机 in-process）RuntimeHost 的固定 id。所有 runtimeType 都走这一个 Host。 */
export const BUILTIN_HOST_ID = "builtin";

/** 是否是 builtin RuntimeHost id——固定值匹配，不用查库。 */
export function isBuiltinHostId(runtimeHostId: string): boolean {
  return runtimeHostId === BUILTIN_HOST_ID;
}

/** 同一个 Host 路由适配器按角色暴露，消费者不能越面调用。 */
export const RUNTIME_HOST_EXECUTION = Symbol("RuntimeHostExecution");
export const RUNTIME_HOST_OPERATIONS = Symbol("RuntimeHostOperations");
export const RUNTIME_HOST_DIAGNOSTICS = Symbol("RuntimeHostDiagnostics");
