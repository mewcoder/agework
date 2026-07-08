import type { ListResponse, PaginatedListResponse } from "../common";

export type WorkspaceRuntimeType = "local" | "docker" | "opensandbox";
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
  /** 绑定的 Registered Runtime id;null = Managed(本机 in-process)。创建后不可改。 */
  runtimeId?: string | null;
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
  /** 绑定到某个已配对的 Registered Runtime;与 runtimeType 互斥
   *  (选 Runtime 即定运行方式,runtimeType 由该 Runtime 注册的类型决定,不由前端传)。 */
  runtimeId?: string;
};

export type UpdateWorkspaceRequest = {
  id: string;
  name: string;
  description?: string | null;
};

export type WorkspaceIdRequest = { id: string };

export type WorkspaceListResponse = ListResponse<WorkspaceResponse>;
export type AdminWorkspaceListResponse = PaginatedListResponse<AdminWorkspaceResponse>;

/** GET /api/v1/workspaces/git-branches/list 的响应,分支名列表。 */
export type WorkspaceGitBranchListResponse = ListResponse<string>;

export type WorkspaceCapabilitiesResponse = {
  canSelectLocalDirectory: boolean;
  runtimeType: WorkspaceRuntimeType;
  allowedRuntimeTypes: WorkspaceRuntimeType[];
  isolationScope: WorkspaceIsolationScope;
  allowedIsolationScopes: WorkspaceIsolationScope[];
};
