import { runWorker } from "./worker.js";
import { errorDetails, workerLog } from "./logs/worker.js";

async function main() {
  return runWorker(resolveWorkerKeepAlive(process.env));
}

function resolveWorkerKeepAlive(env: NodeJS.ProcessEnv): boolean {
  const keepAlive = env.AGEWORK_WORKER_KEEP_ALIVE?.toLowerCase();
  if (keepAlive === "true" || keepAlive === "1") return true;
  if (keepAlive === "false" || keepAlive === "0") return false;
  throw new Error(
    `AGEWORK_WORKER_KEEP_ALIVE must be "true" or "false", got: ${keepAlive ?? "(unset)"}`
  );
}

main().catch((err) => {
  workerLog("worker fatal error", errorDetails(err), "error");
  process.exit(1);
});
