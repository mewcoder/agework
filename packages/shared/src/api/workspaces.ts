import type { ListResponse, PaginatedListResponse } from "../common";

export type WorkspaceRuntimeType = "native" | "docker" | "opensandbox";
export type WorkspaceIsolationScope = "user" | "workspace";
export type WorkspaceDirectorySource = "managed" | "external" | "remote";

export type WorkspaceResponse = {
  id: string;
  name: string;
  rootPath: string;
  directoryStatus: string;
  directorySource: WorkspaceDirectorySource;
  runtimeType: WorkspaceRuntimeType;
  isolationScope?: WorkspaceIsolationScope | null;
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
  isolationScope?: WorkspaceIsolationScope;
  /** 绑定到某个已配对的 Registered Runtime Host；runtimeType 选择其一种能力。 */
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
  runtimeType: WorkspaceRuntimeType;
  allowedRuntimeTypes: WorkspaceRuntimeType[];
  isolationScope: WorkspaceIsolationScope;
  allowedIsolationScopes: WorkspaceIsolationScope[];
};

// ── 变更查看(diff,只读,只支持本地 runtime) ──

export type WorkspaceChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed";

/** 一个变更文件条目。additions/deletions 为 null 表示未跟踪或二进制(无 numstat)。 */
export type ChangedFileEntry = {
  path: string;
  status: WorkspaceChangeStatus;
  additions: number | null;
  deletions: number | null;
  /** rename 时的原路径。 */
  oldPath?: string;
};

/** GET /api/v1/workspaces/files/changes 的响应。 */
export type WorkspaceChangedFilesResponse = {
  list: ChangedFileEntry[];
  truncated: boolean;
};

/** GET /api/v1/workspaces/files/diff 的响应。before/after 为 null 表示新增/删除侧不存在。 */
export type WorkspaceFileDiffResponse = {
  path: string;
  status: WorkspaceChangeStatus;
  before: string | null;
  after: string | null;
};
