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