export const WORKSPACE_DELETED_EVENT = "workspace.deleted";

/**
 * Workspace 已被删除（软删）。
 * 下游（如 runtime 清理 worker、run 停止该 workspace 的活跃任务）据此级联；
 * workspace 自身不感知下游(方案 B:总能删,任务被停)。
 */
export class WorkspaceDeletedEvent {
  constructor(
    readonly workspaceId: string,
    readonly userId: string,
  ) {}
}
