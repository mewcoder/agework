import type { RunStatus } from "../common";
import type { PaginatedListResponse } from "../common";
import type {
  RunEventData,
  RunEventOrigin,
  RunEventRefs,
  RunEventTargetType,
  RunEventType,
  RunUsage,
} from "../protocol";

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
  runSeq: number;
  eventKey: string | null;
  type: RunEventType;
  origin: RunEventOrigin;
  targetType: RunEventTargetType | null;
  targetId: string | null;
  chainId: string | null;
  refs: RunEventRefs | null;
  summary: string | null;
  data: RunEventData | null;
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
  type?: RunEventType[];
  typePrefix?: string;
  origin?: RunEventOrigin[];
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refKey?: keyof RunEventRefs | string;
  refValue?: string;
  fromRunSeq?: number;
  toRunSeq?: number;
  pageNo?: number;
  pageSize?: number;
};

export type AdminRunEventListResponse =
  PaginatedListResponse<AdminRunEventResponse>;

export type RuntimeResourceIdRequest = { id: string };

export type RuntimeResourceStatus =
  | "starting"
  | "running"
  | "stopped"
  | "missing"
  | "error"
  | "stale";

export type RuntimeResourceDiagnosticsResponse = {
  resourceKey?: string;
  workspaceId?: string;
  statusReason?: string;
  lastSeenAt?: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  errorMessage?: string;
  runtimeResourceId?: string;
};

export type RuntimeResourceResponse = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerUserId: string;
  ownerWorkspaceId: string | null;
  resourceKey: string;
  runtimeResourceId: string;
  status: RuntimeResourceStatus;
  isReusable: boolean;
  workspaceCount: number;
  expiresAt: string | null;
  metadata: unknown;
  diagnostics: RuntimeResourceDiagnosticsResponse;
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
