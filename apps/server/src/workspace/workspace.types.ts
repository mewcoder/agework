/**
 * 跑一次 run 所需的 workspace 运行上下文（目录 + runtime 配置 + 属主用户名）。
 * 由 WorkspaceService.getRunContext 解析产出，agent 层取出后当参数喂给
 * RunService.start，run 因此不必直接读 workspace 表。
 */
export type WorkspaceRunContext = {
  workspaceId: string;
  workspaceRootPath: string;
  runtimeType?: string;
  isolationScope?: string | null;
  username: string;
  /** 绑定的 Registered Runtime id;null/undefined = Managed(本机 in-process)。 */
  runtimeId?: string | null;
};
