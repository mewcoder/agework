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
  status: RunStatus;
  phase: string | null;
  error: string | null;
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

export type AdminRunWorkerInstanceResponse = {
  id: string;
  runtimeType: string;
  scope: string;
  ownerId: string;
  runtimeInstanceId: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceBindings: Array<{
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
    runStatus: string;
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
  workerInstance: AdminRunWorkerInstanceResponse | null;
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

/** worker 侧 TraceLogWriter 写入的本地 raw/agui JSONL 流水，只读诊断用。 */
export type AdminRunRawEventChannel = "sdk.raw" | "agui.event";

export type AdminRunRawEventResponse = {
  ts: string;
  source: string;
  name: string;
  runId?: string;
  [key: string]: unknown;
};

export type AdminRunRawEventListQuery = {
  runId: string;
  channel?: AdminRunRawEventChannel[];
  pageNo?: number;
  pageSize?: number;
};

export type AdminRunRawEventListResponse =
  PaginatedListResponse<AdminRunRawEventResponse>;

export type WorkerInstanceIdRequest = { id: string };

export type WorkerInstanceStatus =
  | "starting"
  | "running"
  | "stopped"
  | "missing"
  | "error"
  | "stale";

export type WorkerInstanceDiagnosticsResponse = {
  ownerId?: string;
  workspaceId?: string;
  statusReason?: string;
  lastSeenAt?: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  errorMessage?: string;
  runtimeInstanceId?: string;
};

export type WorkerInstanceResponse = {
  id: string;
  runtimeType: string;
  scope: string;
  ownerId: string;
  runtimeInstanceId: string;
  status: WorkerInstanceStatus;
  isReusable: boolean;
  workspaceCount: number;
  expiresAt: string | null;
  metadata: unknown;
  diagnostics: WorkerInstanceDiagnosticsResponse;
  createdAt: string;
  updatedAt: string;
  workspaceBindings?: Array<{
    id: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type WorkerInstanceListResponse =
  PaginatedListResponse<WorkerInstanceResponse>;
