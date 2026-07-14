// 文件操作响应形状定义在契约层（Host 是生产者），此处 re-export 供 REST 消费方使用。
export type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "../protocol/runtime-host";
