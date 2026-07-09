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
