import type { RunStatus } from "../common";
import type { PaginatedListResponse } from "../common";
import type {
  RunEventData,
  RunEventOrigin,
  RunEventRefs,
  RunEventTargetType,
  RunEventType,
  RunUsage,
  WorkerSnapshot,
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
  /** 该 run 当前所在 worker 的现场快照;run 已终结或 worker 已回收时为 null。 */
  worker: WorkerSnapshot | null;
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
