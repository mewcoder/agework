import type { ListResponse, PaginatedListResponse } from "../common";

export type WorkspaceRuntimeType = "local" | "sandbox";
export type WorkspaceIsolationScope = "user" | "workspace";
export type SandboxEngineType = "docker" | "opensandbox";
export type WorkspaceDirectorySource = "managed" | "external";

export type WorkspaceResponse = {
  id: string;
  name: string;
  rootPath: string;
  directoryStatus: string;
  directorySource: WorkspaceDirectorySource;
  runtimeType: WorkspaceRuntimeType;
  isolationScope?: WorkspaceIsolationScope | null;
  sandboxEngine?: SandboxEngineType | null;
  gitUrl?: string | null;
  description?: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

/** /api/v1/admin/workspaces/all 的条目。 */
export type AdminWorkspaceResponse = WorkspaceResponse & {
  userId?: string | null;
  user?: { username: string } | null;
  conversationCount?: number;
};

export type CreateWorkspaceRequest = {
  name: string;
  description?: string;
  gitUrl?: string;
  rootPath?: string;
  runtimeType?: WorkspaceRuntimeType;
  isolationScope?: WorkspaceIsolationScope;
  sandboxEngine?: SandboxEngineType;
};

export type UpdateWorkspaceRequest = {
  id: string;
  name: string;
  description?: string | null;
};

export type WorkspaceIdRequest = { id: string };

export type WorkspaceListResponse = ListResponse<WorkspaceResponse>;
export type AdminWorkspaceListResponse = PaginatedListResponse<AdminWorkspaceResponse>;

export type WorkspaceCapabilitiesResponse = {
  canSelectLocalDirectory: boolean;
  runtimeType: WorkspaceRuntimeType;
  allowedRuntimeTypes: WorkspaceRuntimeType[];
  sandboxEngine: SandboxEngineType;
  isolationScope: WorkspaceIsolationScope;
  allowedIsolationScopes: WorkspaceIsolationScope[];
};
