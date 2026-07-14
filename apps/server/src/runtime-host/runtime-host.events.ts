export const RUNTIME_HOST_CONNECTED_EVENT = "runtime-host.connected";

/**
 * registered Host 隧道注册成功(事实)。
 * 下游据此做重连对账(如补发离线期间丢失的 owner 级释放)。
 */
export class RuntimeHostConnectedEvent {
  constructor(readonly runtimeHostId: string) {}
}
