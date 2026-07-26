import type {
  CreateDirectoryInput,
  DirectoryListing,
  HostCapabilityStatus,
  InstallCliInput,
  InstallCliResult,
  ListChangedFilesInput,
  ListDirectoryInput,
  ReadFileDiffInput,
  ReadFileInput,
  SearchFilesInput,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileQuery,
  WorkspaceFileReadResponse,
  WorkspaceFileSearchResponse,
} from "@agework/shared/protocol";
import {
  detectEnvConfig,
  installCli as installCliOnDisk,
} from "@agework/shared/cli";
import {
  createFsTimeoutSignal,
  listFiles,
  readFile,
  searchFiles,
} from "@agework/shared/filesystem";
import {
  createDirectory,
  listDirectory,
} from "@agework/shared/filesystem/directory-browser";
import { listChangedFiles, readFileDiff } from "@agework/shared/git";

/** Host 本机环境与 CLI 能力。 */
export class HostEnvironmentOperations {
  /** 读 Host 的当前能力矩阵(矩阵可动态刷新,不持有快照)。 */
  private readonly getCapabilities: () => HostCapabilityStatus;
  private readonly cliInstallDir: string;

  constructor(
    getCapabilities: () => HostCapabilityStatus,
    cliInstallDir: string
  ) {
    this.getCapabilities = getCapabilities;
    this.cliInstallDir = cliInstallDir;
  }

  detectEnv(): HostCapabilityStatus {
    const envConfig = detectEnvConfig();
    return Object.fromEntries(
      Object.entries(this.getCapabilities()).map(([runtimeType, status]) => [
        runtimeType,
        {
          ...status,
          ...(runtimeType === "native" && status.available
            ? { cli: envConfig }
            : {}),
        },
      ])
    );
  }

  async installCli(input: InstallCliInput): Promise<InstallCliResult> {
    const executablePath = await installCliOnDisk(
      input.agentType,
      this.cliInstallDir
    );
    return { executablePath };
  }
}

/** Host 上 workspace 文件与 Git 数据面操作。 */
export class HostWorkspaceOperations {
  listDirectory(input: ListDirectoryInput): DirectoryListing {
    const result = listDirectory(input.path);
    return { path: result.path, entries: result.entries };
  }

  createDirectory(input: CreateDirectoryInput): void {
    createDirectory(input.path);
  }

  async listFiles(
    input: WorkspaceFileQuery
  ): Promise<WorkspaceFileListResponse> {
    const result = await listFiles(
      input.rootPath,
      input.path,
      createFsTimeoutSignal()
    );
    return {
      path: result.path,
      list: result.list,
      truncated: result.truncated,
    };
  }

  async readFile(input: ReadFileInput): Promise<WorkspaceFileReadResponse> {
    const result = await readFile(
      input.rootPath,
      input.path,
      createFsTimeoutSignal()
    );
    return {
      path: result.path,
      encoding: result.encoding,
      content: result.content,
      size: result.size,
      truncated: result.truncated,
    };
  }

  async readFileDiff(
    input: ReadFileDiffInput
  ): Promise<WorkspaceFileDiffResponse> {
    return readFileDiff(input.rootPath, input.path);
  }

  async searchFiles(
    input: SearchFilesInput
  ): Promise<WorkspaceFileSearchResponse> {
    const result = await searchFiles(input.rootPath);
    return { list: result.list, truncated: result.truncated };
  }

  async listChangedFiles(
    input: ListChangedFilesInput
  ): Promise<WorkspaceChangedFilesResponse> {
    return listChangedFiles(input.rootPath);
  }
}
