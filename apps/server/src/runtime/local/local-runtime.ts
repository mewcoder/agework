import { Injectable } from "@nestjs/common";
import {
  createRuntimeResolver,
  type RuntimeProvider,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
} from "@agework/providers";
import type {
  RuntimeEnvConfig,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";
import type { AgentType } from "@agework/shared";
import {
  listFiles as listFilesDirect,
  readFile as readFileDirect,
  searchFiles as searchFilesDirect,
  createFsTimeoutSignal,
} from "@agework/shared/filesystem";
import {
  listChangedFiles as listChangedFilesDirect,
  readFileDiff as readFileDiffDirect,
} from "@agework/shared/git";
import { ConfigService } from "../../config/config.service";
import { detectEnvConfig } from "@agework/shared/cli";
import { installCli } from "../cli/cli-installer";
import {
  createDirectory as createDirectoryOnDisk,
  listDirectory as listDirectoryOnDisk,
} from "../filesystem/directory-browser";
import type { Runtime } from "../runtime.types";
import { toRuntimeConfig } from "./runtime-config";

/**
 * `Runtime` 接口的 Managed native(in-process)实现:只服务 managed native runtime,
 * fork 本机 worker 子进程 + 直读本机 fs/git。docker/opensandbox/registered 走
 * `RemoteRuntime`(隧道 RPC),不经此类的 provider 分发。
 *
 * 职责收窄(ADR-0005 精确化):原先经 `resolveProvider` 能分发到 docker/opensandbox
 * provider,现只保留 native provider——docker/opensandbox 的能力已迁到各自 runtime 进程。
 */
@Injectable()
export class LocalRuntime implements Runtime {
  /** native provider,进程内长活。LocalRuntime 只服务 managed native。 */
  private readonly nativeProvider: RuntimeProvider;

  constructor(configService: ConfigService) {
    const resolver = createRuntimeResolver(toRuntimeConfig(configService));
    this.nativeProvider = resolver("native");
  }

  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void
  ): Promise<{ runtimeInstanceId: string }> {
    return this.nativeProvider.start(ctx, onExit);
  }

  stop(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.nativeProvider.stop(ref);
  }

  destroy(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.nativeProvider.destroy(ref);
  }

  /** managed native runtime 运行在本机进程内,直接本地检测 CLI 环境。 */
  detectEnv(): Promise<RuntimeEnvConfig> {
    return Promise.resolve(detectEnvConfig());
  }

  /** 把 agentType 对应的独立 CLI 装进本机专属目录，返回装好后的可执行文件路径。 */
  installCli(agentType: AgentType): Promise<string> {
    return installCli(agentType);
  }

  /** managed native runtime 运行在本机进程内，直接本地列目录。 */
  listDirectory(path?: string): Promise<{ path: string; entries: string[] }> {
    return Promise.resolve(listDirectoryOnDisk(path));
  }

  /** managed native runtime 运行在本机进程内，直接本地新建目录。 */
  createDirectory(path: string): Promise<{ path: string }> {
    return Promise.resolve(createDirectoryOnDisk(path));
  }

  /**
   * managed native runtime 文件预览直读(ADR-0005):workspace 目录在本机硬盘上,
   * 直接调 shared/fileBrowser 读取,不经 worker 代理。安全校验(路径越界、
   * symlink 逃逸、二进制探测、大小截断)复用与 worker 相同的 shared 实现。
   */
  async listFiles(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileListResponse> {
    const signal = createFsTimeoutSignal();
    const result = await listFilesDirect(rootPath, relativePath, signal);
    return {
      path: result.path,
      list: result.list,
      truncated: result.truncated,
    };
  }

  /** managed native runtime 文件预览直读(ADR-0005),同 listFiles。 */
  async readFile(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileReadResponse> {
    const signal = createFsTimeoutSignal();
    const result = await readFileDirect(rootPath, relativePath, signal);
    return {
      path: result.path,
      encoding: result.encoding,
      content: result.content,
      size: result.size,
      truncated: result.truncated,
    };
  }

  /**
   * managed native runtime 变更查看:workspace 目录在本机硬盘上,直接在其上跑
   * git(shared/git),不经 worker。累计 vs HEAD、git-only、只读。
   */
  listChangedFiles(rootPath: string): Promise<WorkspaceChangedFilesResponse> {
    return listChangedFilesDirect(rootPath);
  }

  /** managed native runtime 文件搜索(git ls-files，供 `@` 文件提及)。 */
  searchFiles(rootPath: string): Promise<WorkspaceFileSearchResponse> {
    return searchFilesDirect(rootPath);
  }

  /** managed native runtime 单文件 diff 直读,同 listChangedFiles。 */
  readFileDiff(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse> {
    return readFileDiffDirect(rootPath, relativePath);
  }
}
