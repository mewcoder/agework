import { WorkerCommands } from "./commands.js";
import { WorkerHttpTransport } from "./transport/worker-http.js";
import { RunnerManager } from "./runner-manager.js";
import { errorDetails, workerLog } from "./logging/worker-log.js";

const COMMAND_LONG_POLL_MS = 25_000;
const COMMAND_EMPTY_RETRY_DELAY_MS = 1_000;
const SHUTDOWN_GRACE_MS = 8_000;
const REGISTER_RETRY_ATTEMPTS = 3;
const REGISTER_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export async function runWorker() {
  const client = resolveWorkerClient();
  const commands = new WorkerCommands(client, {
    waitMs: COMMAND_LONG_POLL_MS,
    emptyRetryDelayMs: COMMAND_EMPTY_RETRY_DELAY_MS,
  });
  const runnerManager = new RunnerManager(client, commands);
  workerLog("worker started", {
    workerId: process.env.AGEWORK_WORKER_ID,
  });

  // 进入命令轮询循环前先向所属 Host 注册握手,证明这个进程/容器真的活着能通信。
  // Host 在此之前不会把该 worker 判定为 ready（见 WorkerHandshakeStore）。
  // 重试用尽说明这个进程反正没法正常工作,主动退出比等 Host 侧 launchTimeout
  // 超时收敛更快。
  await registerWithRetry(client);

  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownPromise ??= shutdown(signal).catch((err) => {
      workerLog(
        "worker shutdown failed",
        {
          signal,
          ...errorDetails(err),
        },
        "error"
      );
      process.exit(1);
    });
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  await commands.run((command) => runnerManager.handle(command));

  async function shutdown(signal: NodeJS.Signals) {
    commands.stop();

    const forceExitTimer = setTimeout(() => {
      workerLog(
        "worker shutdown grace period exceeded",
        {
          signal,
          activeRunCount: runnerManager.size(),
        },
        "error"
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    await runnerManager.shutdown(signal);

    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

function resolveWorkerClient(): WorkerHttpTransport {
  return new WorkerHttpTransport();
}

export async function registerWithRetry(
  client: WorkerHttpTransport
): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < REGISTER_RETRY_ATTEMPTS; attempt++) {
    try {
      await client.register();
      workerLog("worker registered", {
        workerId: process.env.AGEWORK_WORKER_ID,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      workerLog(
        "worker register failed",
        {
          attempt: attempt + 1,
          ...errorDetails(err),
        },
        "warn"
      );
      if (attempt < REGISTER_RETRY_ATTEMPTS - 1) {
        await sleep(REGISTER_RETRY_DELAYS_MS[attempt] ?? 4_000);
      }
    }
  }
  workerLog(
    "worker register failed after retries, exiting",
    {
      attempts: REGISTER_RETRY_ATTEMPTS,
      ...errorDetails(lastError),
    },
    "error"
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
