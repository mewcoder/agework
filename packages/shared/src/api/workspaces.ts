import type { ListResponse, PaginatedListResponse } from "../common";
import type { WorkerScope } from "../protocol/channel";

/** Runtime plugin 声明的开放标识；可选项由 Host capabilities 动态提供。 */
export type WorkspaceRuntimeType = string;
export type WorkspaceScope = WorkerScope;
export type WorkspaceDirectorySource = "managed" | "external" | "remote";

export type WorkspaceResponse = {
  id: string;
  name: string;
  rootPath: string;
  directoryStatus: string;
  directorySource: WorkspaceDirectorySource;
  runtimeType: WorkspaceRuntimeType;
  scope: WorkspaceScope;
  gitUrl?: string | null;
  /** 创建时选定的 git 分支;非 git / 未选时为 null。创建后只读。 */
  gitBranch?: string | null;
  description?: string | null;
  /** 绑定的 Runtime Host id（builtin 或 registered）。创建后不可改。 */
  runtimeHostId: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

/** /api/v1/admin/workspaces/list 的条目。 */
export type AdminWorkspaceResponse = WorkspaceResponse & {
  userId?: string | null;
  user?: { username: string } | null;
  conversationCount?: number;
};

export type CreateWorkspaceRequest = {
  name: string;
  description?: string;
  gitUrl?: string;
  /** 选定的 git 分支;不传则 clone 默认分支。 */
  gitBranch?: string;
  rootPath?: string;
  runtimeType?: WorkspaceRuntimeType;
  scope?: WorkspaceScope;
  /** 绑定到某个已配对的 registered Runtime Host；runtimeType 选择其一种能力。 */
  runtimeHostId?: string;
};

export type UpdateWorkspaceRequest = {
  id: string;
  name: string;
  description?: string | null;
};

export type WorkspaceIdRequest = { id: string };

export type WorkspaceListResponse = ListResponse<WorkspaceResponse>;
export type AdminWorkspaceListResponse =
  PaginatedListResponse<AdminWorkspaceResponse>;

/** GET /api/v1/workspaces/git-branches/list 的响应,分支名列表。 */
export type WorkspaceGitBranchListResponse = ListResponse<string>;

export type WorkspaceCapabilitiesResponse = {
  canSelectLocalDirectory: boolean;
  defaultRuntimeType: WorkspaceRuntimeType;
  allowedRuntimeTypes: WorkspaceRuntimeType[];
  defaultScope: WorkspaceScope;
  allowedScopes: WorkspaceScope[];
};

// ── 变更查看(diff,只读,只支持本地 runtime) ──
//
// 变更条目定义在 filesystem/types（纯类型层）、响应形状定义在契约层，此处 re-export 供 REST 消费方使用。

export type {
  WorkspaceChangeStatus,
  ChangedFileEntry,
} from "../filesystem/types";
export type {
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "../protocol/runtime-host";
