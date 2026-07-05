/**
 * Registered Runtime 控制隧道协议(agework-runtime/manager ⇄ server/runtime-gateway)。
 * 出站 WS 连接,runtime 配对 token 鉴权(HTTP upgrade 时经 Authorization header 携带);
 * 与 worker↔server 的数据面(worker-http,startToken 鉴权)完全独立。
 */

/** Runtime 实例声明的能力矩阵:它那一种运行方式支持哪些隔离档。
 *  (type 而非 interface:需要隐式索引签名以直接写入 Prisma Json 列。) */
export type RuntimeCapabilities = {
  isolationScopes: string[];
};

/** manager → server:注册(隧道建连后第一条消息)。 */
export interface RuntimeTunnelRegisterMessage {
  type: "register";
  runtimeType: string;
  capabilities: RuntimeCapabilities;
}

/** manager → server:心跳。 */
export interface RuntimeTunnelHeartbeatMessage {
  type: "heartbeat";
}

export type RuntimeTunnelClientMessage =
  | RuntimeTunnelRegisterMessage
  | RuntimeTunnelHeartbeatMessage;

/** server → manager:注册成功回执,带心跳节奏。 */
export interface RuntimeTunnelRegisteredMessage {
  type: "registered";
  runtimeId: string;
  heartbeatIntervalSeconds: number;
}

export type RuntimeTunnelServerMessage = RuntimeTunnelRegisteredMessage;

/** 隧道 WS 关闭码:runtime 已被删除(撤 token),manager 收到后应退出而不是重连。 */
export const RUNTIME_TUNNEL_CLOSE_GONE = 4410;
