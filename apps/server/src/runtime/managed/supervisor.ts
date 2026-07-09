import { spawn, type ChildProcess } from "node:child_process";
import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { RuntimeType } from "../../config/config.service";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_RUNTIME_IMAGE } from "../../config/registry/defaults";
import { EnvKey } from "../../config/registry/env-key";
import { resolveApiBasePath } from "../../common/api-path";
import { resolveRuntimeEntry } from "../local/runtime-config";

/** 进程启动器:接收入口路径 + env,返回 ChildProcess。测试时注入 mock。 */
export type ProcessSpawner = (
  entryPath: string,
  env: Record<string, string>
) => ChildProcess;

const defaultSpawner: ProcessSpawner = (entryPath, env) => {
  return spawn("node", [entryPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

/** 单个 managed 容器 runtime 进程的跟踪状态。 */
interface ManagedProcessState {
  child: ChildProcess;
  /** 明文 token,重启时复用(不变)。 */
  token: string;
  /** 当前退避延迟(ms);0 = 尚未崩过(下次立即重启)。 */
  restartDelayMs: number;
  /** 重启定时器;非 undefined 表示正在等待重启。 */
  restartTimer?: NodeJS.Timeout;
  /** 是否已主动停止(shutdown);true 时不再重启。 */
  stopped: boolean;
}

/** 退避上限。 */
const MAX_RESTART_DELAY_MS = 30_000;
/** 首次退避值(立即重启后,第二次崩溃起的起始延迟)。 */
const BASE_RESTART_DELAY_MS = 1_000;

/**
 * Managed 容器 runtime 进程的 supervisor:为 docker/opensandbox 各 fork 一个
 * apps/runtime 进程,注入 loopback 地址 + managed token;进程崩了自动重启
 * (首次立即,后续指数退避封顶 30s)。native 不经此(supervisor 跳过)。
 *
 * design.md §5.7:server fork 时记 runtime 进程 pid,监听 exit;崩了自动重启,
 * 重启后它重新连 server(loopback 隧道)。断连不立刻判死(见 RuntimeTunnelHandler)。
 */
@Injectable()
export class ManagedRuntimeSupervisor implements OnApplicationShutdown {
  private readonly logger = new Logger(ManagedRuntimeSupervisor.name);
  private readonly processes = new Map<RuntimeType, ManagedProcessState>();
  private readonly spawner: ProcessSpawner;

  constructor(
    configService: ConfigService,
    @Optional() spawner?: ProcessSpawner
  ) {
    this.configService = configService;
    this.spawner = spawner ?? defaultSpawner;
  }

  private readonly configService: ConfigService;

  /**
   * 为指定 runtimeType fork 一个 managed runtime 进程。
   * - native 跳过(留 server 进程内)。
   * - docker/opensandbox fork apps/runtime,注入 loopback + token。
   * - 已启动则跳过(幂等)。
   */
  startManagedRuntime(runtimeType: RuntimeType, token: string): void {
    if (runtimeType === "native") return;
    if (this.processes.has(runtimeType)) {
      this.logger.warn(
        `managed ${runtimeType} runtime process already started, skipping`
      );
      return;
    }

    const state: ManagedProcessState = {
      child: undefined as unknown as ChildProcess, // 占位,下面 spawn 后赋值
      token,
      restartDelayMs: 0,
      stopped: false,
    };
    this.spawnAndAttach(runtimeType, state);
    this.processes.set(runtimeType, state);
    this.logger.log(
      `started managed ${runtimeType} runtime process (pid=${state.child.pid})`
    );
  }

  /** server 关停时,杀掉所有 managed 容器 runtime 进程,取消待重启定时器。 */
  onApplicationShutdown(): void {
    for (const [runtimeType, state] of this.processes) {
      state.stopped = true;
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = undefined;
      }
      state.child.kill("SIGTERM");
      this.logger.log(`stopped managed ${runtimeType} runtime process`);
    }
    this.processes.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────

  /** 构建 fork 进程所需的环境变量(与 RegisteredRuntimeConfig 的 env key 对齐)。 */
  private buildEnv(
    runtimeType: RuntimeType,
    token: string
  ): Record<string, string> {
    const port = process.env[EnvKey.PORT] ?? "3000";
    const apiBasePath = resolveApiBasePath(process.env[EnvKey.CONTEXT]);
    const serverBaseUrl =
      process.env[EnvKey.SERVER_BASE_URL]?.trim() ||
      `http://127.0.0.1:${port}${apiBasePath}`;

    return {
      AGEWORK_SERVER_BASE_URL: serverBaseUrl,
      AGEWORK_RUNTIME_TOKEN: token,
      AGEWORK_RUNTIME_TYPE: runtimeType,
      AGEWORK_RUNTIME_WORKER_IMAGE: DEFAULT_RUNTIME_IMAGE,
      AGEWORK_RUNTIME_LOG_DIR: this.configService.getRuntimeLogDir(),
    };
  }

  /** spawn 进程,挂载日志 + exit handler,写入 state.child。 */
  private spawnAndAttach(
    runtimeType: RuntimeType,
    state: ManagedProcessState
  ): void {
    const entryPath = resolveRuntimeEntry();
    const env = this.buildEnv(runtimeType, state.token);
    const child = this.spawner(entryPath, env);
    state.child = child;
    const tag = `managed-${runtimeType}`;

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString("utf8").trim();
      if (line) this.logger.log(`[${tag}] ${line}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString("utf8").trim();
      if (line) this.logger.warn(`[${tag}] ${line}`);
    });
    child.on("error", (err) => {
      this.logger.error(`${tag} runtime process error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (state.stopped) return;
      this.logger.warn(
        `${tag} runtime process exited (code=${code}, signal=${signal}), restarting...`
      );
      this.scheduleRestart(runtimeType, state);
    });
  }

  /** 退避策略:首次崩溃立即重启,后续指数退避(1s → 2s → 4s → … → 30s 封顶)。 */
  private scheduleRestart(
    runtimeType: RuntimeType,
    state: ManagedProcessState
  ): void {
    const delay = state.restartDelayMs;
    state.restartDelayMs = Math.min(
      state.restartDelayMs === 0
        ? BASE_RESTART_DELAY_MS
        : state.restartDelayMs * 2,
      MAX_RESTART_DELAY_MS
    );

    if (delay === 0) {
      this.logger.log(`restarting managed-${runtimeType} runtime immediately`);
      this.respawn(runtimeType, state);
    } else {
      this.logger.log(
        `restarting managed-${runtimeType} runtime in ${delay}ms`
      );
      state.restartTimer = setTimeout(() => {
        this.respawn(runtimeType, state);
      }, delay);
    }
  }

  /** 重启:用同一 token + 入口重新 spawn,挂载 handler。 */
  private respawn(
    runtimeType: RuntimeType,
    state: ManagedProcessState
  ): void {
    if (state.stopped) return;
    state.restartTimer = undefined;
    this.spawnAndAttach(runtimeType, state);
    this.logger.log(
      `restarted managed-${runtimeType} runtime process (pid=${state.child.pid})`
    );
  }
}
