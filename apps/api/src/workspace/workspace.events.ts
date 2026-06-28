export const WORKSPACE_DELETED_EVENT = "workspace.deleted";

/**
 * Workspace 已被删除（软删）。
 * 下游（如 runtime）据此清理与该 workspace 绑定的资源；workspace 自身不感知下游。
 */
export class WorkspaceDeletedEvent {
  constructor(readonly workspaceId: string) {}
}
