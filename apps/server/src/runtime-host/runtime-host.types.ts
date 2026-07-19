import type {
  HostUpstreamNotification,
  ReleaseRuntimeResourcesInput,
  RuntimeHostResourceLifecycle,
  RuntimeHostResourceReconciliation,
  RuntimeLifecycleClaim,
} from "@agework/shared/protocol";

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

/** run 判死回流的触发场景:
 *  - reincarnation:registered Host 换了进程实例(processInstanceId 变化);
 *  - shutdown:registered Host daemon 收到关机信号,优雅关停通告到达。
 *  两者都意味着旧进程的 run 会话/未 ACK 缓冲已随进程消失,active run 无从续传。 */
export type HostReapReason = "reincarnation" | "shutdown";

/**
 * Host 终态回流 Port(架构 §4 决策链 5:infra 运行时回流):registered Host 发生
 * 终态生命周期事件(进程更替 / 优雅关停)时,旧进程上的 active run 已无续传可能
 * (会话/未 ACK 缓冲随旧进程消失),由上层 run 模块确定性收尾——判死 + 释放执行机
 * 侧 run 状态。隧道网关在放行新连接 / 处理关停通告时同步 await 本端口。builtin
 * 无隧道、与 server 同生死,不经此路径。
 */
export interface HostRunReapPort {
  reapActiveRuns(runtimeHostId: string, reason: HostReapReason): Promise<void>;
}

/** run 模块启动期把 HostRunReapPort 实现接线给 Host 隧道网关的通道
 *  (与 RuntimeHostUpstreamBinding 同构:下层定义、上层实现、启动期自接线)。 */
export interface HostRunReapBinding {
  setRunReapPort(port: HostRunReapPort): void;
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

/** Workspace/User 删除与 Host 重连对账使用的资源生命周期端口(替代旧 OwnerReconciliation)。 */
export type RuntimeHostResourceLifecyclePort = RuntimeHostResourceLifecycle;

/** Server 重连对账使用的资源 reconciliation 端口。 */
export type RuntimeHostResourceReconciliationPort =
  RuntimeHostResourceReconciliation & {
    /** runtimeHostId 省略时聚合所有在线 Host；指定时只查询目标 Host。 */
    listLifecycleClaims(
      runtimeHostId?: string
    ): Promise<RuntimeLifecycleClaim[]>;
    /** 列出所有当前在线的 Host id(含 builtin)。 */
    listConnectedHostIds(): string[];
  };

/** Run 恢复对账只需要 Host 上仍被占用的 runId，不向业务模块暴露 Worker 快照。 */
export interface RuntimeHostRunReconciliation {
  listRunIds(runtimeHostId: string): Promise<string[]>;
}

/** Server 侧查询 Host 控制面是否可达；builtin 永远可达，registered 取决于隧道。 */
export interface RuntimeHostConnectivity {
  isConnected(runtimeHostId: string): boolean;
}

/** builtin（本机 in-process）RuntimeHost 的固定 id。所有 runtimeType 都走这一个 Host。 */
export const BUILTIN_HOST_ID = "builtin";

/** 是否是 builtin Runtime Host id——固定值匹配，不用查库。 */
export function isBuiltinHostId(runtimeHostId: string): boolean {
  return runtimeHostId === BUILTIN_HOST_ID;
}

/** 同一个 Host 路由适配器按角色暴露，消费者不能越面调用。 */
export const RUNTIME_HOST_EXECUTION = Symbol("RuntimeHostExecution");
export const RUNTIME_HOST_UPSTREAM_BINDING = Symbol(
  "RuntimeHostUpstreamBinding"
);
export const RUNTIME_HOST_CONNECTIVITY = Symbol("RuntimeHostConnectivity");
export const RUNTIME_HOST_ENVIRONMENT = Symbol("RuntimeHostEnvironment");
export const RUNTIME_HOST_WORKSPACE_DATA = Symbol("RuntimeHostWorkspaceData");
export const RUNTIME_HOST_DIAGNOSTICS = Symbol("RuntimeHostDiagnostics");
export const RUNTIME_HOST_RESOURCE_RECONCILIATION = Symbol(
  "RuntimeHostResourceReconciliation"
);
export const RUNTIME_HOST_RUN_RECONCILIATION = Symbol(
  "RuntimeHostRunReconciliation"
);
export const RUNTIME_HOST_RUN_REAP_BINDING = Symbol(
  "RuntimeHostRunReapBinding"
);
