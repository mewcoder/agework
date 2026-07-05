import type { RuntimeCapabilities } from "../protocol/runtime-tunnel";

export type RuntimeStatus = "online" | "offline";

/** /api/v1/runtimes/list 的条目(Registered Runtime 部署实例)。 */
export type RuntimeResponse = {
  id: string;
  name: string;
  kind: string;
  /** manager 注册时上报,配对未完成时为 null。 */
  runtimeType: string | null;
  status: RuntimeStatus;
  capabilities: RuntimeCapabilities | null;
  /** ISO 8601 */
  lastHeartbeatAt: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type CreateRuntimeRequest = {
  name: string;
};

/** 创建响应:配对 token 明文只在这里出现一次,之后不可再取。 */
export type CreateRuntimeResponse = {
  runtime: RuntimeResponse;
  token: string;
};

export type RuntimeIdRequest = { id: string };
