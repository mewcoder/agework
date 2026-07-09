/**
 * 跑一次 run 所需的 workspace 运行上下文（目录 + runtime 配置 + 属主用户名）。
 * 由 WorkspaceService.getRunContext 解析产出，agent 层取出后当参数喂给
 * RunService.start，run 因此不必直接读 workspace 表。
 */
export type WorkspaceRunContext = {
  workspaceId: string;
  workspaceRootPath: string;
  /** 派生自 workspace.runtime.runtimeType,恒有值(Runtime 行必然存在)。 */
  runtimeType: string;
  isolationScope: string;
  username: string;
  /** 绑定的 Runtime(managed 或 registered)id,恒有值。 */
  runtimeId: string;
  /** 绑定 Runtime 的来源:"managed" = Managed(本机 in-process),"registered" = 远程机器。 */
  runtimeSource: string;
};
