/**
 * 跑一次 run 所需的 workspace 运行上下文（目录 + runtime 配置 + 属主用户名 +
 * 用户生命周期版本）。由 WorkspaceService.getRunContext 解析产出，agent 层取出后
 * 当参数喂给 RunService.start，run 因此不必直接读 workspace 表。
 */
export type WorkspaceRunContext = {
  workspaceId: string;
  workspaceRootPath: string;
  /** 派生自 workspace.runtimeHost,恒有值(RuntimeHost 行必然存在)。 */
  runtimeType: string;
  scope: string;
  username: string;
  /** 绑定的 RuntimeHost(builtin 或 registered)id,恒有值。 */
  runtimeHostId: string;
  /** 绑定 RuntimeHost 的来源:"builtin" = 本机 in-process,"registered" = 远程机器。 */
  runtimeSource: string;
  /** 属主用户 id(placement 业务事实)。 */
  userId: string;
  /** DB User.sessionVersion;可逆 user 生命周期的 execution generation。 */
  userLifecycleVersion: number;
};
