/**
 * 文件系统相关类型定义 - 纯类型,无运行时依赖,可被任何环境导入。
 */

export type FileEntryType = "directory" | "file" | "symlink";

export type FileEntry = {
  name: string;
  type: FileEntryType;
  size?: number;
  /** symlink 的目标文本(仅 type === "symlink"). */
  target?: string;
  /** symlink 最终指向的类型(仅 type === "symlink"). */
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

export type WorkspaceFileCommandError = {
  type: "list_files" | "read_file";
  commandId: string;
  error: string;
};

export type BrowseResult =
  | { ok: true; result: ListFilesResult | ReadFileResult }
  | { ok: false; error: WorkspaceFileCommandError };

// ── git 变更条目(生产者是 git.ts,放这里保持纯类型可被浏览器环境导入) ──

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