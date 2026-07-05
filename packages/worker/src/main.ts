import { runRunner, runWorker } from "./worker.js";
import { errorDetails, workerLog } from "./logging/worker-log.js";

async function main() {
  const role = resolveWorkerRole(process.env);
  return role === "runner" ? runRunner() : runWorker();
}

function resolveWorkerRole(env: NodeJS.ProcessEnv): "worker" | "runner" {
  const role = env.AGEWORK_WORKER_ROLE;
  if (role === "worker" || role === "runner") return role;
  throw new Error(
    `AGEWORK_WORKER_ROLE must be "worker" or "runner", got: ${role ?? "(unset)"}`
  );
}

main().catch((err) => {
  workerLog("worker fatal error", errorDetails(err), "error");
  process.exit(1);
});
