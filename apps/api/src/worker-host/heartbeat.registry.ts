import { Injectable } from "@nestjs/common";

/**
 * runtime 实例心跳的接收端：worker 经 HTTP 上报心跳后，需要喂给拥有
 * runtime 实例生命周期的一方（runtime 层）。由 runtime 在启动时注册实现，
 * 从而保持 worker-host → runtime 零依赖。
 */
export interface RuntimeInstanceHeartbeatReceiver {
  heartbeatRuntimeInstance(ownerId: string): void;
}

/**
 * worker-host 持有的心跳转发注册表。worker 控制器经此转发心跳，
 * 具体接收方由 run 在 onModuleInit 时通过 setReceiver 注入。
 */
@Injectable()
export class WorkerHeartbeatRegistry {
  private receiver?: RuntimeInstanceHeartbeatReceiver;

  setReceiver(receiver: RuntimeInstanceHeartbeatReceiver): void {
    this.receiver = receiver;
  }

  heartbeatRuntimeInstance(ownerId: string): void {
    this.receiver?.heartbeatRuntimeInstance(ownerId);
  }
}
