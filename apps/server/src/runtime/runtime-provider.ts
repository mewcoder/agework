import type { RuntimePlacement } from "@agework/shared/protocol";

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env（AGEWORK_WORKER_* + startToken），provider 内部再合并自己的 infra env。 */
export type RuntimeLaunchContext = {
  runtimeType: string;
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimePlacement;
  workerEnv: Record<string, string>;
};

/** prepareEnvironment 的产物：container 返回容器 id，process 返回空。 */
export type RuntimeEnvHandle = { runtimeInstanceId?: string };

/** 停止/回收一个实例所需的最小信息，由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: string;
  ownerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/** 某一 runtimeType 的运行形态：自声明类型 + 备环境/拉 worker/拆除/回收孤儿。 */
export interface RuntimeProvider {
  readonly type: string;
  readonly placementKind: "container" | "process";
  prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle>;
  launchWorker(
    ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }>;
  teardown(ref: RuntimeInstanceRef): Promise<void> | void;
  recoverOrphan?(ref: RuntimeInstanceRef): Promise<void> | void;
}

export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
