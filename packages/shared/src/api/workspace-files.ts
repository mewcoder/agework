import type { FileEntry } from "../filesystem/types";

export type WorkspaceFileListResponse = {
  path: string;
  list: FileEntry[];
  truncated: boolean;
};

export type WorkspaceFileReadResponse = {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  truncated: boolean;
};

/** GET /api/v1/workspaces/files/search 的响应。list 为相对路径数组。 */
export type WorkspaceFileSearchResponse = {
  list: string[];
  truncated: boolean;
};
