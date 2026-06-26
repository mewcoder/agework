import { Logger } from "@nestjs/common";
import type { RunEventReceiver } from "./run-event-receiver";
import { resolveApiBasePath } from "../../common/path.util";
import { swallow } from "../../common/swallow";
import { EnvKey } from "../../config/env-key";

const logger = new Logger("provider-utils");

const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

/**
 * 共享心跳 watchdog：跟踪每个实体（run 或 workspace）最近一次心跳时间，
 * 超过 HEARTBEAT_TIMEOUT_MS 未收到心跳则触发 onTimeout。
 * LocalRuntimeProvider 以 runId 为 key，DockerRuntimeProvider 以 workspaceId 为 key。
 */
export class HeartbeatWatchdog {
  private readonly lastHeartbeats = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** @param key - runId（Local 模式）或 workspaceId（Docker 模式） */
  start(key: string, onTimeout: () => void): void {
    this.stop(key);
    this.lastHeartbeats.set(key, Date.now());
    const check = () => {
      const last = this.lastHeartbeats.get(key) ?? 0;
      if (Date.now() - last > HEARTBEAT_TIMEOUT_MS) {
        onTimeout();
        return; // 超时后不再调度
      }
      const timer = setTimeout(check, HEARTBEAT_CHECK_INTERVAL_MS);
      this.timers.set(key, timer);
    };
    const timer = setTimeout(check, HEARTBEAT_CHECK_INTERVAL_MS);
    this.timers.set(key, timer);
  }

  /** @param key - runId（Local 模式）或 workspaceId（Docker 模式） */
  beat(key: string): void {
    this.lastHeartbeats.set(key, Date.now());
  }

  /** @param key - runId（Local 模式）或 workspaceId（Docker 模式） */
  stop(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.lastHeartbeats.delete(key);
  }
}

/** 发布 run.status=error 终态事件（worker 异常退出 / 心跳超时），失败时静默忽略。
 *  若 run 已在终态处理中或已完成终态则跳过，避免覆盖 legitimate 的 finished/cancelled 状态。 */
export function publishWorkerErrorStatus(
  receiver: RunEventReceiver,
  runId: string,
  error: string
): Promise<void> {
  if (receiver.isTerminalOrFinalizing(runId)) {
    logger.debug(`Skipping error status for already-terminal run ${runId}`);
    return Promise.resolve();
  }
  return receiver
    .forceErrorStatus(runId, error)
    .catch(swallow(logger, `force error status for run ${runId}`));
}

/**
 * worker 容器访问宿主 API 的 base URL。
 * 默认指向 `host.docker.internal:<PORT>`，并拼上与 main.ts 一致的 API 挂载前缀
 * （`<AGEWORK_CONTEXT>/api/v1`），因为 internal runtime API 也在全局前缀之下。
 */
export function resolveDockerApiBase(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "PORT" | "AGEWORK_CONTEXT">
  > = process.env
): string {
  const port = env[EnvKey.PORT] ?? "3000";
  return `http://host.docker.internal:${port}${resolveApiBasePath(
    env[EnvKey.CONTEXT]
  )}`;
}

/**
 * 空闲 watchdog：当某个 scope 的 activeRuns 降为 0 后，
 * 等待 idleTimeoutSeconds 仍无新 run，则触发 onIdle 回调停止容器/sandbox。
 */
export class IdleWatchdog {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  start(key: string, timeoutMs: number, onIdle: () => void): void {
    this.cancel(key);
    const timer = setTimeout(onIdle, timeoutMs);
    // unref 避免空闲 timer 阻止进程退出
    timer.unref();
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

