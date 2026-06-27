import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";

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
 * 空闲 watchdog：当某个 owner 的 active run 引用数降为 0 后，
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
