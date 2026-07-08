/**
 * 工作空间文件浏览器（worker 侧）。
 *
 * 实现已提取到 `@agework/shared/filesystem`，worker 和 server（LocalRuntime
 * builtin 直读）共用同一份安全校验 + fs 读取逻辑。此文件保留为 re-export
 * 入口，worker 内部调用方（workspace-file-command.handler.ts）不需要改。
 *
 * @see ADR-0005: builtin runtime 文件预览走 server 直读，不经 worker
 */

export {
  browse,
  listFiles,
  readFile,
  createFsTimeoutSignal,
  validateRelativePath,
  resolveWithinRoot,
  type BrowseResult,
} from "@agework/shared/filesystem";
