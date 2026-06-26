import { Injectable } from "@nestjs/common";

/**
 * runtime 实例心跳的接收端（sink）：worker 经 HTTP 上报心跳后，需要喂给拥有
 * runtime 实例生命周期的一方（runtime 层）。由 runtime 在启动时注册实现，
 * 从而保持 worker-host → runtime 零依赖。
 */
export interface RuntimeInstanceHeartbeatSink {
  heartbeatRuntimeInstance(ownerId: string): void;
}

/**
 * worker-host 持有的心跳转发注册表。worker 控制器经此转发心跳，
 * 具体落点由 runtime 在 onModuleInit 时通过 setSink 注入。
 */
@Injectable()
export class RuntimeHeartbeatRegistry {
  private sink?: RuntimeInstanceHeartbeatSink;

  setSink(sink: RuntimeInstanceHeartbeatSink): void {
    this.sink = sink;
  }

  heartbeatRuntimeInstance(ownerId: string): void {
    this.sink?.heartbeatRuntimeInstance(ownerId);
  }
}
