import type { RunStatus } from "../common";
import type { PaginatedListResponse } from "../common";
import type { RunUsage } from "../protocol";

/** /api/v1/admin/runs/list 的条目。 */
export type AdminRunResponse = {
  id: string;
  conversationId: string;
  workspaceId: string;
  userId: string;
  agentType: string;
  runtimeType: string;
  runtimeResourceId: string | null;
  status: RunStatus;
  phase: string | null;
  error: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
  username: string | null;
  conversationTitle: string | null;
  workspaceName: string | null;
  /** Token 用量。老 run 或上报失败时为 null。 */
  usage: RunUsage | null;
};

export type AdminRunListResponse = PaginatedListResponse<AdminRunResponse>;

export type AdminRunRuntimeResourceResponse = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerUserId: string;
  ownerWorkspaceId: string | null;
  runtimeResourceId: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceRuntimes: Array<{
    id: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type AdminRunDetailResponse = AdminRunResponse & {
  conversation: {
    id: string;
    title: string | null;
    activeRunStatus: string;
    pendingUserAction: string | null;
    agentSessionId: string | null;
  };
  workspace: {
    id: string;
    name: string;
  };
  user: {
    id: string;
    username: string | null;
  };
  runtimeResource: AdminRunRuntimeResourceResponse | null;
};

export type AdminRunEventResponse = {
  id: string;
  runId: string;
  seq: number | null;
  source: string;
  eventType: string;
  level: "debug" | "info" | "warn" | "error" | string;
  summary: string | null;
  payload: unknown;
  payloadRef: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type AdminRunListQuery = {
  status?: string;
  pageNo?: number;
  pageSize?: number;
};

export type AdminRunEventListQuery = {
  runId: string;
  source?: string[];
  eventType?: string;
  level?: string[];
  pageNo?: number;
  pageSize?: number;
};

export type AdminRunEventListResponse =
  PaginatedListResponse<AdminRunEventResponse>;

export type RuntimeResourceIdRequest = { id: string };

export type RuntimeResourceResponse = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerUserId: string;
  ownerWorkspaceId: string | null;
  runtimeResourceId: string;
  status: string;
  expiresAt: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  workspaceRuntimes?: Array<{
    id: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type RuntimeResourceListResponse =
  PaginatedListResponse<RuntimeResourceResponse>;
