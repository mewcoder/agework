import type { RuntimeCapabilities } from "../protocol/runtime-tunnel";

export type RuntimeStatus = "online" | "offline";

/** /api/v1/runtimes/list 的条目(builtin 本机内置 + Registered 部署实例)。 */
export type RuntimeResponse = {
  id: string;
  name: string;
  /** "registered"=远程机器注册, "builtin"=本机内置(全局,不可删除)。 */
  source: string;
  /** null = 全局 builtin,所有人可用;有值 = 私有 registered,只有该用户可见/可删。 */
  ownerId: string | null;
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
