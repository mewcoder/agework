import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { execFileSync, spawn } from "child_process";
import { mkdirSync, realpathSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import type { RuntimeType } from "@agework/runtime-sdk";
import type { WorkerScope } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { WorkspaceRepository } from "../workspace.repository";
import { WorkspaceRuntimePolicy } from "../placement/workspace-runtime.policy";

const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
export const MANAGED_DIRECTORY_SOURCE = "managed";
export const EXTERNAL_DIRECTORY_SOURCE = "external";
/** registered Runtime Host 上的目录:路径在远程机器,server 摸不到——不校验存在性、
 *  不 mkdir、不 git clone,原样信任写入;删除时也不 rmSync(见 §5 RuntimeFileOps 暂不实现)。 */
export const REMOTE_DIRECTORY_SOURCE = "remote";

export type WorkspaceDirectoryCreatePlan = {
  rootPath: string;
  ownsDirectory: boolean;
  directorySource:
    | typeof MANAGED_DIRECTORY_SOURCE
    | typeof EXTERNAL_DIRECTORY_SOURCE
    | typeof REMOTE_DIRECTORY_SOURCE;
  /** 绑定已有本地目录时，若该目录本身是 git 仓库，读到的当前分支；否则 undefined。 */
  detectedGitBranch?: string;
};

/** 绑定已有本地目录时探测其当前 git 分支；非 git 仓库或 detached HEAD 返回 undefined。 */
function detectGitBranch(rootPath: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: rootPath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

function gitClone(
  gitUrl: string,
  rootPath: string,
  gitBranch?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = gitBranch
      ? ["clone", "--branch", gitBranch, "--", gitUrl, rootPath]
      : ["clone", "--", gitUrl, rootPath];
    const proc = spawn("git", args, {
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
    /** 选定的 git 分支;传了就在 clone 时 checkout,不传走默认分支。 */
    gitBranch?: string;
    requestedRootPath?: string;
    runtimeType: RuntimeType;
    scope: WorkerScope;
    /** registered Host id；非空时整个方法走远程分支，不碰本机文件系统。 */
    registeredRuntimeHostId?: string | null;
  }): Promise<WorkspaceDirectoryCreatePlan> {
    if (input.registeredRuntimeHostId) {
      return this.resolveRemotePlan(input);
    }
    const plan = await this.resolveCreatePlan(input);
    try {
      if (plan.ownsDirectory && input.gitUrl) {
        this.logger.log(
          `Cloning ${input.gitUrl}${input.gitBranch ? ` (branch ${input.gitBranch})` : ""} into ${plan.rootPath}`
        );
        await gitClone(input.gitUrl, plan.rootPath, input.gitBranch);
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

  /** registered Runtime Host 分支:路径在远程机器,原样信任,不做任何本机文件系统操作。 */
  private resolveRemotePlan(input: {
    gitUrl?: string;
    requestedRootPath?: string;
  }): WorkspaceDirectoryCreatePlan {
    const trimmedRootPath = input.requestedRootPath?.trim();
    if (!trimmedRootPath) {
      throw new BadRequestException("选择运行环境时必须填写绝对路径");
    }
    if (!isAbsolute(trimmedRootPath)) {
      throw new BadRequestException("目录路径必须是绝对路径");
    }
    if (input.gitUrl) {
      throw new BadRequestException("远程运行环境不支持 Git 克隆");
    }
    this.logger.log(`Trusting remote workspace directory: ${trimmedRootPath}`);
    return {
      rootPath: trimmedRootPath,
      ownsDirectory: false,
      directorySource: REMOTE_DIRECTORY_SOURCE,
    };
  }

  private async resolveCreatePlan(input: {
    userId: string;
    workspaceId: string;
    gitUrl?: string;
    requestedRootPath?: string;
    runtimeType: RuntimeType;
    scope: WorkerScope;
  }): Promise<WorkspaceDirectoryCreatePlan> {
    const username = await this.resolveUsername(input.userId);
    const trimmedRootPath = input.requestedRootPath?.trim();
    if (!trimmedRootPath) {
      const rootPath =
        input.scope === "workspace"
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
    this.assertCustomRootPathSupported(input.runtimeType, input.scope);
    if (input.scope === "workspace") {
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
      detectedGitBranch: detectGitBranch(rootPath),
    };
  }

  private normalizeExistingDirectory(input: string) {
    const expanded = expandHomePath(input.trim());
    if (!expanded) throw new BadRequestException("目录路径不能为空");
    if (!isAbsolute(expanded)) {
      throw new BadRequestException("目录路径必须是绝对路径");
    }

    let rootPath: string;
    let directory = false;
    try {
      rootPath = realpathSync(resolve(expanded));
      directory = statSync(rootPath).isDirectory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`目录不存在或不可访问: ${msg}`);
    }

    if (!directory) {
      throw new BadRequestException("目录路径必须指向一个目录");
    }
    return rootPath;
  }

  private assertCustomRootPathSupported(
    runtimeType: RuntimeType,
    scope: WorkerScope
  ) {
    if (this.runtimePolicy.supportsCustomRootPath(runtimeType, scope)) {
      return;
    }

    throw new BadRequestException(
      "沙箱工作空间指定本地目录时必须使用工作空间范围"
    );
  }

  private assertPathOutsideUserRoot(username: string, rootPath: string) {
    const userRoot = this.config.getUserWorkspace(username);
    const rel = relative(userRoot, rootPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new BadRequestException(
        "工作空间范围的自定义目录不能在用户工作空间目录内"
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

  /**
   * 用系统文件管理器打开本机路径(仅 builtin Runtime Host 的 workspace 调用；
   * 调用方需自行确认 rootPath 确实是运行 server 进程的这台机器上的真实路径)。
   * 用 spawn + detached 而非 execFile 等退出码,因为 Windows explorer.exe 成功打开
   * 时也可能返回非 0 退出码,只要进程能 spawn 起来就视为成功。
   */
  openInFileManager(rootPath: string): Promise<void> {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    return new Promise((resolve, reject) => {
      const proc = spawn(command, [rootPath], {
        stdio: "ignore",
        detached: true,
      });
      proc.once("error", (err) => {
        reject(
          new InternalServerErrorException(`打开文件管理器失败: ${err.message}`)
        );
      });
      proc.once("spawn", () => {
        proc.unref();
        resolve();
      });
    });
  }
}
