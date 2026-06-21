/** 支持的 agent 类型。 */
export type AgentType = "claude" | "codex";

/** worker run 的生命周期状态。 */
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "requires_action"
  | "cancelling"
  | "finished"
  | "error"
  | "cancelled";

/** Run/Conversation 等待人工操作时标记的动作类型。 */
export type PendingAction = "question" | null;

/** 接口统一信封响应。 */
export type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};

/** 非分页列表响应。 */
export type ListResponse<T> = {
  list: T[];
  total?: number;
};

/** 分页列表响应。 */
export type PaginatedListResponse<T> = {
  list: T[];
  total: number;
  pageNo: number;
  pageSize: number;
};
