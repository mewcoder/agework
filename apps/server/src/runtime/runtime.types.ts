import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "@agework/providers";
import type {
  RuntimeEnvConfig,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";

/** builtin（本机 in-process）RuntimeHost 的固定 id。所有 runtimeType 都走这一个 Host，
 *  不再有 managed-native/managed-docker/managed-opensandbox 三行假行。 */
export const BUILTIN_HOST_ID = "builtin";

/** 是否是 builtin RuntimeHost id——固定值匹配，不用查库。 */
export function isBuiltinHostId(runtimeHostId: string): boolean {
  return runtimeHostId === BUILTIN_HOST_ID;
}

/**
 * server 与执行侧的唯一控制面边界:起/停/毁 worker 载体 + CLI 环境检测。
 * 两个实现:`LocalRuntime`(builtin,in-process)/ `RemoteRuntime`(Registered,隧道 RPC)。
 * worker 的 event/command 不走此接口——worker 出站连 Host 的 WorkerHttpServer。
 */
export interface Runtime {
  /** 建环境 + 起 worker,返回运行时实例 id。onExit 是本地专属的进程退出钩子——
   *  只有 LocalRuntime 真正接线;RemoteRuntime 忽略它,远程 worker 死活走 server
   *  心跳 fence 兜底,不经隧道回传。 */
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void
  ): Promise<{ runtimeInstanceId: string }>;
  /** owner 仍在:停 worker,保留载体。 */
  stop(ref: RuntimeInstanceRef): Promise<void> | void;
  /** owner 永久消失:删除载体。 */
  destroy(ref: RuntimeInstanceRef): Promise<void> | void;
  /** 检测本机 CLI 环境(路径/版本/认证)。
   *  LocalRuntime 直接调本地检测;RemoteRuntime 通过隧道发 detect-env RPC 给远程 manager。 */
  detectEnv(): Promise<RuntimeEnvConfig>;
  /** 列出 path 下的子目录(不含文件)。path 省略时列出该 runtime 所在机器的用户主目录。 */
  listDirectory(path?: string): Promise<{ path: string; entries: string[] }>;
  /** 在 path 下新建目录(含父级),返回新建目录的绝对路径。 */
  createDirectory(path: string): Promise<{ path: string }>;
  /** 列出 rootPath 下 relativePath 的文件列表(含文件,非纯目录)。
   *  native 直读本机硬盘;docker/opensandbox/registered 经隧道 RPC 调 runtime 进程。 */
  listFiles(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse>;
  /** 读取 rootPath 下 relativePath 的文件内容(文本或图片 base64)。 */
  readFile(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileReadResponse>;
  /** 列出 rootPath 下所有文件相对路径（git ls-files，供 `@` 文件提及）。 */
  searchFiles(rootPath: string): Promise<WorkspaceFileSearchResponse>;
  /** 列出 rootPath 下相对 HEAD 的累计变更文件(git-only、只读)。 */
  listChangedFiles(rootPath: string): Promise<WorkspaceChangedFilesResponse>;
  /** 读取 rootPath 下 relativePath 的 before(HEAD)/after(当前)对比(git)。 */
  readFileDiff(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse>;
}
