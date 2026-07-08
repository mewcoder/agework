/**
 * 工作空间文件预览的独立命令协议。
 *
 * 与 `CommandPayload`/`CommandResultPayload` 完全独立(见 ADR-0004):
 * - 不携带 runId——文件预览的典型场景是「worker 在线但没有活跃 run」
 * - 下行复用同一条 owner-scoped 长轮询连接,但消息类型是 `OwnerCommand` 而非 `RunChannelMessage`
 * - 上行结果经独立的 owner-scoped 端点回传,不进 `command.result`/`RunEvent`
 */

// ── 下行命令 payload ──────────────────────────────────────────────

/** 列出一层目录(根目录时 path 为空串)。 */
export type ListFilesPayload = {
  type: "list_files";
  commandId: string;
  /** 相对 workspace 根目录的路径,空串表示根目录。 */
  path: string;
};

/** 读取文件内容。 */
export type ReadFilePayload = {
  type: "read_file";
  commandId: string;
  /** 相对 workspace 根目录的路径。 */
  path: string;
};

export type WorkspaceFileCommandPayload = ListFilesPayload | ReadFilePayload;

// ── 上行结果 ──────────────────────────────────────────────────────

export type FileEntryType = "directory" | "file" | "symlink";

export type FileEntry = {
  name: string;
  type: FileEntryType;
  size?: number;
  /** symlink 的目标文本(仅 type === "symlink")。 */
  target?: string;
  /** symlink 最终指向的类型(仅 type === "symlink")。 */
  targetType?: "directory" | "file" | "unknown";
};

export type ListFilesResult = {
  type: "list_files";
  commandId: string;
  path: string;
  list: FileEntry[];
  truncated: boolean;
};

export type ReadFileResult = {
  type: "read_file";
  commandId: string;
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  truncated: boolean;
};

/** worker 校验失败 / fs 超时 / 二进制拒绝等,以错误形状回传。 */
export type WorkspaceFileCommandError = {
  type: "list_files" | "read_file";
  commandId: string;
  error: string;
};

export type WorkspaceFileCommandResult =
  | ListFilesResult
  | ReadFileResult
  | WorkspaceFileCommandError;

// ── Owner-scoped 信封(不含 runId) ─────────────────────────────────

/**
 * owner-scoped 的下行命令信封。与 `RunChannelMessage` 平行但不携带 runId——
 * 文件命令不属于任何 run,只属于一个 owner(= workspace 对应的常驻 worker)。
 */
export type OwnerCommand<T = WorkspaceFileCommandPayload> = {
  seq: number;
  payload: T;
  ts: string;
};

// nextOwnerCommand 的运行时实现内联在 protocol/index.ts 中(原因见该文件注释)。
