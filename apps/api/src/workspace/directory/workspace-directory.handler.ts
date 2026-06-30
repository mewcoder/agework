import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { spawn } from "child_process";
import { mkdirSync, realpathSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
} from "../../config/config.service";
import { WorkspaceRepository } from "../workspace.repository";
import { WorkspaceRuntimePolicy } from "../runtime/workspace-runtime.policy";

const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
export const MANAGED_DIRECTORY_SOURCE = "managed";
export const EXTERNAL_DIRECTORY_SOURCE = "external";

export type WorkspaceDirectoryCreatePlan = {
  rootPath: string;
  ownsDirectory: boolean;
  directorySource:
    | typeof MANAGED_DIRECTORY_SOURCE
    | typeof EXTERNAL_DIRECTORY_SOURCE;
};

function gitClone(gitUrl: string, rootPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--", gitUrl, rootPath], {
      stdio: "pipe",
    });
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(
        new Error(`git clone timed out after ${GIT_CLONE_TIMEOUT_MS / 1000}s`)
      );
    }, GIT_CLONE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString().trim() || `exit code ${code}`
          )
        );
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

@Injectable()
export class WorkspaceDirectoryHandler {
  private readonly logger = new Logger(WorkspaceDirectoryHandler.name);

  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly config: ConfigService,
    private readonly runtimePolicy: WorkspaceRuntimePolicy
  ) {}

  async prepareCreate(input: {
    userId: string;
    workspaceId: string;
    gitUrl?: string;
    requestedRootPath?: string;
    runtimeType: RuntimeType;
    isolationScope: IsolationScope | null;
  }): Promise<WorkspaceDirectoryCreatePlan> {
    const plan = await this.resolveCreatePlan(input);
    try {
      if (plan.ownsDirectory && input.gitUrl) {
        this.logger.log(`Cloning ${input.gitUrl} into ${plan.rootPath}`);
        await gitClone(input.gitUrl, plan.rootPath);
      } else if (plan.ownsDirectory) {
        this.logger.log(`Creating workspace directory: ${plan.rootPath}`);
        mkdirSync(plan.rootPath, { recursive: true });
      } else {
        this.logger.log(
          `Binding existing workspace directory: ${plan.rootPath}`
        );
      }
    } catch (err: unknown) {
      this.cleanupCreated(plan);
      const msg = err instanceof Error ? err.message : String(err);
      throw new InternalServerErrorException(
        input.gitUrl ? `Git clone 失败: ${msg}` : `创建目录失败: ${msg}`
      );
    }
    return plan;
  }

  cleanupCreated(
    plan: Pick<WorkspaceDirectoryCreatePlan, "rootPath" | "ownsDirectory">
  ) {
    if (!plan.ownsDirectory) return;
    rmSync(plan.rootPath, { recursive: true, force: true });
  }

  private async resolveCreatePlan(input: {
    userId: string;
    workspaceId: string;
    gitUrl?: string;
    requestedRootPath?: string;
    runtimeType: RuntimeType;
    isolationScope: IsolationScope | null;
  }): Promise<WorkspaceDirectoryCreatePlan> {
    const username = await this.resolveUsername(input.userId);
    const trimmedRootPath = input.requestedRootPath?.trim();
    if (!trimmedRootPath) {
      const rootPath =
        input.isolationScope === "workspace"
          ? join(this.config.getWorkspace(), `${username}_${input.workspaceId}`)
          : join(this.config.getUserWorkspace(username), input.workspaceId);
      return {
        rootPath,
        ownsDirectory: true,
        directorySource: MANAGED_DIRECTORY_SOURCE,
      };
    }
    if (input.gitUrl) {
      throw new BadRequestException("本地目录模式不能同时填写 Git 地址");
    }

    const rootPath = this.normalizeExistingDirectory(trimmedRootPath);
    this.assertCustomRootPathSupported(input.runtimeType, input.isolationScope);
    if (input.isolationScope === "workspace") {
      this.assertPathOutsideUserRoot(username, rootPath);
    }

    const existing = await this.repo.findDirectoryByRootPath(rootPath);
    if (existing) {
      throw new ConflictException("该目录已绑定到其他工作空间");
    }

    return {
      rootPath,
      ownsDirectory: false,
      directorySource: EXTERNAL_DIRECTORY_SOURCE,
    };
  }

  private normalizeExistingDirectory(input: string) {
    const expanded = expandHomePath(input.trim());
    if (!expanded) throw new BadRequestException("目录路径不能为空");
    if (!isAbsolute(expanded)) {
      throw new BadRequestException("目录路径必须是绝对路径");
    }

    let rootPath: string;
    let isDirectory = false;
    try {
      rootPath = realpathSync(resolve(expanded));
      isDirectory = statSync(rootPath).isDirectory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`目录不存在或不可访问: ${msg}`);
    }

    if (!isDirectory) {
      throw new BadRequestException("目录路径必须指向一个目录");
    }
    return rootPath;
  }

  private assertCustomRootPathSupported(
    runtimeType: RuntimeType,
    isolationScope: IsolationScope | null
  ) {
    if (
      this.runtimePolicy.supportsCustomRootPath(runtimeType, isolationScope)
    ) {
      return;
    }

    throw new BadRequestException(
      "沙箱工作空间指定本地目录时必须使用工作空间级隔离"
    );
  }

  private assertPathOutsideUserRoot(username: string, rootPath: string) {
    const userRoot = this.config.getUserWorkspace(username);
    const rel = relative(userRoot, rootPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new BadRequestException(
        "工作空间隔离的自定义目录不能在用户工作空间目录内"
      );
    }
  }

  private async resolveUsername(userId: string): Promise<string> {
    const username = await this.repo.findUsername(userId);
    if (!username) {
      throw new BadRequestException(`用户不存在: ${userId}`);
    }
    return username;
  }
}
