import { Injectable } from "@nestjs/common";
import {
  createRuntimeResolver,
  type RuntimeProvider,
  type RuntimeType,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
} from "@agework/providers";
import type { RuntimeEnvConfig } from "@agework/shared/api";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
} from "@agework/shared/api";
import type { AgentType } from "@agework/shared";
import {
  listFiles as listFilesDirect,
  readFile as readFileDirect,
  createFsTimeoutSignal,
} from "@agework/shared/filesystem";
import {
  listChangedFiles as listChangedFilesDirect,
  readFileDiff as readFileDiffDirect,
} from "@agework/shared/git";
import { ConfigService } from "../../config/config.service";
import { detectEnvConfig } from "../cli/cli-resolver";
import { installCli } from "../cli/cli-installer";
import {
  createDirectory as createDirectoryOnDisk,
  listDirectory as listDirectoryOnDisk,
} from "../filesystem/directory-browser";
import type { Runtime } from "../runtime.types";
import { toRuntimeConfig } from "./runtime-config";

/**
 * `Runtime` 接口的 Managed(in-process)实现:按 runtimeType 分发给 `@agework/providers`
 * 装配好的 provider。provider 实现全在包内,这里经 resolver 拿到 RuntimeProvider 接口
 * 实例,不认识具体 provider 类。
 */
@Injectable()
export class LocalRuntime implements Runtime {
  /** 建一次、进程内长活的 provider resolver(get/throw 收在包闭包内)。 */
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;

  constructor(configService: ConfigService) {
    this.resolveProvider = createRuntimeResolver(
      toRuntimeConfig(configService)
    );
  }

  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void
  ): Promise<{ runtimeInstanceId: string }> {
    return this.resolveProvider(ctx.runtimeType).start(ctx, onExit);
  }

  stop(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).stop(ref);
  }

  destroy(ref: RuntimeInstanceRef): Promise<void> | void {
    return this.resolveProvider(ref.runtimeType).destroy(ref);
  }

  /** builtin runtime 运行在本机进程内,直接本地检测 CLI 环境。 */
  detectEnv(): Promise<RuntimeEnvConfig> {
    return Promise.resolve(detectEnvConfig());
  }

  /** 把 agentType 对应的独立 CLI 装进本机专属目录，返回装好后的可执行文件路径。 */
  installCli(agentType: AgentType): Promise<string> {
    return installCli(agentType);
  }

  /** builtin runtime 运行在本机进程内，直接本地列目录。 */
  listDirectory(path?: string): Promise<{ path: string; entries: string[] }> {
    return Promise.resolve(listDirectoryOnDisk(path));
  }

  /** builtin runtime 运行在本机进程内，直接本地新建目录。 */
  createDirectory(path: string): Promise<{ path: string }> {
    return Promise.resolve(createDirectoryOnDisk(path));
  }

  /**
   * builtin runtime 文件预览直读(ADR-0005):workspace 目录在本机硬盘上,
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

  /** builtin runtime 文件预览直读(ADR-0005),同 listFiles。 */
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
   * builtin local runtime 变更查看:workspace 目录在本机硬盘上,直接在其上跑
   * git(shared/git),不经 worker。累计 vs HEAD、git-only、只读。
   */
  listChangedFiles(rootPath: string): Promise<WorkspaceChangedFilesResponse> {
    return listChangedFilesDirect(rootPath);
  }

  /** builtin local runtime 单文件 diff 直读,同 listChangedFiles。 */
  readFileDiff(
    rootPath: string,
    relativePath: string
  ): Promise<WorkspaceFileDiffResponse> {
    return readFileDiffDirect(rootPath, relativePath);
  }
}
