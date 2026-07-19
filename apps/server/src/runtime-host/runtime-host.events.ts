export const RUNTIME_HOST_CONNECTED_EVENT = "runtime-host.connected";

/**
 * registered Host 隧道注册成功(事实)。
 * 上层协调器据此启动带 epoch fencing 的完整重连对账。
 */
export class RuntimeHostConnectedEvent {
  constructor(
    readonly runtimeHostId: string,
    /** 本次 tunnel session 的确定 epoch；协调器不得在事件处理时重新猜测。 */
    readonly epoch: number
  ) {}
}
